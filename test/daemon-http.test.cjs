'use strict';
/**
 * daemon-http.test.cjs — hook http do Claude Code servido pelo daemon (A16).
 *
 * Invariantes:
 *   · sem o token do usuário (ou com outro) → 401, nada é decidido;
 *   · /token-guard/pre devolve o MESMO JSON que o hook de comando imprime;
 *   · nada a dizer → `{}` (o Claude Code trata como "sem objeção");
 *   · /token-guard/post e /token-guard/prompt seguem o contrato dos adapters de comando;
 *   · daemon real com token abre o HTTP; sem token, não abre porta nenhuma.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { CASES, TMP, BIG } = require('./fixtures/cases.cjs');
const DH = require('../adapters/daemon-http.cjs');
const DS = require('../adapters/daemon-server.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

function post(port, route, body, token) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) };
    if (token) headers['x-token-guard'] = token;
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.code }));
    req.end(data);
  });
}

const HOOK_CMD = path.join(__dirname, '..', 'adapters', 'hook-cmd.cjs');
const denyPayload = CASES.find(([, , , rule]) => rule === 'broadScan')[2];
const claudeDeny = { tool_name: 'Read', tool_input: { file_path: BIG }, cwd: TMP, session_id: 'http-t' };

(async () => {
  console.log('\n  [daemon-http · hook http do Claude Code]');

  check('porta estável e fora da faixa privilegiada',
    DH.httpPort() === DH.httpPort() && DH.httpPort() >= 1024 && DH.httpPort() < 65536, DH.httpPort());

  const token = 'tok-' + Math.random().toString(36).slice(2);
  const server = DH.createHttpServer({ token, handle: (msg) => DS.handleMessage(msg, { cache: new Map(), hits: 0, misses: 0, lastActivity: Date.now() }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const noTok = await post(port, '/token-guard/pre', claudeDeny);
    check('sem token → 401', noTok.status === 401, noTok);
    const badTok = await post(port, '/token-guard/pre', claudeDeny, 'outro');
    check('token errado → 401', badTok.status === 401, badTok);

    const viaHttp = await post(port, '/token-guard/pre', claudeDeny, token);
    const viaCmd = spawnSync(process.execPath, [HOOK_CMD], { input: JSON.stringify(claudeDeny), encoding: 'utf8' });
    check('/token-guard/pre nega com o envelope de PreToolUse',
      viaHttp.status === 200 && JSON.parse(viaHttp.body).hookSpecificOutput.permissionDecision === 'deny', viaHttp);
    check('/token-guard/pre devolve o MESMO JSON do hook de comando', viaHttp.body === viaCmd.stdout,
      { http: viaHttp.body.slice(0, 120), cmd: viaCmd.stdout.slice(0, 120) });

    const deny2 = await post(port, '/token-guard/pre', denyPayload, token);
    check('/token-guard/pre cobre também o formato VS Code do payload', /broadScan/.test(deny2.body), deny2);

    const allow = await post(port, '/token-guard/pre', { tool_name: 'Read', tool_input: { file_path: BIG, offset: 1, limit: 20 }, cwd: TMP }, token);
    check('caso liberado → {}', allow.status === 200 && allow.body === '{}', allow);

    const big = await post(port, '/token-guard/post', { tool_name: 'Grep', tool_input: {}, tool_response: 'g'.repeat(60000), cwd: TMP, session_id: 'http-t' }, token);
    const bigJ = big.status === 200 ? JSON.parse(big.body) : {};
    check('/token-guard/post devolve o envelope de PostToolUse do bigResult',
      bigJ.hookSpecificOutput && bigJ.hookSpecificOutput.hookEventName === 'PostToolUse' &&
      /bigResult/.test(bigJ.hookSpecificOutput.additionalContext), big.body.slice(0, 200));

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-http-prompt-'));
    fs.writeFileSync(path.join(root, 'contract.md'), '## sempre\n\n- Regra sempre http.\n', 'utf8');
    const p1 = await post(port, '/token-guard/prompt', { prompt: 'oi', cwd: root, session_id: 'http-p' }, token);
    const p2 = await post(port, '/token-guard/prompt', { prompt: 'de novo', cwd: root, session_id: 'http-p' }, token);
    check('/token-guard/prompt injeta o contrato "sempre" na 1ª submissão',
      p1.status === 200 && /Regra sempre http/.test(p1.body), p1);
    check('/token-guard/prompt não reinjeta na mesma sessão (estado persistido)', p2.body === '{}', p2);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* noop */ }

    const nf = await post(port, '/token-guard/outra', claudeDeny, token);
    check('rota desconhecida → 404', nf.status === 404, nf);
  } finally {
    server.close();
  }

  // Daemon real: com token no perfil abre o HTTP na porta configurada; sem token, não.
  {
    const DAEMON = path.join(__dirname, '..', 'adapters', 'daemon-server.cjs');
    const tokenFile = DH.httpTokenPath();
    const httpPort = 40000 + Math.floor(Math.random() * 5000);
    const run = async (withToken) => {
      if (withToken) { fs.mkdirSync(path.dirname(tokenFile), { recursive: true }); fs.writeFileSync(tokenFile, token); }
      else fs.rmSync(tokenFile, { force: true });
      const sid = `http-live-${withToken ? 'on' : 'off'}-${process.pid}`;
      const child = spawn(process.execPath, [DAEMON], {
        env: { ...process.env, TOKEN_GUARD_SID: sid, TOKEN_GUARD_HTTP_PORT: String(httpPort) }, stdio: 'ignore',
      });
      let res = { status: 0 };
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 75));
        res = await post(httpPort, '/token-guard/pre', claudeDeny, token);
        if (res.status) break;
      }
      try { child.kill(); } catch { /* noop */ }
      await new Promise((r) => setTimeout(r, 150));
      return res;
    };
    const on = await run(true);
    check('daemon real com token: HTTP de pé e negando', on.status === 200 && /"deny"/.test(on.body), on);
    const off = await run(false);
    check('daemon real sem token: nenhuma porta aberta', off.status === 0, off);
  }

  // A17: o SessionStart (um processo por SESSÃO) deixa o daemon de pé, na
  // versão certa e com o HTTP ligado ANTES da primeira ferramenta — a 1ª
  // chamada não paga bring-up, e o hook http não cai em conexão recusada.
  {
    const SESSION = path.join(__dirname, '..', 'adapters', 'session-start.cjs');
    const DAEMON = path.join(__dirname, '..', 'adapters', 'daemon-server.cjs');
    const { shutdownDaemon } = require('../lib/daemon-client.cjs');
    const tokenFile = DH.httpTokenPath();
    const httpPort = 45000 + Math.floor(Math.random() * 4000);
    const sid = `http-session-${process.pid}`;
    const env = { ...process.env, TOKEN_GUARD_SID: sid, TOKEN_GUARD_HTTP_PORT: String(httpPort) };
    const withEnv = (fn) => { const saved = { ...process.env }; Object.assign(process.env, env); try { return fn(); } finally { process.env = saved; } };
    const endpoint = withEnv(() => DS.defaultEndpoint());

    // Daemon que subiu ANTES de existir token: está de pé, mas sem HTTP.
    fs.rmSync(tokenFile, { force: true });
    const early = spawn(process.execPath, [DAEMON], { env, stdio: 'ignore', detached: true });
    early.unref();
    await new Promise((r) => setTimeout(r, 600));
    fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
    fs.writeFileSync(tokenFile, token);
    const before = await post(httpPort, '/token-guard/pre', claudeDeny, token);

    const t0 = Date.now();
    const ss = spawnSync(process.execPath, [SESSION], { input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: TMP }), env, encoding: 'utf8', timeout: 15000 });
    const took = Date.now() - t0;
    const after = await post(httpPort, '/token-guard/pre', claudeDeny, token);
    check('pré-condição: daemon antigo sem HTTP', before.status === 0, before);
    check('SessionStart sai limpo (exit 0, sem saída para o modelo)', ss.status === 0 && ss.stdout === '', { status: ss.status, out: ss.stdout, err: ss.stderr });
    check('SessionStart deixa o HTTP de pé (reinicia o daemon que não tinha token)',
      after.status === 200 && /"deny"/.test(after.body), after);
    check('SessionStart termina em tempo de sessão (< 8 s)', took < 8000, took);

    await withEnv(() => shutdownDaemon ? shutdownDaemon(endpoint) : null);
    try { process.kill(early.pid); } catch { /* já saiu */ }
  }

  console.log(`\n  daemon-http: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
