#!/usr/bin/env node
'use strict';
/**
 * harness-of.test.cjs — qual IDE mandou o evento, quando o envelope diz.
 * Hook de comando do Copilot CLI chega em camelCase puro; cair em "claude" aplicaria o
 * modo de bloqueio e o registro do IDE errado.
 */
require('./bootstrap.cjs');
const P = require('../lib/payload.cjs');

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok    ${label}`);
  else { fail += 1; console.log(`  FALHA ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

check('toolCall (VS Code/plugin) é copilot', P.harnessOf({ toolCall: { toolName: 'view', input: {} } }) === 'copilot');
check('camelCase do Copilot CLI (toolName/toolArgs) é copilot', P.harnessOf({ toolName: 'view', toolArgs: '{"path":"a"}', cwd: '/x' }) === 'copilot');
check('camelCase com toolInput (legado) é copilot', P.harnessOf({ toolName: 'view', toolInput: { path: 'a' } }) === 'copilot');
check('Claude Code (tool_name) é claude', P.harnessOf({ tool_name: 'Read', tool_input: {}, hook_event_name: 'PreToolUse' }) === 'claude');
check('tool_name vence toolName', P.harnessOf({ tool_name: 'Read', toolName: 'x' }) === 'claude');
check('payload vazio ou nulo é claude', P.harnessOf({}) === 'claude' && P.harnessOf(null) === 'claude');
check('toolArgs em string JSON vira objeto', P.toolInput({ toolName: 'view', toolArgs: '{"path":"a.js"}' }).path === 'a.js');
check('toolArgs ilegível vira {} (fail-open)', Object.keys(P.toolInput({ toolName: 'view', toolArgs: '{quebrado' })).length === 0);

console.log(fail ? `\n  ${fail} falha(s)` : '\n  harness-of: tudo ok');
process.exit(fail ? 1 : 0);
