#!/usr/bin/env node
'use strict';
/**
 * adapters.post.test.cjs — o adapter PostToolUse contra processo real.
 *
 * Prova o contrato ponta a ponta: stdin JSON do Claude Code → stdout
 * hookSpecificOutput, com silêncio como fail-open.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POST = path.join(__dirname, '..', 'adapters', 'post-hook.cjs');

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

function run(payload) {
  const res = spawnSync(process.execPath, [POST], {
    input: payload == null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
  });
  const out = (res.stdout || '').trim();
  if (!out) return null;
  try {
    return JSON.parse(out).hookSpecificOutput || {};
  } catch {
    return { __parseError: out };
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-post-adapter-'));
fs.mkdirSync(path.join(TMP, '.token-guard'), { recursive: true });
fs.writeFileSync(path.join(TMP, '.token-guard', 'repo-stats.json'),
  JSON.stringify({ totalFiles: 215112, pathChars: 215112 * 125 }));

console.log('\n  [post-hook · claude code]');

{
  const out = run({
    cwd: TMP,
    tool_name: 'Grep',
    tool_input: { pattern: 'TODO', output_mode: 'content' },
    tool_response: 'match '.repeat(6000), // ~36 KB
  });

  check('saída gigante gera additionalContext',
    Boolean(out?.additionalContext) && /bigResult/.test(out.additionalContext),
    JSON.stringify(out).slice(0, 200));
  check('aviso aponta a versão integral em .token-guard/results/',
    /results/.test(out.additionalContext));
  check('dica da família grep presente', /files_with_matches|head_limit/.test(out.additionalContext));

  // O integral foi parar no disco dentro do repo-fixture?
  const dir = path.join(TMP, '.token-guard', 'results');
  check('integral gravado no repositório-alvo',
    fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.txt')));
}

{
  const out = run({ cwd: TMP, tool_name: 'View', tool_input: {}, tool_response: 'curto' });
  check('resultado pequeno sai em silêncio', out === null);
}

{
  const out = run({ cwd: TMP }); // sem tool_response
  check('payload sem resultado sai em silêncio (fail-open)', out === null);
}

{
  const out = run('não é json {{{');
  check('stdin corrompido sai em silêncio', out === null);
}

{
  const res = run({ cwd: TMP, tool_name: 'Bash', tool_response: 'x'.repeat(40000) });
  check('exit code 0 mesmo truncando (nunca derruba a sessão)', res !== undefined);
}

console.log('');
console.log(`  ${pass} passaram · ${fail} falharam`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
