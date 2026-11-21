'use strict';
/**
 * authorship.test.cjs — os manifestos e a licença creditam o autor pelo nome, sem e-mail,
 * caminho local de usuário nem nome de máquina.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AUTHOR = 'Allan Santos';

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const pkg = JSON.parse(read('package.json'));
const plugin = JSON.parse(read('plugin.json'));
const authorName = (a) => (typeof a === 'string' ? a : a && a.name);

check('package.json: author é o nome do autor', authorName(pkg.author) === AUTHOR, pkg.author);
check('plugin.json: author.name é o nome do autor', authorName(plugin.author) === AUTHOR, plugin.author);
check('LICENSE: copyright no nome do autor', new RegExp(`^Copyright \\(c\\) \\d{4} ${AUTHOR}$`, 'm').test(read('LICENSE')));

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const LOCAL_PATH = /[A-Za-z]:\\Users\\|\/Users\/|\/home\/[a-z]/i;
for (const f of ['package.json', 'plugin.json', 'LICENSE']) {
  const text = read(f);
  check(`${f}: sem e-mail`, !EMAIL.test(text));
  check(`${f}: sem caminho local de usuário`, !LOCAL_PATH.test(text));
}

console.log(`\n  authorship: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
