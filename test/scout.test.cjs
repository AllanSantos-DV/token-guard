#!/usr/bin/env node
'use strict';
/**
 * scout.test.cjs — rajada de leitura sugere o scout, uma vez por rajada (A27).
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const SC = require('../lib/scout.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scout-'));
fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(root, '.claude', 'agents', 'scout.agent.md'), '---\nname: scout\n---\n', 'utf8');
const cfg = (limit) => ({ rules: { scout: true }, limits: limit ? { scoutBurst: limit } : {} });
let seq = 0;
const call = (sid, name, input, c) => SC.note({ name, input: input || {}, root, sessionId: sid, cfg: c || cfg(4) });
const reads = (sid, n, c) => Array.from({ length: n }, () => call(sid, 'Read', { file_path: `f${++seq}.js` }, c));

console.log('\n  [rajada]');
{
  const r = reads('s1', 6);
  check('avisa na chamada que completa a rajada (4ª), não antes nem depois',
    r.map((x) => Boolean(x)).join() === 'false,false,false,true,false,false');
  check('o aviso cita o scout e a contagem', /scout/.test(r[3].additionalContext) && /4 leituras/.test(r[3].additionalContext));
}
{
  reads('s2', 4);
  call('s2', 'Edit', { file_path: 'a.js' });
  const r = reads('s2', 4);
  check('edição zera: a rajada seguinte avisa de novo', Boolean(r[3]) && !r[2]);
}
{
  reads('s3', 3);
  call('s3', 'Bash', { command: 'npm test' });
  const r = reads('s3', 3);
  check('Bash que não é leitura zera a rajada', r.every((x) => x === null));
}
{
  const r = [
    call('s4', 'Bash', { command: 'git log --oneline | head -5' }),
    call('s4', 'Grep', { pattern: 'x' }),
    call('s4', 'Glob', { pattern: '**/*.cjs' }),
    call('s4', 'mcp__smart-tool__smart_search', { query_identifiers: 'x' }),
  ];
  check('Bash de leitura, Grep, Glob e smart_search contam na mesma rajada', Boolean(r[3]) && !r[2]);
}
{
  const r = [call('s5', 'Read', {}), call('s5', 'mcp__x__outra', {}), call('s5', 'Read', {}), call('s5', 'Read', {}), call('s5', 'Read', {})];
  check('ferramenta fora da lista não conta nem zera', Boolean(r[4]) && !r[3]);
}

console.log('\n  [config e fail-open]');
{
  const off = reads('s6', 6, { rules: { scout: false }, limits: { scoutBurst: 2 } });
  check('rules.scout=false desliga', off.every((x) => x === null));
  const dflt = reads('s7', SC.DEFAULT_BURST, { rules: {}, limits: {} });
  check(`limiar default é ${SC.DEFAULT_BURST}`, Boolean(dflt[SC.DEFAULT_BURST - 1]) && !dflt[SC.DEFAULT_BURST - 2]);
  const junk = reads('s8', SC.DEFAULT_BURST, { rules: {}, limits: { scoutBurst: 'abc' } });
  check('limiar inválido cai no default', Boolean(junk[SC.DEFAULT_BURST - 1]));
  check('sem sessionId não faz nada', SC.note({ name: 'Read', input: {}, root, cfg: cfg(1) }) === null);
  check('root impossível não lança', SC.note({ name: 'Read', input: {}, root: '\0:/x', sessionId: 'z', cfg: cfg(1) }) === null);
}

console.log('\n  [agente instalado]');
{
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scout-bare-'));
  const noAgent = Array.from({ length: 4 }, (_, i) => SC.note({ name: 'Read', input: { file_path: `g${i}.js` }, root: bare, sessionId: 's10', cfg: cfg(4) }));
  check('sem scout instalado em nenhuma pasta, a rajada não sugere um agente que não existe', noAgent.every((x) => x === null));
  fs.mkdirSync(path.join(bare, '.github', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(bare, '.github', 'agents', 'scout.agent.md'), 'x', 'utf8');
  const withAgent = SC.note({ name: 'Read', input: { file_path: 'g9.js' }, root: bare, sessionId: 's10', cfg: cfg(4) });
  check('scout em .github/agents (Copilot) basta, e a rajada que já passou do limiar avisa', Boolean(withAgent));
  fs.rmSync(bare, { recursive: true, force: true });
}

console.log('\n  [withBurst]');
{
  const base = { modifiedResult: 'x', additionalContext: 'A' };
  reads('s9', 3);
  const m = SC.withBurst(base, { name: 'Read', input: {}, root, sessionId: 's9', cfg: cfg(4) });
  check('soma o aviso ao pós-processamento existente sem perder o resultado',
    m.modifiedResult === 'x' && m.additionalContext.startsWith('A\n[token-guard/scout]'));
  check('sem aviso devolve o original', SC.withBurst(base, { name: 'Read', input: {}, root, sessionId: 's9', cfg: cfg(4) }) === base);
}

console.log('');
console.log(`  ${pass} passaram · ${fail} falharam`);
try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
