'use strict';
/**
 * daemon-handover.test.cjs — a troca do daemon não fecha a porta do HTTP, e o daemon não sai por
 * ociosidade com sessão de Claude Code ou de Codex aberta.
 *
 * Invariantes:
 *   · swapDaemon com o antigo oferecendo `handover`: o sucessor assume o socket do HTTP, nenhuma sondagem
 *     de fora (a cada poucos ms, na mesma porta) falha durante a troca, o pipe volta no processo novo e o
 *     antigo sai limpo (sem `previous-unclean` no registro);
 *   · sucessor que não assume: o antigo segue servindo e registra `handover-failed`;
 *   · `handover` recusa caminho que não é o daemon-server.cjs de uma instalação do token-guard;
 *   · scheduleIdleShutdown reagenda em vez de sair enquanto há sessão viva; liveSessions lê o registro do
 *     Claude Code (pid vivo) e o lock exclusivo de thread do Codex.
 * Pasta temporária (bootstrap), SID próprio e porta livre: nunca toca o daemon real do usuário.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const DH = require('../adapters/daemon-http.cjs');
const DL = require('../lib/daemon-lifecycle.cjs');
const DC = require('../lib/daemon-client.cjs');
const SA = require('../lib/sessions-alive.cjs');
const { scheduleIdleShutdown } = require('../adapters/daemon-server.cjs');

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
function copyPackage(version) {
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

async function waitDead(pid, ms = 10000) {
  for (let i = 0; i < ms / 100 && alive(pid); i++) await sleep(100);
  return !alive(pid);
}

/** Sondagens de fora, uma após a outra, enquanto `work` roda: quantas falharam e quantas responderam. */
async function probeDuring(work, port) {
  const token = DH.readToken();
  let stop = false;
  let failed = 0;
  let ok = 0;
  const pids = new Set();
  const poller = (async () => {
    while (!stop) {
      const h = await DH.probeHealth(port, token, 500);
      if (h) { ok++; pids.add(h.pid); } else failed++;
      await sleep(3);
    }
  })();
  const out = await work();
  await sleep(200);
  stop = true;
  await poller;
  return { out, failed, ok, pids };
}

const logLines = () => {
  try { return fs.readFileSync(DL.lifecycleLogPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

(async () => {
  console.log('\n  [daemon-handover · troca sem queda e ociosidade com sessão viva]');
  const port = await freePort();
  process.env.TOKEN_GUARD_HTTP_PORT = String(port);
  fs.mkdirSync(path.dirname(DH.httpTokenPath()), { recursive: true });
  fs.writeFileSync(DH.httpTokenPath(), 'tok-handover-test\n');

  // 1 · troca sem queda com processos reais
  const oldDir = copyPackage('0.0.1');
  const oldPid = startDaemon(path.join(oldDir, 'adapters', 'daemon-server.cjs'));
  const up = await waitHealth((h) => h.version === '0.0.1');
  check('antigo sobe e responde o health', up && up.h.pid === oldPid, up);

  const { out: swap, failed, ok, pids } = await probeDuring(() => DC.swapDaemon({ expectedVersion: VERSION }), port);
  check('swap devolve ok pela troca sem queda', swap.ok === true && swap.handover === true && !swap.handoverFallback, swap);
  check('o pid do novo é outro e a versão é a esperada', swap.ok && swap.pid !== oldPid && swap.oldPid === oldPid && swap.version === VERSION, swap);
  if (swap.pid) spawned.add(swap.pid);
  check('nenhuma sondagem de fora falhou durante a troca', failed === 0 && ok > 20, { failed, ok });
  check('as sondagens viram o antigo e o novo, na mesma porta', pids.has(oldPid) && pids.has(swap.pid), [...pids]);
  check('o antigo saiu sozinho depois de passar o HTTP', await waitDead(oldPid));
  const after = await waitHealth((h) => h.version === VERSION);
  check('a mesma porta segue no processo novo', after && after.ep.port === port && after.h.pid === swap.pid, after);
  const hello = await DC.connectOnce('hello', {}, { timeoutMs: 2000 });
  check('o pipe responde no processo novo, na versão nova', hello.ok && hello.result.packageVersion === VERSION, hello);
  const stats = await DC.connectOnce('stats', {}, { timeoutMs: 2000 });
  check('o pipe é do processo novo', stats.ok && stats.result.pid === swap.pid, stats);

  const lines = logLines();
  const oldExit = lines.find((l) => l.event === 'exit' && l.pid === oldPid);
  check('o exit do antigo diz que foi troca sem queda e quem assumiu', oldExit && oldExit.code === 0 && /troca sem queda/.test(oldExit.reason) && oldExit.reason.includes(String(swap.pid)), oldExit);
  const httpOn = lines.find((l) => l.event === 'http-on' && l.pid === swap.pid);
  check('o http-on do novo registra de quem assumiu', httpOn && httpOn.port === port && httpOn.handoverFrom === oldPid, httpOn);
  check('sem previous-unclean para o antigo que passou o serviço', !lines.some((l) => l.event === 'previous-unclean' && l.prevPid === oldPid), lines.filter((l) => l.event === 'previous-unclean'));

  // 2 · caminho recusado e sucessor que não assume: o daemon em pé segue servindo
  const refused = await DC.connectOnce('handover', { daemonServerPath: process.execPath }, { timeoutMs: 2000 });
  check('handover recusa caminho que não é o daemon-server.cjs do token-guard', refused.ok === false);
  const strayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stray-'));
  fs.mkdirSync(path.join(strayDir, 'adapters'));
  fs.writeFileSync(path.join(strayDir, 'package.json'), JSON.stringify({ name: 'outro-pacote', version: '1.0.0' }));
  fs.writeFileSync(path.join(strayDir, 'adapters', 'daemon-server.cjs'), 'process.exit(0);\n');
  const strayRefused = await DC.connectOnce('handover', { daemonServerPath: path.join(strayDir, 'adapters', 'daemon-server.cjs') }, { timeoutMs: 2000 });
  check('handover recusa instalação que não é do token-guard', strayRefused.ok === false);

  const deadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dead-'));
  fs.mkdirSync(path.join(deadDir, 'adapters'));
  fs.writeFileSync(path.join(deadDir, 'package.json'), JSON.stringify({ name: '@allansantos-dev/token-guard', version: '9.9.9' }));
  fs.writeFileSync(path.join(deadDir, 'adapters', 'daemon-server.cjs'), 'process.exit(3);\n');
  const accepted = await DC.connectOnce('handover', { daemonServerPath: path.join(deadDir, 'adapters', 'daemon-server.cjs') }, { timeoutMs: 2000 });
  check('handover aceita uma instalação do token-guard e responde na hora', accepted.ok && accepted.result.started === true, accepted);
  let failedLine = null;
  for (let i = 0; i < 60 && !failedLine; i++) {
    await sleep(100);
    failedLine = logLines().find((l) => l.event === 'handover-failed' && l.pid === swap.pid);
  }
  check('sucessor que sai antes de assumir: handover-failed no registro, com o motivo', failedLine && /saiu/.test(failedLine.error), failedLine);
  const still = await waitHealth((h) => h.pid === swap.pid, 3000);
  check('o daemon em pé segue servindo na mesma porta', !!still && alive(swap.pid), still);

  // 3 · swapDaemon: antigo sem a troca (handover:false) cai no caminho de sempre, sem fingir
  const legacy = await DC.swapDaemon({ expectedVersion: VERSION, handover: false });
  check('handover:false usa o encerramento e sobe o novo', legacy.ok && !legacy.handover && legacy.pid !== swap.pid && legacy.oldPid === swap.pid, legacy);
  if (legacy.pid) spawned.add(legacy.pid);
  check('o antigo saiu pelo shutdown', await waitDead(swap.pid));
  {
    let phase = 'old';
    let t = 0;
    const r = await DC.swapDaemon({
      expectedVersion: '9.9.9', endpoint: 'e', token: 'x', pollMs: 100, bootTimeoutMs: 1000, stopTimeoutMs: 500, killWaitMs: 200,
      nowFn: () => t, sleepFn: async (ms) => { t += ms; },
      readEndpointFn: () => ({ port: 1 }),
      healthFn: async () => (phase === 'old' ? { pid: 11, version: '1.0.0' } : phase === 'new' ? { pid: 33, version: '9.9.9' } : null),
      connectFn: async (m) => {
        if (m === 'handover') return { ok: false };
        if (m === 'shutdown') { phase = 'gone'; return { ok: true, result: {} }; }
        if (phase === 'old') return { ok: true, result: { packageVersion: '1.0.0' } };
        return phase === 'new' ? { ok: true, result: { packageVersion: '9.9.9' } } : { ok: false };
      },
      isAliveFn: (pid) => pid === 11 && phase === 'old', spawnFn: () => { phase = 'new'; }, killFn: () => {},
    });
    check('antigo sem handover: cai no encerramento e o resultado diz o motivo', r.ok && !r.handover && /não oferece a troca sem queda/.test(r.handoverFallback), r);
  }
  await DC.shutdownDaemon();
  await waitDead(legacy.pid);

  // 4 · ociosidade com sessão viva
  {
    let now = 1_000_000;
    let timeoutCb = null;
    let armedFor = null;
    let exitedWith = null;
    let live = 2;
    const fakeServer = { ctx: { lastActivity: now }, close: (cb) => { if (cb) cb(); } };
    const deps = {
      nowFn: () => now,
      setTimeoutFn: (cb, ms) => { timeoutCb = cb; armedFor = ms; return 'timer'; },
      unlinkFn: () => {},
      exitFn: (code) => { exitedWith = code; },
      liveSessionsFn: () => live,
    };
    scheduleIdleShutdown(fakeServer, '/tmp/x.lock', 5000, deps);
    now += 6000;
    timeoutCb();
    check('ocioso com sessão viva: não sai e reagenda a janela inteira', exitedWith === null && armedFor === 5000, { exitedWith, armedFor });
    now += 6000;
    live = 0;
    timeoutCb();
    check('ocioso sem sessão viva: sai', exitedWith === 0);
    exitedWith = null;
    live = 1;
    deps.liveSessionsFn = () => { throw new Error('registro ilegível'); };
    fakeServer.ctx.lastActivity = now - 6000;
    scheduleIdleShutdown(fakeServer, '/tmp/x.lock', 5000, deps);
    timeoutCb();
    check('registro de sessões ilegível não segura o daemon para sempre', exitedWith === 0, exitedWith);
  }

  // 5 · liveSessions: Claude Code (pid vivo) e Codex (lock exclusivo, só Windows)
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sessions-'));
    check('sem registro nenhum: zero', SA.liveSessions(home).total === 0);
    const sdir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, `${process.pid}.json`), '{}');
    fs.writeFileSync(path.join(sdir, '2147483646.json'), '{}');
    fs.writeFileSync(path.join(sdir, 'lixo.json'), '{}');
    check('Claude Code: conta só o registro de pid vivo', SA.liveSessions(home).claude === 1, SA.liveSessions(home));

    if (process.platform === 'win32') {
      const ldir = path.join(home, '.codex', 'thread-writer-locks');
      fs.mkdirSync(ldir, { recursive: true });
      const held = path.join(ldir, 'thread-a.lock');
      const free = path.join(ldir, 'thread-b.lock');
      fs.writeFileSync(held, '');
      fs.writeFileSync(free, '');
      fs.writeFileSync(path.join(ldir, '.coordination.lock'), '');
      const quoted = held.replace(/'/g, "''");
      const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$f=[IO.File]::Open('${quoted}','Open','ReadWrite','None'); Start-Sleep -Seconds 60`], { windowsHide: true, stdio: 'ignore' });
      spawned.add(holder.pid);
      let codex = 0;
      for (let i = 0; i < 100 && codex === 0; i++) { await sleep(100); codex = SA.liveSessions(home).codex; }
      check('Codex: lock de thread aberto por outro processo conta, o livre e o de coordenação não', codex === 1, SA.liveSessions(home));
      try { holder.kill(); } catch { /* já saiu */ }
      await waitDead(holder.pid, 5000);
    } else {
      check('Codex fora do Windows: sem sinal de lock, zero', SA.liveSessions(home).codex === 0);
    }
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* lock do powershell ainda soltando */ }
  }

  {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sync-')), 'settings.json');
    const old = (r) => ({ type: 'http', url: `http://127.0.0.1:40000/token-guard/${r}`, headers: { 'X-Token-Guard': 't' } });
    fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [old('pre')] }], PostToolUse: [{ hooks: [old('post')] }], UserPromptSubmit: [{ hooks: [old('prompt')] }] } }));
    const r = DH.syncClaudeSettings(41000, file);
    const urls = JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')));
    check('URL antiga sem origem é reapontada: porta nova, hook-origin e port-file nos três', r.ok && r.changed === 3 && (urls.match(/:41000\/token-guard\/[a-z]+\?hook-origin=token-guard&port-file=/g) || []).length === 3, { r, urls });
  }

  killAll();
  console.log(`\n  ${pass} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  killAll();
  console.error(err);
  process.exit(1);
});
