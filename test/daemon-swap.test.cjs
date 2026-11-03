'use strict';
/**
 * daemon-swap.test.cjs — instalar ou atualizar nunca deixa o daemon fora do ar sem dizer por quê.
 *
 * Invariantes:
 *   · swapDaemon encerra o antigo, espera ele SAIR, sobe o novo e só devolve ok com o health na versão
 *     esperada e pid diferente (processos reais, versão antiga simulada por uma cópia com outro package.json);
 *   · antigo que ignora o shutdown é encerrado pelo pid que ele mesmo provou; pid não provado ou antigo
 *     que não sai, e novo que não responde, voltam {ok:false, error} com o motivo;
 *   · o daemon grava `start` e `exit` (com motivo) em ~/.token-guard/daemon.log; morte forçada deixa
 *     `previous-unclean` no start seguinte;
 *   · `init --target claude` troca o daemon ao fim, sem janela de minutos, e sai 1 com o motivo quando o
 *     daemon novo não sobe.
 * Tudo em pasta temporária (bootstrap), SID próprio e porta livre: nunca toca o daemon real do usuário.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const DH = require('../adapters/daemon-http.cjs');
const DL = require('../lib/daemon-lifecycle.cjs');
const DC = require('../lib/daemon-client.cjs');

const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => DL.REAL_DEPS.isAlive(pid);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

const spawned = new Set();
function killAll() {
  for (const pid of spawned) { try { process.kill(pid); } catch { /* já saiu */ } }
}
process.on('exit', killAll);

/** Cópia do pacote com outra versão: o "daemon antigo" é um processo real de código anterior. */
function copyOld(version) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-old-'));
  for (const name of fs.readdirSync(ROOT)) {
    const from = path.join(ROOT, name);
    if (['lib', 'adapters'].includes(name)) fs.cpSync(from, path.join(dest, name), { recursive: true });
    else if (/\.(cjs|json|md)$/.test(name) && fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(dest, name));
  }
  const pj = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
  pj.version = version;
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(pj));
  return dest;
}

function startDaemon(script) {
  const child = spawn(process.execPath, [script], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  spawned.add(child.pid);
  return child.pid;
}

async function waitHealth(pred, ms = 15000) {
  const token = DH.readToken();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ep = DH.readEndpoint();
    const h = ep && await DH.probeHealth(ep.port, token, 300);
    if (h && pred(h)) return { h, ep };
    await sleep(100);
  }
  return null;
}

/** Maior intervalo seguido sem o health responder (ms), medido de fora enquanto `work` roda. */
async function outageDuring(work, port) {
  const token = DH.readToken();
  let stop = false;
  let worst = 0;
  let downSince = null;
  const poller = (async () => {
    while (!stop) {
      const h = await DH.probeHealth(port, token, 200);
      const now = Date.now();
      if (h) { if (downSince !== null) worst = Math.max(worst, now - downSince); downSince = null; } else if (downSince === null) downSince = now;
      await sleep(20);
    }
    if (downSince !== null) worst = Math.max(worst, Date.now() - downSince);
  })();
  const out = await work();
  await sleep(150);
  stop = true;
  await poller;
  return { out, worst };
}

const logLines = () => {
  try { return fs.readFileSync(DL.lifecycleLogPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

(async () => {
  console.log('\n  [daemon-swap · troca do daemon sem janela]');
  const port = await freePort();
  process.env.TOKEN_GUARD_HTTP_PORT = String(port);
  fs.mkdirSync(path.dirname(DH.httpTokenPath()), { recursive: true });
  fs.writeFileSync(DH.httpTokenPath(), 'tok-swap-test\n');

  // 1 · processos reais: antigo (0.0.1) → novo (versão do repositório)
  const oldDir = copyOld('0.0.1');
  const oldPid = startDaemon(path.join(oldDir, 'adapters', 'daemon-server.cjs'));
  const up = await waitHealth((h) => h.version === '0.0.1');
  check('antigo sobe e o health informa a versão dele', up && up.h.pid === oldPid, up);

  const { out: swap, worst } = await outageDuring(() => DC.swapDaemon({ expectedVersion: VERSION }), port);
  check('swap devolve ok', swap.ok === true, swap);
  check('versão do health é a esperada', swap.version === VERSION, swap);
  check('o pid do novo é outro', swap.ok && swap.pid !== oldPid && swap.oldPid === oldPid && swap.oldVersion === '0.0.1', swap);
  check('o antigo saiu de fato', !alive(oldPid));
  if (swap.pid) spawned.add(swap.pid);
  const after = await waitHealth((h) => h.version === VERSION);
  check('a mesma porta responde a versão nova', after && after.ep.port === port && after.h.pid === swap.pid, after);
  check('janela de indisponibilidade em segundos, nunca em minutos', worst < 10000 && swap.gapMs < 10000, { worst, gap: swap.gapMs });
  console.log(`    (janela medida de fora: ${worst} ms; do pedido de encerramento ao health novo: ${swap.gapMs} ms)`);

  // 2 · registro de início e saída
  const lines = logLines();
  const ev = lines.map((l) => `${l.event}:${l.pid}`);
  const iOldStart = ev.indexOf(`start:${oldPid}`);
  const iOldExit = ev.indexOf(`exit:${oldPid}`);
  const iNewStart = ev.indexOf(`start:${swap.pid}`);
  check('log: start do antigo, exit do antigo e start do novo, nessa ordem', iOldStart >= 0 && iOldExit > iOldStart && iNewStart > iOldExit, ev);
  const oldExit = lines.find((l) => l.event === 'exit' && l.pid === oldPid);
  check('log: o exit diz o motivo (shutdown solicitado) e o código', oldExit && oldExit.reason === 'shutdown solicitado' && oldExit.code === 0, oldExit);
  const newStart = lines.find((l) => l.event === 'start' && l.pid === swap.pid);
  check('log: o start leva a versão', newStart && newStart.version === VERSION, newStart);

  // 3 · morte forçada não passa pelo exit: o start seguinte denuncia
  process.kill(swap.pid, 'SIGKILL'); // SIGTERM o daemon trata e registra; só SIGKILL é morte sem exit (no Windows kill já é forçado)
  await sleep(500);
  const afterKill = logLines().filter((l) => l.pid === swap.pid);
  check('morte forçada: sem linha de exit (é o que o registro seguinte precisa cobrir)', !afterKill.some((l) => l.event === 'exit'), afterKill);
  const again = startDaemon(path.join(ROOT, 'adapters', 'daemon-server.cjs'));
  const back = await waitHealth((h) => h.pid === again);
  check('daemon sobe de novo depois da morte forçada', !!back, back);
  const unclean = logLines().find((l) => l.event === 'previous-unclean' && l.pid === again);
  check('log: previous-unclean aponta o pid morto sem saída limpa', unclean && unclean.prevPid === swap.pid, unclean);

  // 4 · sem daemon antigo (primeira instalação): só sobe e prova
  await DC.shutdownDaemon();
  for (let i = 0; i < 50 && alive(again); i++) await sleep(100);
  const first = await DC.swapDaemon({ expectedVersion: VERSION });
  check('sem daemon antigo: sobe e prova a versão', first.ok && first.oldPid === null && first.version === VERSION, first);
  if (first.pid) spawned.add(first.pid);

  // 5 · versão igual (reinstalação): troca mesmo assim, pid novo
  const same = await DC.swapDaemon({ expectedVersion: VERSION });
  check('reinstalação da mesma versão troca o processo', same.ok && same.pid !== first.pid && !alive(first.pid), { same, first: first.pid });
  if (same.pid) spawned.add(same.pid);

  // 6 · seams: um "mundo" simulado com fases (antigo → saiu → novo); o killFn nunca é o real
  const sim = ({ stubborn = false, killWorks = true, newVersion = '9.9.9', newError = null, noHttp = false, noPidProof = false } = {}) => {
    let phase = 'old';
    const killed = [];
    let now = 0;
    return {
      killed,
      opts: {
        nowFn: () => now, sleepFn: async (ms) => { now += ms; }, pollMs: 100, stopTimeoutMs: 1000, killWaitMs: 500, bootTimeoutMs: 1000,
        token: noHttp ? null : 'x', endpoint: 'e', expectedVersion: '9.9.9',
        readEndpointFn: () => (noHttp ? null : (phase === 'new' && newError ? { port: 1, error: newError, pid: 44, version: '9.9.9' } : { port: 1 })),
        healthFn: async () => (phase === 'old' ? { pid: 11, version: '1.0.0' } : (phase === 'new' && !newError ? { pid: 33, version: newVersion } : null)),
        connectFn: async (m) => {
          if (m === 'shutdown') { if (!stubborn) phase = 'gone'; return { ok: true, result: {} }; }
          if (m === 'stats') return noPidProof ? { ok: false } : { ok: true, result: { pid: 11 } };
          if (phase === 'old') return { ok: true, result: { packageVersion: '1.0.0' } };
          return phase === 'new' ? { ok: true, result: { packageVersion: newVersion } } : { ok: false };
        },
        isAliveFn: (pid) => pid === 11 && phase === 'old',
        killFn: (pid) => { killed.push(pid); if (killWorks) phase = 'gone'; },
        spawnFn: () => { if (phase === 'gone') phase = 'new'; },
      },
    };
  };
  {
    const w = sim({ stubborn: true });
    const r = await DC.swapDaemon(w.opts);
    check('antigo que ignora o shutdown é encerrado pelo pid provado', r.ok && r.killed === true && w.killed.join() === '11' && r.pid === 33 && r.oldPid === 11, { r, killed: w.killed });
  }
  {
    const w = sim({ stubborn: true, noHttp: true, noPidProof: true });
    const r = await DC.swapDaemon(w.opts);
    check('pid não provado: falha com o motivo e sem matar ninguém', r.ok === false && /não deu para provar o pid/.test(r.error) && !w.killed.length, { r, killed: w.killed });
  }
  {
    const w = sim({ stubborn: true, killWorks: false });
    const r = await DC.swapDaemon(w.opts);
    check('antigo que não sai nem à força: falha nomeando pid e versão', r.ok === false && /pid 11/.test(r.error) && /1\.0\.0/.test(r.error) && /segue na porta/.test(r.error), r);
  }
  {
    const w = sim({ newVersion: '1.0.0' });
    const r = await DC.swapDaemon(w.opts);
    check('novo na versão errada: falha com o motivo, nunca ok', r.ok === false && /não respondeu o health com a versão 9\.9\.9/.test(r.error), r);
  }
  {
    const w = sim({ newError: 'porta fixa 1 ocupada' });
    const r = await DC.swapDaemon(w.opts);
    check('novo sem HTTP: falha com o motivo registrado pelo daemon', r.ok === false && /sem HTTP: porta fixa 1 ocupada/.test(r.error), r);
  }
  {
    const w = sim({ noHttp: true });
    const r = await DC.swapDaemon(w.opts);
    check('sem token (sem hook http): prova pelo pipe, pela versão', r.ok === true && r.version === '9.9.9' && r.pid === null, r);
  }

  // 7 · limpeza do daemon dos casos 4/5 antes do init
  await DC.shutdownDaemon();
  for (let i = 0; i < 50 && alive(same.pid); i++) await sleep(100);
  fs.rmSync(DH.endpointPath(), { force: true });

  // 8 · init --target claude de ponta a ponta (autostart continua desligado; o swap é reaberto)
  const runInit = () => spawnSync(process.execPath, [path.join(ROOT, 'install.cjs'), '--target', 'claude'], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: { ...process.env, TOKEN_GUARD_NO_DAEMON_SWAP: '0' },
  });
  const i1 = runInit();
  check('init 1 sai 0 e relata o daemon', i1.status === 0 && /\[daemon\]\s+ok\s+respondendo na versão/.test(i1.stdout), { status: i1.status, out: i1.stdout.slice(-600), err: i1.stderr.slice(-300) });
  check('init 1: não havia daemon antigo', /não havia daemon antigo/.test(i1.stdout), i1.stdout.slice(-500));
  const h1 = await waitHealth((h) => h.version === VERSION);
  check('depois do init 1 o daemon responde o health na versão instalada', !!h1, h1);
  if (h1) spawned.add(h1.h.pid);

  const settingsAfter1 = fs.readFileSync(DH.claudeSettingsPath(), 'utf8');
  const ep1 = DH.readEndpoint();
  // Assíncrono de propósito: spawnSync pararia o event loop e o medidor de fora não veria nada.
  const runInitAsync = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'install.cjs'), '--target', 'claude'], {
      windowsHide: true, env: { ...process.env, TOKEN_GUARD_NO_DAEMON_SWAP: '0' },
    });
    let stdout = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', () => {});
    c.on('close', (status) => resolve({ status, stdout }));
  });
  const { out: i2, worst: worst2 } = await outageDuring(runInitAsync, ep1.port);
  check('init 2 (atualização por cima) sai 0 e troca o processo', i2.status === 0 && /o antigo \(pid \d+\) saiu/.test(i2.stdout), { status: i2.status, out: i2.stdout.slice(-500) });
  const h2 = await waitHealth((h) => h.version === VERSION && h1 && h.pid !== h1.h.pid);
  check('depois do init 2 responde um pid novo, na versão instalada', !!h2 && !alive(h1.h.pid), h2);
  check('janela medida durante o init 2 em segundos', worst2 < 15000, worst2);
  console.log(`    (init 2: janela medida de fora ${worst2} ms)`);
  check('settings.json aponta para a porta onde o daemon novo respondeu', h2 && fs.readFileSync(DH.claudeSettingsPath(), 'utf8').includes(`127.0.0.1:${h2.ep.port}/`) && settingsAfter1.length > 0, h2 && h2.ep);
  if (h2) spawned.add(h2.h.pid);

  // 9 · init com o daemon novo sem HTTP (porta fixa ocupada por outro): sai 1 e diz o motivo
  await DC.shutdownDaemon();
  for (let i = 0; i < 50 && h2 && alive(h2.h.pid); i++) await sleep(100);
  const busy = net.createServer();
  await new Promise((r) => busy.listen(port, '127.0.0.1', r));
  const i3 = runInit();
  check('porta ocupada: init sai 1', i3.status === 1, { status: i3.status, out: i3.stdout.slice(-300) });
  check('porta ocupada: o erro nomeia o motivo', /DAEMON NAO SUBIU/.test(i3.stderr) && /sem HTTP/.test(i3.stderr) && /ocupada/.test(i3.stderr), i3.stderr.slice(-400));
  await new Promise((r) => busy.close(r));
  await DC.shutdownDaemon();
  await sleep(300);

  // 10 · cursor e repo também trocam o daemon, subindo-o do runtime do próprio alvo
  const runTarget = (args, cwd) => spawnSync(process.execPath, [path.join(ROOT, 'install.cjs'), ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, cwd,
    env: { ...process.env, TOKEN_GUARD_NO_DAEMON_SWAP: '0' },
  });
  const iCur = runTarget(['--target', 'cursor']);
  check('init --target cursor sai 0 e relata o daemon', iCur.status === 0 && /\[daemon\]\s+ok\s+respondendo na versão/.test(iCur.stdout), { status: iCur.status, err: iCur.stderr.slice(-300) });
  const hCur = await waitHealth((h) => h.version === VERSION);
  check('depois do init cursor o daemon responde na versão instalada', !!hCur, hCur);
  if (hCur) spawned.add(hCur.h.pid);
  const lastStart = [...logLines()].reverse().find((l) => l.event === 'start');
  check('o daemon do cursor subiu do runtime do cursor', !!lastStart && lastStart.pid === (hCur && hCur.h.pid), lastStart);

  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-repo-'));
  const iRepo = runTarget(['--target', 'repo', repoDir], repoDir);
  check('init --target repo sai 0 e troca o processo', iRepo.status === 0 && /o antigo \(pid \d+\) saiu/.test(iRepo.stdout), { status: iRepo.status, out: iRepo.stdout.slice(-500), err: iRepo.stderr.slice(-300) });
  const hRepo = await waitHealth((h) => h.version === VERSION && hCur && h.pid !== hCur.h.pid);
  check('depois do init repo responde um pid novo', !!hRepo, hRepo);
  if (hRepo) spawned.add(hRepo.h.pid);
  await DC.shutdownDaemon();
  await sleep(300);

  killAll();
  console.log(`\n  ${pass} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  killAll();
  console.error(err);
  process.exit(1);
});
