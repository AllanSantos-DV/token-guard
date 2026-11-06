#!/usr/bin/env node
'use strict';
/**
 * rules-export.test.cjs — o subcaminho público "./rules" expõe hitsNoise e isAllowlisted.
 */
require('./bootstrap.cjs');
const R = require('@allansantos-dev/token-guard/rules');

let fail = 0;
function check(label, ok) {
  if (ok) console.log(`  ok    ${label}`);
  else { fail += 1; console.log(`  FALHA ${label}`); }
}

check('hitsNoise exportado', typeof R.hitsNoise === 'function');
check('isAllowlisted exportado', typeof R.isAllowlisted === 'function');
check('hitsNoise acha o diretório de ruído', R.hitsNoise('a/node_modules/b.js', ['node_modules']) === 'node_modules');
check('hitsNoise devolve null fora do ruído', R.hitsNoise('a/src/b.js', ['node_modules']) === null);
check('isAllowlisted casa o trecho', R.isAllowlisted('a/node_modules/keep/x.js', ['node_modules/keep']) === true);
check('isAllowlisted sem allowlist é false', R.isAllowlisted('a/b.js', []) === false);

console.log(fail ? `\n  ${fail} falha(s)` : '\n  rules-export: tudo ok');
process.exit(fail ? 1 : 0);
