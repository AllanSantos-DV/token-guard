'use strict';
/**
 * contract-compaction.test.cjs — o contrato volta depois que a janela o perde.
 *
 * O contrato é injetado uma vez por sessão (estado `injected`). Compactar ou
 * limpar apaga o texto da janela, mas o estado seguiria dizendo "já injetado":
 * as sessões longas, que mais precisam, ficariam sem contrato. O SessionStart
 * com source compact/clear zera `injected`; no resume o histórico volta inteiro,
 * então nada muda. A evidência (-touched) vive em disco e sobrevive.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const CT = require('../lib/contract.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

const ADAPTERS = path.join(__dirname, '..', 'adapters');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-compact-'));
const ENV = { ...process.env, TOKEN_GUARD_UPDATE_CHECK: 'off' };

function run(file, payload) {
  return spawnSync(process.execPath, [path.join(ADAPTERS, file)], {
    input: JSON.stringify({ cwd: ROOT, ...payload }), encoding: 'utf8', timeout: 30000, env: ENV,
  });
}
const prompt = (sid) => run('prompt-hook.cjs', { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'oi' });
const injected = (r) => {
  try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext || ''; } catch { return ''; }
};
const start = (sid, source) => run('session-start.cjs', { hook_event_name: 'SessionStart', session_id: sid, source });
const stateFile = (sid) => path.join(ROOT, '.token-guard', 'sessions', `${sid}.json`);

console.log('\n  [contrato × compactação]');

for (const source of ['compact', 'clear']) {
  const sid = `s-${source}`;
  const first = injected(prompt(sid));
  check(`${source}: 1º prompt injeta o contrato`, first.length > 0, first);
  check(`${source}: 2º prompt não reinjeta`, injected(prompt(sid)) === '');
  start(sid, source);
  check(`${source}: depois do evento o contrato volta`, injected(prompt(sid)) === first);
  check(`${source}: e só uma vez`, injected(prompt(sid)) === '');
}

{
  const sid = 's-resume';
  injected(prompt(sid));
  start(sid, 'resume');
  check('resume: histórico volta com o contrato, não reinjeta', injected(prompt(sid)) === '');
  start(sid, 'startup');
  check('startup não mexe no estado', injected(prompt(sid)) === '');
}

{
  const sid = 's-twice';
  const first = injected(prompt(sid));
  start(sid, 'compact');
  const second = injected(prompt(sid));
  start(sid, 'compact');
  check('duas compactações seguidas reinjetam nas duas', second === first && injected(prompt(sid)) === first);
}

{
  const sid = 's-evidence';
  CT.recordTouched(ROOT, sid, ['lib/x.cjs']);
  injected(prompt(sid));
  start(sid, 'compact');
  check('evidência em disco sobrevive à compactação', CT.readTouched(ROOT, sid).includes('lib/x.cjs'), CT.readTouched(ROOT, sid));
}

{
  const sid = 's-never-injected';
  start(sid, 'compact');
  check('sessão sem estado não ganha arquivo', !fs.existsSync(stateFile(sid)));
}

{
  const sid = 's-no-sid-field';
  const r = run('session-start.cjs', { hook_event_name: 'SessionStart', source: 'compact' });
  check('payload sem session_id não quebra o hook', r.status === 0, r.stderr);
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n  contrato × compactação: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
