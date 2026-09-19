#!/usr/bin/env node
'use strict';
/**
 * selftest.cjs — bateria de casos contra o hook real.
 *
 *   node selftest.cjs
 *
 * Cada caso monta um payload no formato de um runtime diferente, executa
 * token-guard.cjs como processo (exatamente como o harness faz) e confere
 * se a decisão foi a esperada. Sem dependências, sem framework.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const GUARD = path.join(__dirname, 'token-guard.cjs');

const FX = require('./test/fixtures/cases.cjs');
const { CASES, TMP, BIG, SMALL, OUTSIDE, FOLD_CASE } = FX;

function run(payload, env, spawnCwd) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    cwd: spawnCwd,
    timeout: 15000,
  });
  const out = (res.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  try {
    const j = JSON.parse(out);
    return {
      decision: j.hookSpecificOutput?.permissionDecision || 'allow',
      reason: j.hookSpecificOutput?.permissionDecisionReason || '',
    };
  } catch {
    return { decision: 'parse-error', reason: out };
  }
}

const vscode = (toolName, input) => ({ toolCall: { toolName, input }, cwd: TMP });

let pass = 0, fail = 0;
const failures = [];

console.log('\n  token-guard · selftest');
console.log('  ' + '─'.repeat(72));

for (const [expected, label, payload, expectRule] of CASES) {
  const { decision, reason } = run(payload);
  const ok = decision === expected && (!expectRule || reason.includes(expectRule));
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else {
    fail++;
    failures.push({ label, expected, got: decision, expectRule, reason: reason.slice(0, 220) });
    console.log(`  FALHA ${label}  (esperado ${expected}${expectRule ? '/' + expectRule : ''}, obteve ${decision})`);
  }
}

/* escape hatches */
console.log('  ' + '─'.repeat(72));
const off = run(vscode('glob', { pattern: '**/*' }), { TOKEN_GUARD: 'off' });
if (off.decision === 'allow') { pass++; console.log('  ok    TOKEN_GUARD=off libera tudo'); }
else { fail++; failures.push({ label: 'TOKEN_GUARD=off', expected: 'allow', got: off.decision }); console.log('  FALHA TOKEN_GUARD=off'); }

const warn = run(vscode('glob', { pattern: '**/*' }), { TOKEN_GUARD: 'warn' });
if (warn.decision === 'ask') { pass++; console.log('  ok    TOKEN_GUARD=warn vira "ask" e mantém a correção'); }
else { fail++; failures.push({ label: 'TOKEN_GUARD=warn', expected: 'ask', got: warn.decision }); console.log('  FALHA TOKEN_GUARD=warn'); }

/* a mensagem realmente ensina? */
const sample = run(vscode('glob', { pattern: '**/*' }));
const teaches = /DO THIS INSTEAD/.test(sample.reason) && /PT-BR/.test(sample.reason);
if (teaches) { pass++; console.log('  ok    o bloqueio injeta a correção (EN + PT-BR)'); }
else { fail++; failures.push({ label: 'mensagem corretiva', reason: sample.reason.slice(0, 200) }); console.log('  FALHA mensagem corretiva ausente'); }

/* blindRead resolve caminho relativo contra o cwd do PAYLOAD, não o do processo.
   O hook pode ser spawnado de qualquer lugar; o arquivo pertence ao workspace. */
const relName = 'sub-relbig.log';
fs.mkdirSync(path.join(TMP, 'sub'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'sub', relName), 'y'.repeat(120000), 'utf8');
const cwdMiss = run({ tool_name: 'View', tool_input: { path: `sub/${relName}` }, cwd: TMP }, null, os.tmpdir());
if (cwdMiss.decision === 'deny' && /blindRead/.test(cwdMiss.reason)) {
  pass++; console.log('  ok    blindRead resolve relativo contra o cwd do payload');
} else {
  fail++;
  failures.push({ label: 'blindRead cwd relativo', expected: 'deny/blindRead', got: cwdMiss.decision });
  console.log(`  FALHA blindRead cwd relativo (obteve ${cwdMiss.decision})`);
}

console.log('  ' + '─'.repeat(72));
console.log(`  ${pass} passaram · ${fail} falharam\n`);

if (fail) {
  console.log('  DETALHE DAS FALHAS');
  for (const f of failures) console.log('  · ' + JSON.stringify(f, null, 2).replace(/\n/g, '\n    '));
  console.log('');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }
try { if (typeof OUTSIDE !== 'undefined') fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(fail ? 1 : 0);
