'use strict';
/**
 * contract-ownership.test.cjs — cada regra tem um dono só e chega uma vez.
 *
 * Falha quando: uma regra é entregue duas vezes na mesma janela (por qualquer
 * caminho: hook de comando, hook http do daemon), a mesma regra mora em duas
 * seções, o padrão volta a carregar regra de comentário (dona: a instrução global
 * do usuário), `contract.skip` não cala a seção, ou a injeção some do registro.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const CFG = require('../lib/config.cjs');
const CT = require('../lib/contract.cjs');
const DS = require('../adapters/daemon-server.cjs');
const DH = require('../adapters/daemon-http.cjs');

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok    ${label}`);
  else { fail += 1; console.log(`  FALHA ${label}${detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
}

const ADAPTERS = path.join(__dirname, '..', 'adapters');
const ENV = { ...process.env, TOKEN_GUARD_UPDATE_CHECK: 'off' };
const mkroot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tg-owner-'));

function run(file, root, payload) {
  return spawnSync(process.execPath, [path.join(ADAPTERS, file)], {
    input: JSON.stringify({ cwd: root, ...payload }), encoding: 'utf8', timeout: 30000, env: ENV,
  });
}
const viaCommand = (root, sid) => {
  const r = run('prompt-hook.cjs', root, { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'oi' });
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
};
const handle = (m) => DS.handleMessage(m, { cache: new Map(), hits: 0, misses: 0 });
const viaDaemon = (root, sid) => {
  const out = DH.answer('prompt', { cwd: root, session_id: sid, prompt: 'oi' }, handle);
  return (out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext) || '';
};
const rulesOf = (text) => text.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
const start = (root, sid, source) => run('session-start.cjs', root, { hook_event_name: 'SessionStart', session_id: sid, source });
const log = () => {
  try { return fs.readFileSync(CT.injectionLogPath(), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};

console.log('\n  [dono único por regra]');

{
  const c = CT.parse(fs.readFileSync(path.join(__dirname, '..', 'contract.default.md'), 'utf8'));
  const all = Object.values(c.rules).flat();
  check('nenhuma regra repetida entre seções do padrão', new Set(all).size === all.length);
  check('o padrão não carrega regra de comentário (dona: instrução global do usuário)',
    !all.some((r) => /coment[aá]rio/i.test(r)), all.filter((r) => /coment[aá]rio/i.test(r)));
}

for (const [name, via] of [['hook de comando', viaCommand], ['hook http do daemon', viaDaemon]]) {
  const root = mkroot();
  const sid = `s-${name.length}`;
  const seen = [];
  const take = (t) => { seen.push(...rulesOf(t)); return t; };

  take(via(root, sid));
  CT.recordTouched(root, sid, ['src/a.js', 'test/a.test.js', 'docs/a.md']);
  take(via(root, sid));
  take(via(root, sid));
  check(`${name}: nenhuma regra chega duas vezes na mesma janela`, new Set(seen).size === seen.length, seen.length);
  check(`${name}: sempre + código + teste + docs entraram`, seen.length >= 4);

  const before = seen.length;
  start(root, sid, 'compact');
  take(via(root, sid));
  take(via(root, sid));
  check(`${name}: após compactar volta o mesmo conjunto, uma vez`, seen.length === before * 2 && new Set(seen).size === before, seen.length);
}

{
  const root = mkroot();
  fs.writeFileSync(path.join(root, 'token-guard.config.json'), JSON.stringify({ contract: { skip: ['codigo', ' Docs '] } }), 'utf8');
  CFG.clearMemo();
  const c = CT.load(root);
  check('contract.skip tira as seções do contrato', !c.order.includes('codigo') && !c.order.includes('docs') && c.order.includes('sempre') && c.order.includes('teste'), c.order);
  CT.recordTouched(root, 'sk', ['src/a.js', 'docs/a.md', 'test/a.test.js']);
  const text = viaCommand(root, 'sk');
  const defaults = CT.parse(fs.readFileSync(path.join(__dirname, '..', 'contract.default.md'), 'utf8'));
  check('seção pulada não é injetada, as demais seguem',
    !rulesOf(text).some((r) => defaults.rules.codigo.includes(r)) && rulesOf(text).some((r) => defaults.rules.teste.includes(r)), text.slice(0, 200));
}

{
  const root = mkroot();
  const sid = 's-log';
  const text = viaCommand(root, sid);
  start(root, sid, 'clear');
  viaCommand(root, sid);
  const mine = log().filter((e) => e.session === sid);
  check('cada injeção é registrada com origem, seções e tamanho',
    mine.length === 2 && mine.every((e) => e.origin === 'token-guard' && e.sections.length && e.chars > 0 && e.tokens > 0), mine);
  check('o registro distingue início de reinjeção', mine[0].reason === 'inicio' && mine[1].reason === 'clear', mine.map((e) => e.reason));
  check('o tamanho registrado é o do texto entregue', mine[0].chars === text.length, [mine[0].chars, text.length]);
}

console.log(fail ? `\n${fail} falha(s)` : '\ntudo ok');
process.exit(fail ? 1 : 0);
