#!/usr/bin/env node
'use strict';
/**
 * dupread-subagent.test.cjs — o stub de releitura só vale na janela que já leu o arquivo.
 *
 * O subagente divide o `session_id` com o pai mas tem janela própria: o stub "idêntico à leitura
 * anterior, que está acima na conversa" entregue a ele aponta para um contexto que ele nunca viu
 * (A35, 4 de 4 scouts da medição). O hook traz `agent_id` quando a chamada é de um subagente.
 * Ponta a ponta no hook de comando (processo real); o caminho do daemon tem paridade em
 * test/daemon-postprocess-parity.test.cjs.
 */

require('./bootstrap.cjs');

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POST = path.join(__dirname, '..', 'adapters', 'post-hook.cjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dup-sub-'));
const FILE = path.join(TMP, 'big.md');
const BODY = 'linha de conteudo estavel\n'.repeat(200); // > MIN_DUP_CHARS

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}

function read(sessionId, agentId) {
  const payload = {
    cwd: TMP, session_id: sessionId, tool_name: 'Read',
    tool_input: { file_path: FILE }, tool_response: BODY,
  };
  if (agentId) { payload.agent_id = agentId; payload.agent_type = 'scout'; }
  const res = spawnSync(process.execPath, [POST], { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15000 });
  const out = (res.stdout || '').trim();
  if (!out) return null;
  try { return JSON.parse(out).hookSpecificOutput || {}; } catch { return { __parseError: out }; }
}
const isStub = (o) => Boolean(o && /\[dupRead\]/.test(`${o.additionalContext || ''}${typeof o.updatedToolOutput === 'string' ? o.updatedToolOutput : ''}`));

console.log('\n  [dupRead · janela do subagente]');

const S = `sess-${process.pid}`;
check('agente principal: 1ª leitura passa', !isStub(read(S)));
check('agente principal: releitura idêntica vira stub (a economia segue)', isStub(read(S)));
check('subagente: 1ª leitura, com o pai já tendo lido, NÃO recebe stub', !isStub(read(S, 'agent-A')));
check('subagente: releitura na própria janela vira stub', isStub(read(S, 'agent-A')));
check('outro subagente: 1ª leitura NÃO recebe stub', !isStub(read(S, 'agent-B')));
check('agente principal continua com o stub depois das leituras dos filhos', isStub(read(S)));

const S2 = `sess2-${process.pid}`;
check('subagente lê primeiro, pai depois: a leitura do pai NÃO recebe stub', !isStub(read(S2, 'agent-C')) && !isStub(read(S2)));

{
  // Caminho do daemon (hook http e RPC): mesma regra, via dispatchPostprocess.
  const { dispatchPostprocess } = require('../adapters/daemon-server.cjs');
  const S3 = `sess3-${process.pid}`;
  const call = (agentId) => dispatchPostprocess({
    name: 'Read', input: { file_path: FILE }, result: BODY, root: TMP, sessionId: S3, agentId,
  }).trimmed;
  check('daemon: pai lê, depois relê → stub', !call() && Boolean(call()));
  check('daemon: subagente lê o mesmo arquivo → sem stub', !call('agent-D'));
  check('daemon: subagente relê → stub', Boolean(call('agent-D')));
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* resto de tmp */ }
console.log(`\n  dupread-subagente: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
