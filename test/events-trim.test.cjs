'use strict';
/**
 * events-trim.test.cjs — o trim do events.jsonl não perde o registro que chega durante a poda.
 */
require('./bootstrap.cjs');
const fs = require('fs');
const EV = require('../lib/events.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

console.log('\n  [events trim]');
const file = EV.eventsPath();
fs.mkdirSync(require('path').dirname(file), { recursive: true });
const pad = 'x'.repeat(400);
const lines = [];
for (let i = 0; i < 9000; i++) lines.push(JSON.stringify({ t: 1000 + i, kind: 'deny', rule: 'r' + i, detail: pad }));
fs.writeFileSync(file, lines.join('\n') + '\n');
check('arquivo de teste passa do teto', fs.statSync(file).size > 2 * 1024 * 1024, fs.statSync(file).size);

// registro que chega no meio da poda: o readFileSync do arquivo de trabalho dispara um append concorrente
const realRead = fs.readFileSync;
let injected = false;
fs.readFileSync = function (p, ...rest) {
  if (!injected && String(p).includes('.tg-trim-')) {
    injected = true;
    fs.appendFileSync(file, JSON.stringify({ t: 5000000, kind: 'deny', rule: 'concorrente', detail: 'novo' }) + '\n');
  }
  return realRead.call(this, p, ...rest);
};
const trimmed = EV.trim();
fs.readFileSync = realRead;
check('trim reporta que aparou', trimmed === true && injected, { trimmed, injected });
const all = EV.readAll();
check('o append concorrente sobrevive', all.some((e) => e.rule === 'concorrente'), all.length);
check('o fim do histórico é mantido', all.some((e) => e.rule === 'r8999'), all.length);
check('o começo antigo saiu', !all.some((e) => e.rule === 'r0'));
check('readAll devolve em ordem de tempo', all.every((e, i) => i === 0 || all[i - 1].t <= e.t));
check('arquivo de trabalho removido', fs.readdirSync(require('path').dirname(file)).every((n) => !n.includes('.tg-trim-')));
check('arquivo abaixo do teto não é mexido', EV.trim() === false);

console.log(`\n  events-trim: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
