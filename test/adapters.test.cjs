#!/usr/bin/env node
'use strict';
/**
 * adapters.test.cjs — bateria dos adapters.
 *
 * O núcleo já tem selftest.cjs (27 casos contra o hook real). Aqui testamos
 * apenas o que cada adapter acrescenta: a TRADUÇÃO de envelope e de veredito.
 * Se um teste daqui falhar, o bug está no adapter — nunca em lib/.
 *
 * Node puro, sem framework, pelo mesmo motivo do resto do projeto: zero deps.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const CURSOR = path.join(ROOT, 'adapters', 'cursor-hook.cjs');
const MCP = path.join(ROOT, 'adapters', 'mcp-server.cjs');

/* Repositório sintético: grande o bastante para os guards não relaxarem. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-adapters-'));
const BIG = path.join(TMP, 'BigService.java');
fs.writeFileSync(BIG, 'x'.repeat(120 * 1024), 'utf8');
fs.mkdirSync(path.join(TMP, '.token-guard'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, '.token-guard', 'repo-stats.json'),
  JSON.stringify({ totalFiles: 5000, totalBytes: 50e6, totalTokens: 12e6 }),
  'utf8'
);

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function runJson(script, payload, env) {
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  const out = (res.stdout || '').trim();
  try {
    return out ? JSON.parse(out) : null;
  } catch {
    return { _unparsed: out };
  }
}

/* ================================================================== */
/* Cursor                                                             */
/* ================================================================== */

console.log('');
console.log('  token-guard · adapters');
console.log('  ' + '─'.repeat(72));
console.log('  [cursor]');

{
  const r = runJson(CURSOR, {
    hook_event_name: 'beforeReadFile',
    file_path: BIG,
    workspace_roots: [TMP],
  });
  check('beforeReadFile de arquivo grande é negado',
    r && r.permission === 'deny', JSON.stringify(r));
  check('o deny carrega a correção para o agente',
    Boolean(r && typeof r.agentMessage === 'string' && r.agentMessage.length > 20),
    JSON.stringify(r));
}

{
  const r = runJson(CURSOR, {
    hook_event_name: 'beforeReadFile',
    file_path: path.join(TMP, 'node_modules', 'left-pad', 'index.js'),
    workspace_roots: [TMP],
  });
  check('beforeReadFile em node_modules é negado', r && r.permission === 'deny', JSON.stringify(r));
}

{
  const r = runJson(CURSOR, {
    hook_event_name: 'beforeShellExecution',
    command: 'ls -R /',
    cwd: TMP,
  });
  check('beforeShellExecution com dump de árvore é negado',
    r && r.permission === 'deny', JSON.stringify(r));
}

/* preToolUse genérico (Cursor recente): a via que devolve broadScan ao Cursor.
   Regressão do gate 2.2.1 — a alegação do README não tinha NENHUM teste. */
{
  const r = runJson(CURSOR, {
    hook_event_name: 'preToolUse',
    tool_name: 'Grep',
    tool_input: { pattern: 'TODO', output_mode: 'content' },
    cwd: TMP,
  });
  check('preToolUse genérico nega broadScan (Cursor recente)',
    r && r.permission === 'deny' && /broadScan/.test(r.agentMessage || ''), JSON.stringify(r));

  const ok = runJson(CURSOR, {
    hook_event_name: 'preToolUse',
    tool_name: 'Grep',
    tool_input: { pattern: 'TODO', output_mode: 'content', head_limit: 40 },
    cwd: TMP,
  });
  check('preToolUse genérico passa chamada barata', ok && ok.permission === 'allow', JSON.stringify(ok));

  const noise = runJson(CURSOR, {
    hook_event_name: 'preToolUse',
    tool_name: 'Read',
    tool_input: { path: path.join(TMP, 'target', 'x.class') },
    cwd: TMP,
  });
  check('preToolUse genérico nega noisePath', noise && noise.permission === 'deny', JSON.stringify(noise));
}

{
  const r = runJson(CURSOR, {
    hook_event_name: 'beforeShellExecution',
    command: 'git status --short',
    cwd: TMP,
  });
  check('comando barato é liberado', r && r.permission === 'allow', JSON.stringify(r));
}

{
  const r = runJson(CURSOR, {
    hook_event_name: 'beforeMCPExecution',
    tool_name: 'grep',
    tool_input: { pattern: 'TODO', output_mode: 'content' },
    workspace_roots: [TMP],
  });
  check('beforeMCPExecution repassa a ferramenta ao núcleo',
    r && (r.permission === 'deny' || r.permission === 'ask'), JSON.stringify(r));
}

{
  const r = runJson(CURSOR, { hook_event_name: 'afterFileEdit', file_path: BIG });
  check('evento fora de escopo é liberado', r && r.permission === 'allow', JSON.stringify(r));
}

{
  const r = runJson(CURSOR, { hook_event_name: 'beforeReadFile' }); // sem file_path
  check('payload incompleto não trava nem nega', r && r.permission === 'allow', JSON.stringify(r));
}

{
  const r = runJson(CURSOR, {
    hook_event_name: 'beforeReadFile',
    file_path: BIG,
    workspace_roots: [TMP],
  }, { TOKEN_GUARD: 'off' });
  check('TOKEN_GUARD=off libera tudo', r && r.permission === 'allow', JSON.stringify(r));
}

{
  const r = runJson(CURSOR, {
    hook_event_name: 'beforeReadFile',
    file_path: BIG,
    workspace_roots: [TMP],
  }, { TOKEN_GUARD: 'warn' });
  check('TOKEN_GUARD=warn vira "ask", não "deny"',
    r && r.permission === 'ask', JSON.stringify(r));
}

{
  // O Cursor é fail-closed por padrão; nós precisamos ser explicitamente fail-open.
  const res = spawnSync(process.execPath, [CURSOR], { input: 'isto não é json', encoding: 'utf8' });
  let ok = false;
  try { ok = JSON.parse((res.stdout || '').trim()).permission === 'allow'; } catch { ok = false; }
  check('entrada corrompida ainda produz allow explícito', ok, res.stdout);
}

/* ================================================================== */
/* MCP                                                                */
/* ================================================================== */

console.log('');
console.log('  [mcp]');

/** Fala JSON-RPC com o servidor: envia N mensagens, lê N respostas. */
function mcp(messages) {
  const res = spawnSync(process.execPath, [MCP], {
    input: messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    encoding: 'utf8',
    cwd: TMP,
  });
  return (res.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return { _unparsed: l }; }
    });
}

{
  const [init] = mcp([{ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }]);
  check('initialize responde com serverInfo',
    init && init.result && init.result.serverInfo && init.result.serverInfo.name === 'token-guard',
    JSON.stringify(init));
  check('initialize anuncia capacidade de tools',
    Boolean(init && init.result && init.result.capabilities && init.result.capabilities.tools),
    JSON.stringify(init));
}

{
  const out = mcp([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  const list = out.find((m) => m.id === 2);
  const names = list && list.result ? list.result.tools.map((t) => t.name) : [];
  check('notificação não gera resposta', out.length === 2, JSON.stringify(out.map((m) => m.id)));
  check('tools/list expõe as três ferramentas',
    ['token_audit', 'token_guard_status', 'token_guard_check'].every((n) => names.includes(n)),
    names.join(', '));
  check('toda ferramenta declara inputSchema',
    Boolean(list && list.result && list.result.tools.every((t) => t.inputSchema && t.inputSchema.type === 'object')),
    JSON.stringify(names));
}

{
  const out = mcp([{
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'token_guard_check', arguments: { tool: 'view', input: { path: BIG }, path: TMP } },
  }]);
  const text = out[0] && out[0].result ? out[0].result.content[0].text : '';
  check('token_guard_check reprova leitura cega de arquivo grande',
    text.includes('EVITE') && text.includes('blindRead'), text.slice(0, 160));
}

{
  const out = mcp([{
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'token_guard_check', arguments: { tool: 'view', input: { path: BIG, view_range: [1, 40] }, path: TMP } },
  }]);
  const text = out[0] && out[0].result ? out[0].result.content[0].text : '';
  check('token_guard_check aprova leitura com faixa', text.startsWith('OK'), text.slice(0, 160));
}

{
  const out = mcp([{
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'token_guard_status', arguments: { path: TMP } },
  }]);
  const text = out[0] && out[0].result ? out[0].result.content[0].text : '';
  check('token_guard_status informa modo e transporte',
    text.includes('modo:') && text.includes('MCP'), text.slice(0, 160));
}

{
  const out = mcp([{
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'token_audit', arguments: { path: TMP, format: 'json' } },
  }]);
  const text = out[0] && out[0].result ? out[0].result.content[0].text : '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* fica null */ }
  check('token_audit devolve JSON medindo o repositório',
    Boolean(parsed && typeof parsed.totalFiles === 'number'), text.slice(0, 160));
}

{
  const out = mcp([{
    jsonrpc: '2.0', id: 7, method: 'tools/call',
    params: { name: 'nao_existe', arguments: {} },
  }]);
  check('ferramenta desconhecida vira erro JSON-RPC, não crash',
    Boolean(out[0] && out[0].error && out[0].error.code === -32602), JSON.stringify(out[0]));
}

{
  const out = mcp([
    { jsonrpc: '2.0', id: 8, method: 'metodo/inexistente' },
    { jsonrpc: '2.0', id: 9, method: 'ping' },
  ]);
  check('método desconhecido responde -32601 e o servidor segue vivo',
    Boolean(out[0] && out[0].error && out[0].error.code === -32601 && out[1] && out[1].result),
    JSON.stringify(out));
}

{
  const res = spawnSync(process.execPath, [MCP], { input: 'lixo\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n', encoding: 'utf8' });
  const lines = (res.stdout || '').split('\n').filter((l) => l.trim());
  check('linha corrompida é ignorada sem derrubar o servidor', lines.length === 1, res.stdout);
}

/* ================================================================== */

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* melhor esforço */ }

console.log('  ' + '─'.repeat(72));
console.log(`  ${pass} passaram · ${fail} falharam`);
console.log('');
process.exit(fail ? 1 : 0);
