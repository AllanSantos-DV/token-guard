#!/usr/bin/env node
'use strict';
/**
 * bench/daemon-bench.cjs — prova numérica das ACs 1-3 de
 * docs/REQUEST-daemon-unico.md ("Critérios de aceite"): latência isolada
 * mediana ≤5ms (AC1), burst de 60 req simultâneos com mediana <50ms e
 * p95 ≤150ms (AC2), pico de RAM ≤70MB (AC3 — recalibrado em F6: o piso do
 * runtime Node sozinho nesta plataforma já custa ~48MB, ver REQUEST §3).
 * Sobe o daemon REAL (mesmo subprocess de produção, via
 * `realSpawn`/`DEFAULT_DAEMON_SERVER_PATH` de lib/daemon-client.cjs) num
 * endpoint efêmero — não um mock — porque o número que importa é o do
 * processo que roda em produção, não de uma simulação in-process.
 *
 *   node bench/daemon-bench.cjs           — gate completo, asserts duros, exit(1) na 1ª AC furada
 *   node bench/daemon-bench.cjs --smoke   — variante leve (N=5, sem burst) p/ CI genérico: só
 *                                            detecta regressão grosseira (>2× baseline versionada)
 */

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { encodeFrame, parseStream } = require('../lib/ipc-frame.cjs');
const { realSpawn, DEFAULT_DAEMON_SERVER_PATH } = require('../lib/daemon-client.cjs');
const { CASES, cleanup } = require('../test/fixtures/cases.cjs');

const SMOKE = process.argv.includes('--smoke');
const ROOT = path.join(__dirname, '..');
const NODE_MAJOR = process.version.match(/^v(\d+)/)[1];
const BASELINE_PATH = path.join(__dirname, `baseline-${process.platform}-node${NODE_MAJOR}.json`);

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * s.length) - 1);
  return s[idx];
}
function median(arr) { return percentile(arr, 50); }

function tmpEndpoint() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bench-daemon-'));
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\token-guard-bench-${process.pid}-${Math.random().toString(36).slice(2)}`
    : path.join(base, 'bench.sock');
}

/** RSS do PID em MB, assíncrono (`execFile`, não `execFileSync`). ACHADO
 * (F6, sessão de diagnóstico): a primeira versão usava `execFileSync`
 * chamado por um `setInterval` DURANTE o burst — spawn síncrono de
 * subprocesso bloqueia o event loop do próprio cliente que está processando
 * as respostas concorrentes do burst, inflando a latência medida em ~10-20×
 * (confirmado isolando: sem o amostrador síncrono, mediana de burst caiu de
 * ~550ms pra ~28ms). Best-effort: qualquer falha (processo já morto, comando
 * ausente) resolve null — quem chama trata como amostra perdida, não erro. */
function rssMB(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }, (err, out) => {
        if (err) return resolve(null);
        // separador de milhar varia com a locale do Windows (vírgula em
        // en-US, ponto em pt-BR) — remove ambos, sobra só os dígitos em KB.
        const m = out.match(/"([\d.,]+) K"/);
        resolve(m ? parseInt(m[1].replace(/[.,]/g, ''), 10) / 1024 : null);
      });
      return;
    }
    execFile('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }, (err, out) => {
      if (err) return resolve(null);
      const kb = parseInt(out.trim(), 10);
      resolve(Number.isFinite(kb) ? kb / 1024 : null);
    });
  });
}

function rpc(endpoint, id, method, params) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const sock = net.connect(endpoint);
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
    sock.on('error', reject);
    const frames = parseStream(sock);
    frames.on('data', (msg) => {
      if (msg && msg.id === id) {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        try { sock.end(); } catch { /* noop */ }
        resolve(ms);
      }
    });
    frames.on('error', reject);
    sock.write(encodeFrame({ id, method, params }));
  });
}

async function waitReady(endpoint, deadline) {
  let id = -1;
  while (Date.now() < deadline) {
    try {
      await rpc(endpoint, id--, 'hello');
      return true;
    } catch { /* ainda não está de pé */ }
    await new Promise((r) => { setTimeout(r, 25); });
  }
  return false;
}

async function main() {
  const endpoint = tmpEndpoint();
  const child = realSpawn(DEFAULT_DAEMON_SERVER_PATH, endpoint);

  const up = await waitReady(endpoint, Date.now() + 3000);
  if (!up) {
    console.error('daemon não subiu a tempo — abortando benchmark');
    try { process.kill(child.pid); } catch { /* noop */ }
    cleanup();
    process.exit(1);
  }

  const denyCase = CASES.find(([exp]) => exp === 'deny');
  const payload = denyCase[2];

  const N_ISOLATED = SMOKE ? 5 : 30;
  const N_BURST = SMOKE ? 0 : 60;
  let reqId = 1;

  // warm-up: primeira chamada paga cache-miss/lazy-require, fora da medição
  await rpc(endpoint, reqId++, 'check', { payload });

  const isolated = [];
  for (let i = 0; i < N_ISOLATED; i++) {
    isolated.push(await rpc(endpoint, reqId++, 'check', { payload }));
  }
  const medianIsolated = median(isolated);

  let medianBurst = null;
  let p95Burst = null;
  let peakRSS = await rssMB(child.pid);

  if (N_BURST > 0) {
    let sampling = false;
    const sampler = setInterval(() => {
      if (sampling) return;
      sampling = true;
      rssMB(child.pid).then((v) => {
        if (v !== null && (peakRSS === null || v > peakRSS)) peakRSS = v;
        sampling = false;
      });
    }, 25);
    const calls = [];
    for (let i = 0; i < N_BURST; i++) {
      calls.push(rpc(endpoint, reqId++, 'check', { payload }));
    }
    const burst = await Promise.all(calls);
    clearInterval(sampler);
    medianBurst = median(burst);
    p95Burst = percentile(burst, 95);
  }

  try { process.kill(child.pid); } catch { /* noop */ }
  cleanup();

  const result = {
    platform: process.platform,
    node: process.version,
    medianIsolatedMs: Number(medianIsolated.toFixed(3)),
    medianBurstMs: medianBurst === null ? null : Number(medianBurst.toFixed(3)),
    p95BurstMs: p95Burst === null ? null : Number(p95Burst.toFixed(3)),
    peakRSSMB: peakRSS === null ? null : Number(peakRSS.toFixed(1)),
    smoke: SMOKE,
    ts: new Date().toISOString(),
  };
  console.log(JSON.stringify(result, null, 2));

  if (SMOKE) {
    if (!fs.existsSync(BASELINE_PATH)) {
      console.log('sem baseline versionada pra esta plataforma/node — smoke roda sem guarda de regressão.');
      process.exit(0);
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    if (result.medianIsolatedMs > baseline.medianIsolatedMs * 2) {
      console.error(
        `REGRESSÃO: mediana isolada ${result.medianIsolatedMs}ms > 2× baseline (${baseline.medianIsolatedMs}ms)`
      );
      process.exit(1);
    }
    process.exit(0);
  }

  const failures = [];
  if (!(result.medianIsolatedMs <= 5)) {
    failures.push(`AC1: mediana isolada ${result.medianIsolatedMs}ms > 5ms`);
  }
  if (!(p95Burst <= 150 && medianBurst < 50)) {
    failures.push(
      `AC2: burst mediana=${result.medianBurstMs}ms p95=${result.p95BurstMs}ms (limites: mediana<50ms, p95<=150ms)`
    );
  }
  if (peakRSS !== null && !(result.peakRSSMB <= 70)) {
    failures.push(`AC3: pico RSS ${result.peakRSSMB}MB > 70MB`);
  }

  if (failures.length) {
    console.error('\nFALHOU:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  fs.writeFileSync(BASELINE_PATH, JSON.stringify(result, null, 2));
  console.log(`\nTodos os thresholds atendidos (AC1-AC3). Baseline salva em ${path.relative(ROOT, BASELINE_PATH)}.`);
  process.exit(0);
}

main();
