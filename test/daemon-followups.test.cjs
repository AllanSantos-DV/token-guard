'use strict';
/**
 * daemon-followups.test.cjs — o daemon volta sozinho depois de atualizar, em qualquer alvo e em qualquer
 * máquina, e uma queda sempre deixa rastro.
 *
 * Invariantes:
 *   · SessionStart troca por swapDaemon o daemon velho que o shutdown do cliente não tira (sem handshake);
 *   · o cliente nunca aposenta um daemon de versão MAIS NOVA (cópia esquecida em .github/token-guard);
 *   · falha antes de escutar e http desligado deixam linha no daemon.log; quem perde o singleton sai 0 calado;
 *   · `previous-unclean` vale por endpoint e independe de o pid estar vivo (pid reusado);
 *   · swapDaemon não confunde o erro de http de um daemon anterior com falha do novo;
 *   · a tela de setup (ui-launch) reinicia o daemon sem http pelo swapDaemon;
 *   · o ícone da bandeja antigo não é trocado pelo daemon: o script dele só muda com a troca implementada;
 *   · o passo de desinstalação que encerra o daemon, escrito no INSTALL.md, funciona de verdade.
 * Tudo no home e no SID isolados do bootstrap: nunca toca o daemon real do usuário.
 */

require('./bootstrap.cjs');

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const DH = require('../adapters/daemon-http.cjs');
const DL = require('../lib/daemon-lifecycle.cjs');
const DC = require('../lib/daemon-client.cjs');
const DS = require('../adapters/daemon-server.cjs');
const SS = require('../adapters/session-start.cjs');
const { parseStream, writeFrame } = require('../lib/ipc-frame.cjs');

const ROOT = path.join(__dirname, '..');
const VERSION = require('../package.json').version;
const DAEMON = path.join(ROOT, 'adapters', 'daemon-server.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 500) : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => DL.REAL_DEPS.isAlive(pid);
const logLines = () => {
  try { return fs.readFileSync(DL.lifecycleLogPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const resetLog = () => fs.rmSync(DL.lifecycleLogPath(), { force: true });

const spawned = new Set();
function killAll() {
  for (const pid of spawned) { try { process.kill(pid); } catch { /* já saiu */ } }
}
process.on('exit', killAll);

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startDaemon(script, env) {
  const child = spawn(process.execPath, [script || DAEMON], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env } });
  child.unref();
  spawned.add(child.pid);
  return child.pid;
}

async function waitFor(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await pred();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

const helloUp = () => DC.connectOnce('hello', {}, { timeoutMs: 300 });

async function stopDaemon() {
  await DC.shutdownDaemon();
  await waitFor(async () => !(await helloUp()).ok && [...spawned].every((p) => !alive(p)), 8000);
}

/** Cópia do pacote com outra versão: o "daemon/cliente antigo" é código real anterior. */
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

/** Daemon "anterior à 2.5.0": responde sem handshake e ignora o shutdown. */
function startStubOldDaemon() {
  const endpoint = DS.defaultEndpoint();
  const server = net.createServer((socket) => {
    parseStream(socket).on('data', (msg) => writeFrame(socket, { id: msg.id, result: { pong: true, pid: process.pid } }));
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const attempt = () => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && Date.now() < deadline) setTimeout(attempt, 100);
        else reject(err);
      });
      server.listen(endpoint, () => { server.removeAllListeners('error'); resolve(server); });
    };
    attempt();
  });
}

(async () => {
  console.log('\n  [daemon-followups · o daemon volta sempre e deixa rastro]');

  // 1 · previous-unclean: por endpoint, sem perguntar se o pid vive
  {
    const file = path.join(os.tmpdir(), `tg-lc-${process.pid}.log`);
    const rec = (o) => JSON.stringify({ at: '2026-01-01T00:00:00.000Z', ...o }) + '\n';
    const events = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const livePid = process.ppid;

    fs.writeFileSync(file, rec({ event: 'start', pid: livePid, version: '1.0.0', endpoint: 'ep-A' }));
    DL.recordStart({ version: VERSION, endpoint: 'ep-A' }, file);
    const e1 = events();
    check('start sem exit do mesmo endpoint vira previous-unclean, mesmo com o pid vivo (pid reusado)',
      e1.some((e) => e.event === 'previous-unclean' && e.prevPid === livePid), e1);

    fs.writeFileSync(file, rec({ event: 'start', pid: livePid, version: '1.0.0', endpoint: 'ep-OUTRO' }));
    DL.recordStart({ version: VERSION, endpoint: 'ep-A' }, file);
    check('start sem exit de OUTRO endpoint não é queda deste', !events().some((e) => e.event === 'previous-unclean'), events());

    fs.writeFileSync(file, rec({ event: 'start', pid: livePid, endpoint: 'ep-A' }) + rec({ event: 'exit', pid: livePid, code: 0, reason: 'x' }));
    DL.recordStart({ version: VERSION, endpoint: 'ep-A' }, file);
    check('start seguido de exit do mesmo pid é saída limpa', !events().some((e) => e.event === 'previous-unclean'), events());

    fs.writeFileSync(file, rec({ event: 'start', pid: livePid, endpoint: 'ep-A' }));
    DL.recordStart({ version: VERSION, endpoint: 'ep-A' }, file);
    DL.recordStart({ version: VERSION, endpoint: 'ep-A' }, file);
    check('a queda é relatada uma vez só', events().filter((e) => e.event === 'previous-unclean').length === 1, events());
    fs.rmSync(file, { force: true });
  }

  // 2 · versão: cliente velho não aposenta daemon mais novo
  {
    check('compareVersions ordena numericamente', DL.compareVersions('2.10.0', '2.9.9') === 1 && DL.compareVersions('2.16.2', '2.16.2') === 0 && DL.compareVersions('1.0.0', '2.0.0') === -1);
    const proto = DS.PROTOCOL_VERSION;
    const calls = [];
    const make = (v) => DC.createClient({
      connectFn: async (method) => { calls.push(method); return { ok: true, result: {}, handshake: { protocolVersion: proto, packageVersion: v } }; },
      sleepFn: async () => {},
    });
    await make('99.0.0').tryDaemon('ping', {});
    check('daemon mais novo que o cliente não recebe shutdown', !calls.includes('shutdown'), calls);
    calls.length = 0;
    await make('0.0.1').tryDaemon('ping', {});
    check('daemon mais velho que o cliente recebe shutdown', calls.includes('shutdown'), calls);
  }

  // 3 · cliente velho de verdade (cópia esquecida) não derruba o daemon novo
  {
    resetLog();
    const pid = startDaemon();
    const up = await waitFor(async () => { const h = await helloUp(); return h.ok && h; });
    check('daemon novo sobe', !!up && up.result.packageVersion === VERSION, up);
    const old = copyOld('0.0.1');
    fs.writeFileSync(path.join(old, 'ping.cjs'),
      "require('./lib/daemon-client.cjs').tryDaemon('ping', {}).then((r) => { console.log(JSON.stringify({ ok: r.ok })); process.exit(0); });\n");
    const r = spawnSync(process.execPath, [path.join(old, 'ping.cjs')], { encoding: 'utf8', env: process.env, timeout: 20000, windowsHide: true });
    check('o cliente velho consegue falar com o daemon novo', /"ok":true/.test(r.stdout), { out: r.stdout, err: r.stderr });
    await sleep(600);
    const st = await DC.connectOnce('stats', {}, { timeoutMs: 500 });
    check('o daemon novo segue de pé, mesmo pid, depois do cliente velho', st.ok && st.result.pid === pid && alive(pid), st);
    check('nenhum exit foi gravado', !logLines().some((l) => l.event === 'exit'), logLines());
    fs.rmSync(old, { recursive: true, force: true });

    // 4 · quem perde o singleton sai 0 e não deixa linha (e é por isso que Restart=always no systemd faria laço)
    const before = logLines().length;
    const second = spawnSync(process.execPath, [DAEMON], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: process.env });
    check('segunda instância sai 0 (singleton)', second.status === 0, { status: second.status, err: second.stderr });
    check('a segunda instância não grava linha no log', logLines().length === before, logLines().slice(before));
    await stopDaemon();
  }

  // 5 · falha antes de escutar deixa o motivo no log
  {
    resetLog();
    const notADir = path.join(os.tmpdir(), `tg-notadir-${process.pid}`);
    fs.writeFileSync(notADir, '');
    const badEndpoint = process.platform === 'win32' ? '\\\\.\\nopipe\\tg-followups' : path.join(notADir, 'x.sock');
    const r = spawnSync(process.execPath, [DAEMON, badEndpoint], { encoding: 'utf8', timeout: 20000, windowsHide: true, env: process.env });
    fs.rmSync(notADir, { force: true });
    const exits = logLines().filter((l) => l.event === 'exit');
    check('listen que falha sai 1', r.status === 1, { status: r.status, err: r.stderr });
    check('o exit da falha antes de escutar traz o motivo', exits.length === 1 && /listen falhou/.test(exits[0].reason) && exits[0].code === 1, logLines());
    check('sem start: ele nunca escutou', !logLines().some((l) => l.event === 'start'), logLines());
  }

  // 6 · http desligado (porta fixa ocupada) deixa linha no log
  {
    resetLog();
    const port = await freePort();
    const busy = net.createServer();
    await new Promise((r) => busy.listen(port, '127.0.0.1', r));
    fs.mkdirSync(path.dirname(DH.httpTokenPath()), { recursive: true });
    fs.writeFileSync(DH.httpTokenPath(), 'tok-followups\n');
    startDaemon(DAEMON, { TOKEN_GUARD_HTTP_PORT: String(port), TOKEN_GUARD_TRAY: 'off' });
    const off = await waitFor(() => logLines().find((l) => l.event === 'http-off'));
    check('http desligado grava http-off com o motivo', !!off && /ocupada/.test(off.reason), logLines());
    await stopDaemon();
    await new Promise((r) => busy.close(r));
    fs.rmSync(DH.httpTokenPath(), { force: true });
    fs.rmSync(DH.endpointPath(), { force: true });
  }

  // 7 · swapDaemon não toma o erro de http de um daemon anterior pelo do novo
  {
    let spawnedNew = false;
    const staleEp = { error: 'porta fixa ocupada', pid: 5, version: VERSION, port: 1 };
    const r = await DC.swapDaemon({
      token: 'tok', endpoint: 'x', expectedVersion: VERSION, pollMs: 1, bootTimeoutMs: 2000,
      sleepFn: async () => {},
      readEndpointFn: () => (spawnedNew ? { port: 7, pid: 9, version: VERSION } : staleEp),
      healthFn: async () => (spawnedNew ? { version: VERSION, pid: 9 } : null),
      connectFn: async (method) => (method === 'hello' && spawnedNew ? { ok: true, result: { packageVersion: VERSION } } : { ok: false }),
      spawnFn: () => { spawnedNew = true; },
    });
    check('erro de http antigo (outro pid) não derruba a troca', r.ok === true && r.pid === 9, r);
  }

  // 8 · SessionStart: daemon velho que ignora o shutdown e não tem handshake é trocado
  {
    const stub = await startStubOldDaemon();
    let swaps = 0;
    const problem = await SS.ensureDaemon({
      swap: async () => { swaps++; await new Promise((r) => stub.close(r)); return { ok: true }; },
    });
    check('ensureDaemon aciona a troca para o daemon sem handshake', swaps === 1, swaps);
    check('depois da troca o ensureDaemon fecha sem problema', problem === null, problem);
    await stopDaemon();

    const stub2 = await startStubOldDaemon();
    const bad = await SS.ensureDaemon({ swap: async () => ({ ok: false, error: 'pid não provado' }) });
    check('troca que falha vira mensagem ao usuário, com o motivo', /não pôde ser trocado: pid não provado/.test(String(bad)), bad);
    await new Promise((r) => stub2.close(r));
  }

  // 9 · tela de setup: o daemon sem http é reiniciado pelo swapDaemon
  {
    const UL = require('../lib/ui-launch.cjs');
    resetLog();
    fs.mkdirSync(path.dirname(DH.httpTokenPath()), { recursive: true });
    const oldPid = startDaemon(DAEMON, { TOKEN_GUARD_TRAY: 'off' });
    const up = await waitFor(async () => { const h = await helloUp(); return h.ok && h; });
    check('daemon sem token sobe sem http', !!up && !DH.readToken(), up);
    const r = await UL.prepare({ bootTimeoutMs: 20000 });
    check('prepare devolve a url da tela', r && r.ok !== false && /^http:\/\/127\.0\.0\.1:\d+\//.test(r.url || ''), r);
    check('o daemon antigo saiu e outro, com http, responde', !alive(oldPid) && !!(await DH.probeHealth(DH.httpPort(), DH.readToken())), { oldPid });
    const lines = logLines();
    const iExit = lines.findIndex((l) => l.event === 'exit' && l.pid === oldPid);
    const iStart = lines.findIndex((l, i) => l.event === 'start' && i > iExit);
    check('o novo só começou depois de o antigo sair', iExit >= 0 && iStart > iExit, lines);
    await stopDaemon();
    fs.rmSync(DH.httpTokenPath(), { force: true });
    fs.rmSync(DH.endpointPath(), { force: true });
  }

  // 10 · bandeja: o script é o mesmo que o ícone antigo roda; se mudar, a troca do ícone precisa existir
  {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'adapters', 'tray.ps1'))).digest('hex');
    check('adapters/tray.ps1 não mudou desde a 2.14.0 (mudou: implemente a troca do ícone antes de seguir)',
      hash === '603acfc85eef9b660edae11b08b4e00a873bf1df0e30897f539c4b5b40021bb9', hash);
  }

  // 11 · desinstalar: o passo do INSTALL.md que encerra o daemon funciona
  {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'INSTALL.md'), 'utf8');
    const m = doc.match(/`(node -e "require\(require\('os'\)\.homedir\(\)\+'\/\.claude\/token-guard\/lib\/daemon-client\.cjs'\)\.shutdownDaemon\(\)")`/);
    check('INSTALL.md traz o comando que encerra o daemon antes de apagar os arquivos', !!m);
    check('INSTALL.md manda fechar o ícone da bandeja', /Fechar o ícone/.test(doc));
    if (m) {
      const pid = startDaemon(DAEMON, { TOKEN_GUARD_TRAY: 'off' });
      await waitFor(async () => (await helloUp()).ok);
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-un-'));
      fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
      fs.cpSync(ROOT, path.join(fakeHome, '.claude', 'token-guard'), { recursive: true, filter: (s) => !/[\\/](\.git|node_modules)([\\/]|$)/.test(s) });
      const cmd = m[1].replace("require('os').homedir()", JSON.stringify(fakeHome.replace(/\\/g, '/')));
      const r = spawnSync(process.execPath, ['-e', cmd.replace(/^node -e "/, '').replace(/"$/, '')], { encoding: 'utf8', env: process.env, timeout: 20000, windowsHide: true });
      const gone = await waitFor(() => !alive(pid), 8000);
      check('o comando do INSTALL.md derruba o daemon', r.status === 0 && !!gone, { status: r.status, err: r.stderr });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }

  // 12 · daemon de pé sem http: o mesmo-versão é reiniciado pela troca; o mais novo não é tocado
  {
    const UL = require('../lib/ui-launch.cjs');
    const port = await freePort();
    const busySockets = new Set();
    const busy = net.createServer((s) => { busySockets.add(s); });
    await new Promise((r) => busy.listen(port, '127.0.0.1', r));
    process.env.TOKEN_GUARD_HTTP_PORT = String(port);
    fs.mkdirSync(path.dirname(DH.httpTokenPath()), { recursive: true });
    fs.writeFileSync(DH.httpTokenPath(), 'tok-followups\n');

    resetLog();
    const samePid = startDaemon(DAEMON, { TOKEN_GUARD_TRAY: 'off' });
    await waitFor(() => logLines().find((l) => l.event === 'http-off'));
    let swaps = 0;
    const same = await SS.ensureDaemon({ swap: async () => { swaps++; return { ok: false, error: 'sem troca no teste' }; } });
    check('daemon da mesma versão sem http é reiniciado por swapDaemon', swaps === 1 && /não pôde ser reiniciado: sem troca no teste/.test(String(same)), { swaps, same });
    await stopDaemon();

    const newer = copyOld('99.0.0');
    resetLog();
    const newerPid = startDaemon(path.join(newer, 'adapters', 'daemon-server.cjs'), { TOKEN_GUARD_TRAY: 'off' });
    await waitFor(() => logLines().find((l) => l.event === 'http-off'));
    swaps = 0;
    const ens = await SS.ensureDaemon({ swap: async () => { swaps++; return { ok: true }; } });
    check('SessionStart não reinicia daemon mais novo sem http', swaps === 0 && /mais novo/.test(String(ens)) && alive(newerPid), { swaps, ens });
    const ui = await UL.prepare({ bootTimeoutMs: 3000 });
    check('a tela de setup não rebaixa daemon mais novo sem http', ui.ok === false && /mais novo/.test(ui.error) && alive(newerPid), ui);
    process.kill(newerPid);
    await waitFor(() => !alive(newerPid), 8000);
    fs.rmSync(newer, { recursive: true, force: true });
    delete process.env.TOKEN_GUARD_HTTP_PORT;
    for (const s of busySockets) s.destroy();
    await new Promise((r) => busy.close(r));
    fs.rmSync(DH.httpTokenPath(), { force: true });
    fs.rmSync(DH.endpointPath(), { force: true });
    check('o daemon da mesma versão saiu', !alive(samePid));
  }

  killAll();
  console.log(`\n  ${pass} ok, ${fail} falha(s)`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  killAll();
  console.error(err);
  process.exit(1);
});
