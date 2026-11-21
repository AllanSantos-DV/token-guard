'use strict';
/**
 * prune.test.cjs — a poda de estado velho roda no máximo uma vez por hora por pasta e não custa
 * um stat por arquivo a cada gravação de sessão.
 */

require('./bootstrap.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneOlder, pruneOlderIfDue } = require('../lib/prune.cjs');
const CT = require('../lib/contract.cjs');
const { stateDir } = require('../lib/statedir.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prune-'));
const age = (file, ms) => { const t = (Date.now() - ms) / 1000; fs.utimesSync(file, t, t); };
const seed = (name, ms) => { const f = path.join(dir, name); fs.writeFileSync(f, '{}'); age(f, ms); return f; };

const old1 = seed('velho1.json', 8 * DAY);
const fresh = seed('novo.json', 1000);
pruneOlder(dir, 7 * DAY);
check('pruneOlder apaga o velho e mantém o novo', !fs.existsSync(old1) && fs.existsSync(fresh));

const old2 = seed('velho2.json', 8 * DAY);
pruneOlderIfDue(dir, 7 * DAY);
check('primeira poda do dia apaga o velho', !fs.existsSync(old2));

const old3 = seed('velho3.json', 8 * DAY);
pruneOlderIfDue(dir, 7 * DAY);
check('segunda chamada dentro da hora não varre a pasta', fs.existsSync(old3));

age(path.join(dir, '.pruned'), 2 * HOUR);
pruneOlderIfDue(dir, 7 * DAY);
check('passada a hora, varre de novo', !fs.existsSync(old3));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prune-state-'));
const stale = path.join(stateDir(root, 'sess-a'), 'sessions', 'antiga.json');
fs.mkdirSync(path.dirname(stale), { recursive: true });
fs.writeFileSync(stale, '{}');
age(stale, 8 * DAY);
CT.writeState(root, 'sess-a', { injected: ['x'] });
check('writeState poda a sessão velha na primeira gravação', !fs.existsSync(stale));

console.log(`\n  prune: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
