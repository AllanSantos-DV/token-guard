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

  console.log('\n  [inspectScout]');
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scoutstat-'));
  const sfile = path.join(sdir, 'settings.json');
  const hookCmd = 'node "C:/Users/x/.claude/token-guard/adapters/subagent-start.cjs"';
  fs.writeFileSync(sfile, JSON.stringify({ hooks: { SubagentStart: [{ matcher: '^scout$', hooks: [{ type: 'command', command: hookCmd }] }] } }));
  const noAgent = DS.inspectScout({ settingsFile: sfile });
  check('hook registrado sem agente: veredito aponta o agente que falta', noAgent.hook && !noAgent.agent && /falta agente/.test(noAgent.verdict), noAgent.verdict);
  fs.mkdirSync(path.join(sdir, 'agents'));
  fs.writeFileSync(path.join(sdir, 'agents', 'scout.agent.md'), '---\nname: scout\n---\n');
  const both = DS.inspectScout({ settingsFile: sfile });
  check('hook e agente presentes: veredito completo', both.hook && both.agent && /instalados/.test(both.verdict), both.verdict);
  fs.writeFileSync(sfile, JSON.stringify({ hooks: { SubagentStart: [{ hooks: [{ type: 'command', command: 'node "C:/outro/subagent-start.cjs"' }] }] } }));
  const foreignHook = DS.inspectScout({ settingsFile: sfile });
  check('hook de outro projeto não conta como o do token-guard', !foreignHook.hook && /falta hook SubagentStart/.test(foreignHook.verdict), foreignHook.verdict);
  const none = DS.inspectScout({ settingsFile: path.join(sdir, 'nao-existe.json') });
  check('sem settings: não lança e diz que o hook falta', !none.hook && /hook SubagentStart/.test(none.verdict), none.verdict);
  try { fs.rmSync(sdir, { recursive: true, force: true }); } catch { /* ignore */ }

  console.log('\n  [regras ativas e modo no status]');
  const CFG = require('../lib/config.cjs');
  const defaults = CFG.activeRules({ rules: { broadScan: true, blindRead: true, noisePath: true, shellDump: true } });
  check('status lista bigResult, dupRead e scout, ligados por padrão sem chave na config',
    ['bigResult', 'dupRead', 'scout'].every((r) => defaults.includes(r)), defaults.join(','));
  const offs = CFG.activeRules({ rules: { broadScan: false, blindRead: true, bigResult: 'off', dupRead: 0, scout: 'false' } });
  check('status omite regra desligada com o mesmo teste que a regra usa', offs.join(',') === 'blindRead', offs.join(','));
  check('modo com "warn" aposentado explica a troca', /"warn" foi aposentado/.test(CFG.modeLabel({ mode: 'block', _warnRetired: true })));
  check('modo sem "warn" não acrescenta aviso', CFG.modeLabel({ mode: 'block' }) === 'block');

  console.log('');
  console.log(`  ${pass} passaram · ${fail} falharam`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
