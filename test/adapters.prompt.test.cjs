#!/usr/bin/env node
'use strict';
/**
 * adapters.prompt.test.cjs — a injeção do contrato, ponta a ponta.
 *
 * Invariantes: injeta "sempre" UMA vez por sessão; sessões não se misturam;
 * TOKEN_GUARD=off zera; stdin corrompido = silêncio (fail-open).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'adapters', 'prompt-hook.cjs');

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

function run(payload, env) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: payload == null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prompt-'));

console.log('\n  [prompt-hook · user prompt submit]');

{
  const out = run({ cwd: TMP, session_id: 'sess-A', prompt: 'olá' });

  check('primeiro prompt da sessão injeta o contrato',
    Boolean(out?.additionalContext) && /Convenções de saída/.test(out.additionalContext));
  check('injetado como UserPromptSubmit',
    out?.hookEventName === 'UserPromptSubmit');
  check('estado da sessão gravado em disco',
    fs.existsSync(path.join(TMP, '.token-guard', 'sessions', 'sess-A.json')));
}

{
  const out = run({ cwd: TMP, session_id: 'sess-A', prompt: 'de novo' });
  check('segundo prompt NÃO reinjeta (uma vez por sessão)', out === null);
}

{
  const out = run({ cwd: TMP, session_id: 'sess-B', prompt: 'outra sessão' });
  check('sessões não se misturam (B recebe a sua própria)',
    Boolean(out?.additionalContext) && /Convenções de saída/.test(out.additionalContext));
}

{
  const off = run({ cwd: TMP, session_id: 'sess-C' }, { TOKEN_GUARD: 'off' });
  check('TOKEN_GUARD=off zera a injeção', off === null);
}

{
  const bad = run('{{{ não é json');
  check('stdin corrompido sai em silêncio', bad === null);
}

/* Evidência acumulada pelo post-hook muda o que é injetado: sessão que tocou
   código recebe a seção quando:codigo além da "sempre". */
const CT = require(path.join(__dirname, '..', 'lib', 'contract.cjs'));
{
  CT.recordTouched(TMP, 'sess-cod', ['src/BigService.java']);
  const out = run({ cwd: TMP, session_id: 'sess-cod', prompt: 'bora' });
  check('evidência de código injeta a seção codigo junto',
    Boolean(out?.additionalContext) && /Comentário registra invariante/.test(out.additionalContext),
    (out?.additionalContext || '').slice(0, 160));
  check('estado registra sempre+codigo (não reinjeta em nenhum dos dois)',
    run({ cwd: TMP, session_id: 'sess-cod' }) === null);
}

{
  // Sessão sem id do harness: estado derivado da raiz, não compartilhado.
  const out1 = run({ cwd: TMP, prompt: 'sem id' });
  check('sem session_id usa identidade por raiz e injeta',
    Boolean(out1?.additionalContext));
}

{
  const noCwd = run({ session_id: 'sess-D' }); // sem cwd: contexto inválido
  check('sem cwd sai em silêncio (não grava estado no diretório errado)', noCwd === null);
  check('nenhum estado vazio criado fora de sessões reais',
    !fs.existsSync(path.join(TMP, '.token-guard', 'sessions', 'sess-D.json')));
}

console.log('');
console.log(`  ${pass} passaram · ${fail} falharam`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
