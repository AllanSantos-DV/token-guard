#!/usr/bin/env node
'use strict';
/**
 * ctxwatch.test.cjs — aviso de peso de contexto: lê o uso do transcript, avisa
 * por degrau (uma vez), rearma após compactação, vai em systemMessage, e o
 * hook de comando entrega ponta a ponta. Fail-open em transcript ausente/ruim.
 */

require('./bootstrap.cjs');

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CW = require('../lib/ctxwatch.cjs');
const H = require('../lib/claude-hooks.cjs');

const HOOK = path.join(__dirname, '..', 'adapters', 'prompt-hook.cjs');
let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ctxwatch-'));
const tpath = path.join(tmp, 't.jsonl');
function turn(tokens, model = 'claude-opus-5-5', extra = {}) {
  return JSON.stringify({
    type: 'assistant', ...extra,
    message: { model, usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10, cache_creation_input_tokens: 0, output_tokens: 5 } },
  });
}
function write(...lines) { fs.writeFileSync(tpath, `${lines.join('\n')}\n`); }
const args = { root: tmp, sessionId: 's1', transcriptPath: tpath };

write(turn(50000));
check('abaixo do limite: sem aviso', CW.check(args) === null);

write(turn(50000), turn(130000));
const first = CW.check(args);
check('cruzou 120k: avisa com tamanho e custo', /~130k/.test(first || '') && /US\$ 0\.07/.test(first), String(first));
check('mesmo degrau: não repete', CW.check(args) === null);

write(turn(130000), turn(200000));
check('degrau seguinte: avisa de novo', /~200k/.test(CW.check(args) || ''));

write(turn(200000), turn(30000));
check('compactou: sem aviso, rearma', CW.check(args) === null);
write(turn(30000), turn(125000));
check('depois de compactar, 120k avisa de novo', CW.check(args) !== null);

write(turn(300000, 'claude-opus-5-5', { isSidechain: true }), turn(40000));
check('ignora sidechain (subagente)', CW.check({ ...args, sessionId: 's2' }) === null);

check('transcript inexistente: fail-open', CW.check({ ...args, transcriptPath: path.join(tmp, 'nao-existe') }) === null);
fs.writeFileSync(tpath, 'lixo{{\n"usage"\n');
check('transcript corrompido: fail-open', CW.check({ ...args, sessionId: 's3' }) === null);
check('modelo desconhecido: avisa sem custo', !/US\$/.test(CW.check({ ...args, sessionId: 's4', transcriptPath: (write(turn(150000, 'x-y')), tpath) }) || 'US$'));

check('envelope: warning vira systemMessage, sem additionalContext', (() => {
  const e = H.promptEnvelope('', 'aviso');
  return e.systemMessage === 'aviso' && !e.hookSpecificOutput;
})());
check('envelope: texto do contrato segue igual', H.promptEnvelope('c').hookSpecificOutput.additionalContext === 'c' && H.promptEnvelope('') === null);

// ponta a ponta pelo hook de comando
write(turn(180000));
const r = spawnSync(process.execPath, [HOOK], {
  input: JSON.stringify({ cwd: tmp, session_id: 'e2e', transcript_path: tpath, prompt: 'oi' }),
  encoding: 'utf8', env: { ...process.env, TOKEN_GUARD_DAEMON: 'off' },
});
let out = null;
try { out = JSON.parse(r.stdout); } catch { /* checado abaixo */ }
check('hook de comando entrega systemMessage', out && /~180k/.test(out.systemMessage || ''), r.stdout + r.stderr);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} ok, ${fail} falha(s)`);
process.exit(fail ? 1 : 0);
