'use strict';
/**
 * daemon-mcp.test.cjs — o daemon atende o hook mcp_tool do Codex por MCP Streamable HTTP,
 * sem um processo node por conversa.
 *
 * Invariantes:
 *   · sem o token do dono → 401; GET na rota MCP → 405;
 *   · initialize, tools/list e token_guard_hook respondem como o servidor stdio;
 *   · notificação → 202 sem corpo;
 *   · syncCodexConfig reaponta só a url do token-guard no config.toml e preserva o resto.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { TMP } = require('./fixtures/cases.cjs');
const DH = require('../adapters/daemon-http.cjs');
const DS = require('../adapters/daemon-server.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

function request(port, method, body, token) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (data) headers['content-length'] = Buffer.byteLength(data);
    if (token) headers['x-token-guard'] = token;
    const req = http.request({ host: '127.0.0.1', port, path: '/token-guard/mcp', method, headers }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, allow: res.headers.allow, body: out }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.code }));
    req.end(data);
  });
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const hookCall = (id, args) => rpc(id, 'tools/call', { name: 'token_guard_hook', arguments: args });

(async () => {
  console.log('\n  [daemon-mcp · hook mcp_tool do Codex servido pelo daemon]');

  const token = 'tok-' + Math.random().toString(36).slice(2);
  const server = DH.createHttpServer({ token, handle: (msg) => DS.handleMessage(msg, { cache: new Map(), hits: 0, misses: 0, lastActivity: Date.now() }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const noTok = await request(port, 'POST', rpc(1, 'ping'));
    check('sem token → 401', noTok.status === 401, noTok);
    const badTok = await request(port, 'POST', rpc(1, 'ping'), 'outro');
    check('token errado → 401', badTok.status === 401, badTok);

    const get = await request(port, 'GET', undefined, token);
    check('GET na rota MCP → 405 com Allow: POST', get.status === 405 && get.allow === 'POST', get);

    const init = await request(port, 'POST', rpc(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } }), token);
    const initJ = init.status === 200 ? JSON.parse(init.body) : {};
    check('initialize responde serverInfo token-guard em JSON-RPC', initJ.jsonrpc === '2.0' && initJ.id === 1 && initJ.result && initJ.result.serverInfo.name === 'token-guard', init);

    const note = await request(port, 'POST', { jsonrpc: '2.0', method: 'notifications/initialized' }, token);
    check('notificação → 202 sem corpo', note.status === 202 && note.body === '', note);

    const list = await request(port, 'POST', rpc(2, 'tools/list'), token);
    const names = list.status === 200 ? JSON.parse(list.body).result.tools.map((t) => t.name) : [];
    check('tools/list expõe token_guard_hook e as ferramentas do servidor stdio',
      ['token_guard_hook', 'token_guard_check', 'token_audit', 'token_guard_status'].every((n) => names.includes(n)), names);

    const deny = await request(port, 'POST', hookCall(10, { tool_name: 'Bash', tool_input: { command: 'ls -R /' }, cwd: TMP }), token);
    const denyR = deny.status === 200 ? JSON.parse(deny.body).result : null;
    const denyEnv = denyR ? JSON.parse(denyR.content[0].text) : null;
    check('token_guard_hook nega com o envelope de PreToolUse (shellDump)',
      Boolean(denyEnv && denyEnv.hookSpecificOutput.permissionDecision === 'deny' && /shellDump/.test(denyEnv.hookSpecificOutput.permissionDecisionReason)), deny.body.slice(0, 200));
    check('token_guard_hook entrega o mesmo envelope em structuredContent e não marca erro',
      Boolean(denyR && JSON.stringify(denyR.structuredContent) === denyR.content[0].text && denyR.isError === false), denyR);

    const allow = await request(port, 'POST', hookCall(11, { tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: TMP }), token);
    check('token_guard_hook libera com {}', allow.status === 200 && JSON.parse(allow.body).result.content[0].text === '{}', allow);

    const broken = await request(port, 'POST', hookCall(12, { tool_input: {} }), token);
    const brokenR = broken.status === 200 ? JSON.parse(broken.body).result : null;
    check('token_guard_hook com falha começa a saída de erro com a origem declarada',
      Boolean(brokenR && brokenR.isError === true && brokenR.content[0].text.startsWith('[hook-origin=token-guard] ')), broken);

    const batch = await request(port, 'POST', [rpc(20, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, rpc(21, 'ping')], token);
    const batchJ = batch.status === 200 ? JSON.parse(batch.body) : [];
    check('lote responde só às requisições, na ordem', Array.isArray(batchJ) && batchJ.map((m) => m.id).join() === '20,21', batch);

    const bad = await request(port, 'POST', 'texto solto', token);
    check('corpo que não é objeto JSON-RPC → erro -32600 sem derrubar o daemon', bad.status === 200 && JSON.parse(bad.body).error.code === -32600, bad);
  } finally {
    server.close();
  }

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-sync-'));
    const file = path.join(dir, 'config.toml');
    const other = '[mcp_servers.outro]\r\nurl = "http://127.0.0.1:1111/mcp"\r\n';
    const before = `model = "x"\r\n\r\n[mcp_servers.token-guard]\r\nurl = "${DH.mcpUrl(1234)}"\r\nhttp_headers = { "X-Token-Guard" = "abc" }\r\n\r\n${other}`;
    fs.writeFileSync(file, before, 'utf8');
    const moved = DH.syncCodexConfig(5678, file);
    const after = fs.readFileSync(file, 'utf8');
    check('syncCodexConfig reaponta a url do token-guard para a porta nova',
      moved.ok && moved.changed === 1 && after.includes(`url = "${DH.mcpUrl(5678)}"`) && !after.includes(':1234/'), { moved, after });
    check('syncCodexConfig preserva byte a byte o resto (CRLF, header, outro servidor)',
      after === before.replace(':1234/', ':5678/'), after);
    check('syncCodexConfig na porta que já vale não grava', DH.syncCodexConfig(5678, file).changed === 0);
    check('syncCodexConfig sem config.toml é ok e não cria nada',
      DH.syncCodexConfig(5678, path.join(dir, 'nao-existe.toml')).changed === 0 && !fs.existsSync(path.join(dir, 'nao-existe.toml')));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n  daemon-mcp: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
