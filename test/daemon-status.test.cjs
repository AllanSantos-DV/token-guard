#!/usr/bin/env node
'use strict';
/**
 * daemon-status.test.cjs — `token-guard status` diz POR QUE o hook http não bloqueia.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const DS = require('../lib/daemon-status.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve({ s, port: s.address().port }));
  });
}

async function main() {
  console.log('\n  [probeHealth]');
  const good = await serve((req, res) => {
    res.writeHead(req.headers['x-token-guard'] === 'tok' ? 200 : 401); res.end('{}');
  });
  check('daemon com o token certo: ok', (await DS.probeHealth(good.port, 'tok')).state === 'ok');
  check('token divergente: state token', (await DS.probeHealth(good.port, 'outro')).state === 'token');
  const foreign = await serve((req, res) => { res.writeHead(404); res.end(); });
  check('forasteiro na porta: state foreign', (await DS.probeHealth(foreign.port, 'tok')).state === 'foreign');
  const freePort = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  check('porta sem ninguém: state down', (await DS.probeHealth(freePort, 'tok')).state === 'down');
  good.s.close(); foreign.s.close();

  console.log('\n  [registeredPorts / inspect]');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dstatus-'));
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ hooks: {
    PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:43210/token-guard/pre' }, { type: 'command', command: 'x' }] }],
    PostToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:43210/token-guard/post' }, { type: 'http', url: 'http://outro/hook' }] }],
  } }));
  check('lê só as portas dos hooks http do token-guard', JSON.stringify(DS.registeredPorts(file).ports) === '[43210]');
  check('settings ausente: sem portas, sem erro', DS.registeredPorts(path.join(dir, 'nao-existe.json')).ports.length === 0 &&
    !DS.registeredPorts(path.join(dir, 'nao-existe.json')).error);
  fs.writeFileSync(file, '{ quebrado');
  check('settings ilegível: erro visível', Boolean(DS.registeredPorts(file).error));

  const empty = path.join(dir, 'vazio.json');
  fs.writeFileSync(empty, '{}');
  const r = await DS.inspect({ settingsFile: empty });
  check('inspect sem hook http registrado: veredito diz isso', /sem hook http registrado/.test(r.verdict), r.verdict);
  fs.writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'http', url: 'http://127.0.0.1:1/token-guard/pre' }] }] } }));
  const r2 = await DS.inspect({ settingsFile: file });
  check('inspect com porta divergente: veredito aponta as duas portas', /aponta para 1 .* usa \d+/.test(r2.verdict), r2.verdict);

  console.log('');
  console.log(`  ${pass} passaram · ${fail} falharam`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
