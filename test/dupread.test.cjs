#!/usr/bin/env node
'use strict';
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

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log('');
console.log(`  ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
