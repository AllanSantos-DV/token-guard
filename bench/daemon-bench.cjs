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
 * Cada execução mede ROUNDS rodadas de (isolada + burst) contra o mesmo daemon e
 * reporta a mediana entre rodadas, mais a lista `rounds` com a dispersão crua.
 *
 *   node bench/daemon-bench.cjs           — caracterização completa (isolada + burst + RSS)
 *   node bench/daemon-bench.cjs --smoke   — variante leve (N=5, sem burst)
 *
 * NÃO é portão de CI/release (backlog A19, decisão do dono 2026-10-08): em 18
 * execuções sem mudança de código a mediana do burst variou 25-117 ms e o
 * AC2 (<50 ms) passou em só 5 — reprovava sem regressão. Os limites AC1-AC3
 * viram REFERÊNCIA impressa ao lado da medida; a saída é sempre 0 (exceto se
 * o próprio bench quebrar) e nenhuma baseline é gravada até alguém medir uma
 * distribuição confiável. As baselines antigas ficam no repositório como histórico.
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

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * s.length) - 1);
  return s[idx];
}
function median(arr) { return percentile(arr, 50); }

/* Named pipe no Windows não tem backing de filesystem: só o POSIX precisa de diretório. */
function tmpEndpoint() {
  if (process.platform === 'win32') return { endpoint: `\\\\.\\pipe\\token-guard-bench-${process.pid}-${Math.random().toString(36).slice(2)}`, dir: null };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bench-daemon-'));
  return { endpoint: path.join(dir, 'bench.sock'), dir };
}

/**
 * RSS do PID em MB pela via do SO. INVARIANTE: só pode ser chamada FORA da
 * janela de medição de latência. Criar processo bloqueia o event loop de quem
 * mede (`uv_spawn` é síncrono na thread do loop no Windows, e um agente de
 * controle de aplicação corporativo inspeciona cada `CreateProcessW`), então
 * uma amostra durante o burst infla a latência medida em ~10× — mesmo com
 * `execFile` assíncrono. Amostragem durante o burst usa o método `stats` do
 * daemon, que não spawna nada. Best-effort: qualquer falha resolve null e quem
 * chama trata como amostra perdida, não erro.
 */
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

function call(endpoint, id, method, params) {
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
        resolve({ ms, result: msg.result });
      }
    });
    frames.on('error', reject);
    sock.write(encodeFrame({ id, method, params }));
  });
}

function rpc(endpoint, id, method, params) {
  return call(endpoint, id, method, params).then((r) => r.ms);
}

/** RSS do daemon pelo próprio daemon (`stats`): zero spawn, seguro durante o burst. */
function rssMBViaIpc(endpoint, id) {
  return call(endpoint, id, 'stats', {})
    .then((r) => (r.result && Number.isFinite(r.result.rssBytes) ? r.result.rssBytes / 1048576 : null))
    .catch(() => null);
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

/**
 * Uma rodada = um daemon novo. O pico de RSS só é comparável ao AC3 se cada
 * rodada reproduzir o cenário do critério — um burst de `nBurst` requisições num
 * processo recém-nascido; reaproveitar o daemon entre rodadas mede outra coisa
 * (o RSS acumulado de 3 bursts). Resolve null se o daemon não subir.
 */
async function round(payload, nIsolated, nBurst) {
  const { endpoint, dir: endpointDir } = tmpEndpoint();
  const child = realSpawn(DEFAULT_DAEMON_SERVER_PATH, endpoint);
  const stop = () => {
    try { process.kill(child.pid); } catch { /* noop */ }
    if (endpointDir) { try { fs.rmSync(endpointDir, { recursive: true, force: true }); } catch { /* noop */ } }
  };

  if (!(await waitReady(endpoint, Date.now() + 3000))) {
    stop();
    return null;
  }

  let reqId = 1;
  // warm-up: primeira chamada paga cache-miss/lazy-require, fora da medição
  await rpc(endpoint, reqId++, 'check', { payload });

  const isolated = [];
  for (let i = 0; i < nIsolated; i++) {
    isolated.push(await rpc(endpoint, reqId++, 'check', { payload }));
  }

  let peakRSS = await rssMB(child.pid);
  let burstMedian = null;
  let burstP95 = null;
  let osRSSAfterBurst = null;

  if (nBurst > 0) {
    let sampling = false;
    const sampler = setInterval(() => {
      if (sampling) return;
      sampling = true;
      rssMBViaIpc(endpoint, reqId++).then((v) => {
        if (v !== null && (peakRSS === null || v > peakRSS)) peakRSS = v;
        sampling = false;
      });
    }, 25);
    const calls = [];
    for (let i = 0; i < nBurst; i++) {
      calls.push(rpc(endpoint, reqId++, 'check', { payload }));
    }
    const burst = await Promise.all(calls);
    clearInterval(sampler);
    burstMedian = median(burst);
    burstP95 = percentile(burst, 95);

    // Amostra do SO depois do burst: confere se o RSS auto-reportado bate com
    // o que o SO vê, sem pagar o spawn dentro da janela medida.
    osRSSAfterBurst = await rssMB(child.pid);
    if (osRSSAfterBurst !== null && (peakRSS === null || osRSSAfterBurst > peakRSS)) peakRSS = osRSSAfterBurst;
  }

  stop();
  return {
    isolatedMs: median(isolated),
    burstMedianMs: burstMedian,
    burstP95Ms: burstP95,
    peakRSSMB: peakRSS,
    osRSSMB: osRSSAfterBurst,
  };
}

async function main() {
  const denyCase = CASES.find(([exp]) => exp === 'deny');
  const payload = denyCase[2];

  const N_ISOLATED = SMOKE ? 5 : 30;
  const N_BURST = SMOKE ? 0 : 60;
  /* INVARIANTE DE MEDIÇÃO: uma rodada só não é medida. A mediana do burst varia
     por fator de 2× ou mais entre execuções da mesma árvore, conforme o estado da
     máquina. Gate e baseline versionada olham a mediana entre rodadas; julgar — ou
     gravar — uma rodada isolada transforma ruído do SO em veredito. */
  const ROUNDS = SMOKE ? 1 : 3;

  const rounds = [];
  for (let r = 0; r < ROUNDS; r++) {
    const got = await round(payload, N_ISOLATED, N_BURST);
    if (!got) {
      console.error('daemon não subiu a tempo — abortando benchmark');
      cleanup();
      process.exit(1);
    }
    rounds.push(got);
  }
  cleanup();

  const samples = (key) => rounds.map((r) => r[key]).filter((v) => v !== null);
  const medianIsolated = median(rounds.map((r) => r.isolatedMs));
  const medianBurst = N_BURST === 0 ? null : median(rounds.map((r) => r.burstMedianMs));
  const p95Burst = N_BURST === 0 ? null : median(rounds.map((r) => r.burstP95Ms));
  const rssSamples = samples('peakRSSMB');
  const peakRSS = rssSamples.length ? Math.max(...rssSamples) : null;
  const osSamples = samples('osRSSMB');
  const osRSSAfterBurst = osSamples.length ? osSamples[osSamples.length - 1] : null;

  const result = {
    platform: process.platform,
    node: process.version,
    medianIsolatedMs: Number(medianIsolated.toFixed(3)),
    medianBurstMs: medianBurst === null ? null : Number(medianBurst.toFixed(3)),
    p95BurstMs: p95Burst === null ? null : Number(p95Burst.toFixed(3)),
    peakRSSMB: peakRSS === null ? null : Number(peakRSS.toFixed(1)),
    osRSSAfterBurstMB: osRSSAfterBurst === null ? null : Number(osRSSAfterBurst.toFixed(1)),
    rounds: rounds.map((r) => ({
      isolatedMs: Number(r.isolatedMs.toFixed(3)),
      burstMedianMs: r.burstMedianMs === null ? null : Number(r.burstMedianMs.toFixed(3)),
      burstP95Ms: r.burstP95Ms === null ? null : Number(r.burstP95Ms.toFixed(3)),
      peakRSSMB: r.peakRSSMB === null ? null : Number(r.peakRSSMB.toFixed(1)),
    })),
    smoke: SMOKE,
    ts: new Date().toISOString(),
  };
  console.log(JSON.stringify(result, null, 2));

  if (SMOKE) process.exit(0);

  // Referência, não veredito: cada AC aparece ao lado da medida.
  const ref = [
    ['AC1 mediana isolada <=5ms', result.medianIsolatedMs <= 5, `${result.medianIsolatedMs}ms`],
    ['AC2 burst mediana<50ms e p95<=150ms', p95Burst <= 150 && medianBurst < 50, `mediana=${result.medianBurstMs}ms p95=${result.p95BurstMs}ms`],
  ];
  if (peakRSS !== null) ref.push(['AC3 pico RSS <=70MB', result.peakRSSMB <= 70, `${result.peakRSSMB}MB`]);
  console.log('\nReferência dos critérios de aceite (caracterização — não trava nada):');
  for (const [label, ok, got] of ref) console.log(`  ${ok ? 'dentro' : 'fora  '}  ${label}: ${got}`);
  process.exit(0);
}

main();
