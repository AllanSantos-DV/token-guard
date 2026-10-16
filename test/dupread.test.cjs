#!/usr/bin/env node
'use strict';
require('./bootstrap.cjs');

const fs = require('fs'), os = require('os'), path = require('path');
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FALHA ${label}${detail ? '\n        ' + detail : ''}`); }
}

let DR;
try { DR = require(path.join(__dirname, '..', 'lib', 'dupread.cjs')); }
catch (e) { console.log(`  FALHA módulo: ${e.message.split('\n')[0]}`); process.exit(1); }

function cfg(o) { return Object.assign({ mode: 'block', rules: { dupRead: true }, limits: {} }, o || {}); }
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dup-'));

// A1
{
  const inp = { file_path: path.join(TMP, 'a.js') };
  const big = 'x'.repeat(3000);
  const r1 = DR.noteResult({ name: 'Read', input: inp, result: big, root: TMP, sessionId: 's1', cfg: cfg() });
  const r2 = DR.noteResult({ name: 'Read', input: inp, result: big, root: TMP, sessionId: 's1', cfg: cfg() });
  check('A1a: primeira leitura retorna null', r1 === null);
  check('A1b: segunda idêntica é duplicata com savedChars', Boolean(r2) && r2.duplicate === true && r2.savedChars === 3000);
}

// A2
{
  fs.writeFileSync(path.join(TMP, 'RelDup.js'), 'q'.repeat(1500));
  const a = DR.noteResult({ name: 'View', input: { path: 'RelDup.js' }, result: 'q'.repeat(1500), root: TMP, sessionId: 'rel', cfg: cfg() });
  const b = DR.noteResult({ name: 'View', input: { path: path.join(TMP, 'RelDup.js') }, result: 'q'.repeat(1500), root: TMP, sessionId: 'rel', cfg: cfg() });
  check('A2: relativo e absoluto do mesmo arquivo colidem', a === null && b !== null);
}

// A3
{
  const o1 = DR.noteResult({ name: 'View', input: {}, result: 'x'.repeat(5000), root: TMP, sessionId: 'o1', cfg: { rules: { dupRead: false }, limits: {} } });
  const o2 = DR.noteResult({ name: 'View', input: {}, result: 'x'.repeat(5000), root: TMP, sessionId: 'o2', cfg: { rules: { dupRead: 'false' }, limits: {} } });
  check('A3: dupRead OFF boolean e string retornam null', o1 === null && o2 === null);
}

// A4
{
  let threw = false;
  let r = 'sentinel';
  try {
    const c = {}; c.self = c;
    r = DR.noteResult({ name: 'View', input: {}, result: c, root: TMP, sessionId: 'circ', cfg: cfg() });
  } catch (e) { threw = true; }
  check('A4: objeto circular → null sem throw', !threw && r === null);
}

console.log('\n  [camada B · checkRepeat]');

{
  const bp = path.join(TMP, 'Huge.java');
  fs.writeFileSync(bp, 'h'.repeat(60000));
  DR.noteResult({ name: 'Read', input: { file_path: bp }, result: 'h'.repeat(60000), root: TMP, sessionId: 'rep', cfg: cfg() });
  const hint = DR.checkRepeat({ name: 'View', input: { file_path: bp }, root: TMP, sessionId: 'rep', cfg: cfg() });
  check('B1: origem lida + arquivo grande → hint com sizeBytes e path',
    Boolean(hint) && hint.sizeBytes >= 60000 && Boolean(hint.path), JSON.stringify(hint));
}

{
  const sp = path.join(TMP, 'tiny.js');
  fs.writeFileSync(sp, 'hi');
  const s = DR.checkRepeat({ name: 'View', input: { file_path: sp }, root: TMP, sessionId: 'smallsess', cfg: cfg() });
  check('B2: arquivo pequeno nunca lido → null',
    s === null || s.repeat !== true, JSON.stringify(s));
}

{
  const osess = DR.checkRepeat({ name: 'View', input: { file_path: path.join(TMP, 'Huge.java') }, root: TMP, sessionId: 'outra-sess', cfg: cfg() });
  check('B3: sessão sem mapa anterior → sem hint de duplicata',
    osess === null || osess.repeat !== true, JSON.stringify(osess));
}

// A23 — a duplicata chega ao modelo (updatedToolOutput), no formato do Claude Code
{
  const inp = { file_path: path.join(TMP, 'Big.cjs') };
  const body = 'linha\n'.repeat(1000);
  const res = () => ({ type: 'text', file: { filePath: inp.file_path, content: body, numLines: 1000, totalLines: 1000 } });
  const a = { name: 'Read', input: inp, root: TMP, sessionId: 'a23', cfg: cfg() };
  const r1 = DR.dedupe({ ...a, result: res() });
  const r2 = DR.dedupe({ ...a, result: res() });
  check('A23a: primeira leitura (objeto do Claude Code) não é substituída', r1 === null);
  check('A23b: releitura idêntica vira stub mantendo o formato do objeto',
    Boolean(r2) && r2.modifiedResult.type === 'text' && r2.modifiedResult.file.filePath === inp.file_path &&
    r2.modifiedResult.file.content.startsWith('[dupRead]') && r2.modifiedResult.file.content.length < 600,
    JSON.stringify(r2 && r2.modifiedResult).slice(0, 200));
  check('A23c: o stub ensina a recuperar (offset/limit)', /offset\/limit/.test(r2.additionalContext));
  const changed = DR.dedupe({ ...a, result: { ...res(), file: { ...res().file, content: body + 'nova\n' } } });
  check('A23d: conteúdo alterado não é duplicata', changed === null);
  const small = { file_path: path.join(TMP, 'Small.cjs') };
  DR.dedupe({ ...a, input: small, result: 'pouco' });
  check('A23e: leitura pequena repetida não é substituída (stub custaria o mesmo)',
    DR.dedupe({ ...a, input: small, result: 'pouco' }) === null);
  DR.resetSession(TMP, 'a23');
  check('A23f: após compactação (resetSession) a releitura não vira stub',
    DR.dedupe({ ...a, result: res() }) === null);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('');
console.log(`  ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
