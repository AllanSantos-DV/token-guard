'use strict';
/**
 * endpoint-write.test.cjs — o daemon registra o endpoint mesmo com outro processo lendo o arquivo.
 *
 * No Windows o rename por cima de um arquivo em leitura falha com EPERM; o daemon e os clientes
 * leem o endpoint o tempo todo, e uma escrita perdida deixava a porta (ou o motivo de o HTTP não
 * ter subido) sem registro.
 */

require('./bootstrap.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const DH = require('../adapters/daemon-http.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-endpoint-write-'));
const file = path.join(dir, 'daemon-http.json');
fs.writeFileSync(file, '{}');

const reader = spawn(process.execPath, ['-e', `
  const fs = require('fs');
  const end = Date.now() + 6000;
  while (Date.now() < end) { try { fs.readFileSync(${JSON.stringify(file)}, 'utf8'); } catch { /* escrita em curso */ } }
`], { stdio: 'ignore', windowsHide: true });

const errors = {};
let writes = 0;
const stop = Date.now() + 2000;
while (Date.now() < stop) {
  try { DH.writeJsonAtomic(file, { port: 1000 + (writes % 1000), pid: process.pid }); writes++; } catch (err) { errors[err.code || err.message] = (errors[err.code || err.message] || 0) + 1; }
}
reader.kill();

check('escreveu várias vezes com um leitor ativo', writes > 20, writes);
check('nenhuma escrita se perdeu por EPERM/EBUSY', Object.keys(errors).length === 0, errors);
check('o arquivo termina com JSON válido', Number.isInteger(JSON.parse(fs.readFileSync(file, 'utf8')).port));
check('não sobra temporário', fs.readdirSync(dir).every((n) => !n.includes('.tg-tmp-')), fs.readdirSync(dir));

(async () => {
  const reader2 = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const end = Date.now() + 4000;
    while (Date.now() < end) { try { fs.readFileSync(${JSON.stringify(file)}, 'utf8'); } catch { /* escrita em curso */ } }
  `], { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => setTimeout(r, 200));

  let worstGap = 0;
  let last = Date.now();
  const beat = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 5);
  let asyncWrites = 0;
  const asyncErrors = {};
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    try { await DH.writeJsonAtomicAsync(file, { port: 2000 + (asyncWrites % 1000), pid: process.pid }); asyncWrites++; } catch (err) { asyncErrors[err.code || err.message] = (asyncErrors[err.code || err.message] || 0) + 1; }
  }
  clearInterval(beat);
  reader2.kill();

  check('a gravação assíncrona escreveu várias vezes com um leitor ativo', asyncWrites >= 3, asyncWrites);
  check('nenhuma gravação assíncrona se perdeu', Object.keys(asyncErrors).length === 0, asyncErrors);
  check('o loop de eventos não ficou parado durante a gravação (pior intervalo < 400 ms)', worstGap < 400, worstGap);
  check('o arquivo termina com JSON válido após a gravação assíncrona', Number.isInteger(JSON.parse(fs.readFileSync(file, 'utf8')).port));
  check('não sobra temporário da gravação assíncrona', fs.readdirSync(dir).every((n) => !n.includes('.tg-tmp-')), fs.readdirSync(dir));

  console.log(`\n  endpoint-write: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
