'use strict';
/**
 * daemon-http-port.test.cjs — porta dinâmica do hook http (nada preso no endpoint antigo).
 *
 * Invariantes:
 *   · ordem de bind: preferida → última registrada → livre; fixada por env: só ela;
 *   · o daemon grava onde subiu (daemon-http.json) e reaponta os hooks http do
 *     token-guard no settings.json do Claude Code — só esses, só se mudou;
 *   · daemon que volta com a porta anterior ocupada sobe em outra e o
 *     settings.json acompanha; o SessionStart corrige settings.json defasado;
 *   · porta fixa ocupada: HTTP desligado com motivo registrado e o SessionStart
 *     avisa o usuário (systemMessage), em vez de seguir calado.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const net = require('net');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { TMP, BIG } = require('./fixtures/cases.cjs');
const DH = require('../adapters/daemon-http.cjs');

const DAEMON = path.join(__dirname, '..', 'adapters', 'daemon-server.cjs');
const SESSION = path.join(__dirname, '..', 'adapters', 'session-start.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, body, token) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/token-guard/pre', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-token-guard': token },
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.code }));
    req.end(data);
  });
}

/** Ocupa `port` (0 = qualquer); se já estiver ocupada por outro, devolve null — ocupada do mesmo jeito. */
function block(port) {
  return new Promise((resolve) => {
    const s = net.createServer((sock) => sock.on('error', () => {}));
    s.once('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

function freePort() {
  return block(0).then((s) => { const p = s.address().port; return new Promise((r) => s.close(() => r(p))); });
}

const claudeDeny = { tool_name: 'Read', tool_input: { file_path: BIG }, cwd: TMP, session_id: 'port-t' };
const settingsFile = DH.claudeSettingsPath();

function writeSettings(port) {
  const tg = (route) => ({ type: 'http', url: `http://127.0.0.1:${port}/token-guard/${route}`, headers: { 'X-Token-Guard': 'x' }, timeout: 10 });
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({
    theme: 'dark',
    hooks: {
      PreToolUse: [{ matcher: 'Read', hooks: [tg('pre'), { type: 'http', url: `http://127.0.0.1:${port}/outro/pre` }] }],
      PostToolUse: [{ hooks: [tg('post')] }],
      UserPromptSubmit: [{ hooks: [tg('prompt'), { type: 'command', command: 'echo oi' }] }],
    },
  }, null, 2));
}

function tgPorts() {
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  return [s.hooks.PreToolUse[0].hooks[0].url, s.hooks.PostToolUse[0].hooks[0].url, s.hooks.UserPromptSubmit[0].hooks[0].url]
    .map((u) => Number(/:(\d+)\//.exec(u)[1]));
}

async function waitEndpoint(pred) {
  for (let i = 0; i < 60; i++) {
    const e = DH.readEndpoint();
    if (e && pred(e)) return e;
    await sleep(100);
  }
  return DH.readEndpoint();
}

function startDaemon(sid, extraEnv) {
  return spawn(process.execPath, [DAEMON], { env: { ...process.env, TOKEN_GUARD_SID: sid, ...(extraEnv || {}) }, stdio: 'ignore' });
}

async function stop(child) {
  try { child.kill(); } catch { /* já saiu */ }
  await sleep(250);
}

(async () => {
  console.log('\n  [daemon-http · porta dinâmica e reapontamento do Claude Code]');
  const savedFixed = process.env.TOKEN_GUARD_HTTP_PORT;
  delete process.env.TOKEN_GUARD_HTTP_PORT;

  // 1 · ordem de candidatos
  fs.rmSync(DH.endpointPath(), { force: true });
  check('sem registro: preferida e depois livre', JSON.stringify(DH.candidatePorts()) === JSON.stringify([DH.defaultPort(), 0]), DH.candidatePorts());
  DH.writeJsonAtomic(DH.endpointPath(), { port: 45678 });
  check('com registro: preferida, registrada, livre',
    JSON.stringify(DH.candidatePorts()) === JSON.stringify([DH.defaultPort(), 45678, 0]), DH.candidatePorts());
  check('clientes usam a porta registrada', DH.httpPort() === 45678, DH.httpPort());
  process.env.TOKEN_GUARD_HTTP_PORT = '45999';
  check('porta fixada: só ela', JSON.stringify(DH.candidatePorts()) === '[45999]' && DH.httpPort() === 45999, DH.candidatePorts());
  delete process.env.TOKEN_GUARD_HTTP_PORT;
  fs.rmSync(DH.endpointPath(), { force: true });

  // 2 · bind com fallback
  {
    const busy = await block(0);
    const busyPort = busy.address().port;
    const s1 = http.createServer();
    const got = await DH.listenFirstFree(s1, [busyPort, 0]);
    check('porta ocupada → cai na próxima candidata', got !== busyPort && got > 0, got);
    s1.close();
    const s2 = http.createServer();
    const err = await DH.listenFirstFree(s2, [busyPort]).then(() => null, (e) => e);
    check('só candidata ocupada → rejeita com EADDRINUSE', err && err.code === 'EADDRINUSE', err && err.code);
    busy.close();
  }

  // 3 · reapontamento do settings.json
  {
    writeSettings(41111);
    const r = DH.syncClaudeSettings(42222);
    const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    check('reaponta os 3 hooks http do token-guard', r.ok && r.changed === 3 && tgPorts().every((p) => p === 42222), { r, ports: tgPorts() });
    check('preserva hook http forasteiro, hook de comando e outras chaves',
      s.hooks.PreToolUse[0].hooks[1].url === 'http://127.0.0.1:41111/outro/pre' &&
      s.hooks.UserPromptSubmit[0].hooks[1].command === 'echo oi' && s.theme === 'dark', s);
    const before = fs.readFileSync(settingsFile, 'utf8');
    const again = DH.syncClaudeSettings(42222);
    check('porta igual → não regrava', again.ok && again.changed === 0 && fs.readFileSync(settingsFile, 'utf8') === before, again);
    fs.writeFileSync(settingsFile, '{ quebrado');
    const bad = DH.syncClaudeSettings(43333);
    check('JSON inválido → erro explícito, arquivo intocado', !bad.ok && /JSON/.test(bad.error) && fs.readFileSync(settingsFile, 'utf8') === '{ quebrado', bad);
    fs.rmSync(settingsFile, { force: true });
    const none = DH.syncClaudeSettings(43333);
    check('sem settings.json → nada a fazer, sem criar arquivo', none.ok && none.changed === 0 && !fs.existsSync(settingsFile), none);
  }

  // 4 · daemon real: troca de porta acompanhada pelo settings.json
  const token = 'tok-' + Math.random().toString(36).slice(2);
  fs.mkdirSync(path.dirname(DH.httpTokenPath()), { recursive: true });
  fs.writeFileSync(DH.httpTokenPath(), token);
  const sid = `http-port-${process.pid}`;
  const defaultBlocker = await block(DH.defaultPort()); // null = já ocupada (ex.: daemon real da máquina)
  const recorded = await freePort();
  DH.writeJsonAtomic(DH.endpointPath(), { port: recorded });
  writeSettings(DH.defaultPort());

  let d = startDaemon(sid);
  let ep = await waitEndpoint((e) => e.pid === d.pid);
  check('preferida ocupada → sobe na última registrada', ep && ep.port === recorded && !ep.error, ep);
  check('settings.json reapontado para a porta registrada', tgPorts().every((p) => p === recorded), tgPorts());
  let res = await post(recorded, claudeDeny, token);
  check('hook http responde na porta nova', res.status === 200 && /"deny"/.test(res.body), res);
  await stop(d);

  const recordedBlocker = await block(recorded);
  d = startDaemon(sid);
  ep = await waitEndpoint((e) => e.pid === d.pid);
  const moved = ep && ep.port;
  check('daemon volta com a porta anterior ocupada → sobe em outra livre', moved && moved !== recorded && moved !== DH.defaultPort() && !ep.error, ep);
  check('settings.json acompanha a porta nova (sessão aberta segue o daemon)', tgPorts().every((p) => p === moved), tgPorts());
  res = await post(moved, claudeDeny, token);
  check('hook http responde depois da troca', res.status === 200 && /"deny"/.test(res.body), res);

  // SessionStart corrige settings.json defasado (ex.: atualização feita à mão)
  writeSettings(recorded);
  const ss = spawnSync(process.execPath, [SESSION], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: TMP }),
    env: { ...process.env, TOKEN_GUARD_SID: sid }, encoding: 'utf8', timeout: 15000,
  });
  check('SessionStart sai limpo com o daemon de pé', ss.status === 0 && ss.stdout === '', { status: ss.status, out: ss.stdout, err: ss.stderr });
  check('SessionStart reaponta settings.json defasado', tgPorts().every((p) => p === moved), tgPorts());
  await stop(d);

  // 5 · porta fixa ocupada: fail-loud
  {
    writeSettings(recorded);
    const fixedEnv = { TOKEN_GUARD_HTTP_PORT: String(recorded) };
    d = startDaemon(sid, fixedEnv);
    ep = await waitEndpoint((e) => e.pid === d.pid);
    check('porta fixa ocupada → HTTP desligado com o motivo registrado', ep && /porta fixa/.test(ep.error || ''), ep);
    const loud = spawnSync(process.execPath, [SESSION], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: TMP }),
      env: { ...process.env, TOKEN_GUARD_SID: sid, ...fixedEnv }, encoding: 'utf8', timeout: 20000,
    });
    let msg = '';
    try { msg = JSON.parse(loud.stdout).systemMessage; } catch { /* checado abaixo */ }
    check('SessionStart avisa o usuário (systemMessage) em vez de calar', loud.status === 0 && /hook http desligado/.test(msg) && /porta fixa/.test(msg), loud.stdout);
    check('settings.json não é tocado quando o HTTP não subiu', tgPorts().every((p) => p === recorded), tgPorts());
    await stop(d);
  }

  recordedBlocker && recordedBlocker.close();
  defaultBlocker && defaultBlocker.close();
  if (savedFixed !== undefined) process.env.TOKEN_GUARD_HTTP_PORT = savedFixed;

  console.log(`\n  daemon-http-port: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
