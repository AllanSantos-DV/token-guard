'use strict';
/**
 * shell-read-codex.test.cjs — leitura inteira de arquivo grande pelo shell, nos alvos sem corte pós-execução.
 *
 * O Claude Code poda a saída do Bash depois de rodar; o Codex só tem PreToolUse e o evento de shell do
 * Cursor só chega à shellDump. Nesses dois alvos a regra blindRead também julga `cat`, `Get-Content`
 * e afins sem faixa. Garantias:
 *   · alvo codex/cursor: leitura inteira de arquivo grande é deny/blindRead, com a reescrita barata;
 *   · alvo claude ou sem alvo: nada muda (libera);
 *   · formas com teto, arquivo pequeno, regra desligada e alvo desligado liberam.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide } = require('../lib/decide.cjs');
const CFG = require('../lib/config.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shell-read-'));
const BIG = path.join(TMP, 'server.log.txt');
const SMALL = path.join(TMP, 'small.txt');
fs.writeFileSync(BIG, 'x'.repeat(120000), 'utf8');
fs.writeFileSync(SMALL, 'hello\n', 'utf8');

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: TMP });
const english = (r) => String(r).split('\n(PT-BR)')[0];
const writeCfg = (obj) => { fs.writeFileSync(path.join(TMP, 'token-guard.config.json'), JSON.stringify(obj), 'utf8'); CFG.clearMemo(); };
const dropCfg = () => { fs.rmSync(path.join(TMP, 'token-guard.config.json'), { force: true }); CFG.clearMemo(); };

console.log('\n  [codex e cursor: leitura inteira de arquivo grande é barrada]');
const WHOLE = [
  `cat "${BIG}"`,
  `cat -n "${BIG}"`,
  `cat '${BIG}'`,
  `cat server.log.txt`,
  `type "${BIG}"`,
  `Get-Content "${BIG}"`,
  `gc "${BIG}"`,
  `Get-Content -Path "${BIG}" -Raw`,
  `Get-Content -Encoding utf8 "${BIG}"`,
  `sed -n p "${BIG}"`,
  `sed -n '1,$p' "${BIG}"`,
  `LC_ALL=C cat "${BIG}"`,
  `cat "${SMALL}" "${BIG}"`,
  `echo go && cat "${BIG}"`,
];
for (const target of ['codex', 'cursor']) {
  for (const command of WHOLE) {
    const v = decide(bash(command), { target });
    check(`${target}: ${command.slice(0, 40)} nega com blindRead`, v && v.decision === 'deny' && v.rule === 'blindRead', v);
  }
}

console.log('\n  [claude e sem alvo: idêntico, libera]');
for (const opts of [{ target: 'claude' }, {}, undefined, { target: 'copilot' }, { target: 'mcp' }]) {
  const tag = opts && opts.target ? opts.target : 'sem alvo';
  for (const command of [`cat "${BIG}"`, `Get-Content "${BIG}"`]) {
    check(`${tag}: ${command.slice(0, 30)} libera`, decide(bash(command), opts) === null);
  }
}

console.log('\n  [formas com teto continuam liberadas]');
const CAPPED = [
  `cat "${BIG}" | head -50`,
  `cat "${BIG}" | tail -n 50`,
  `cat "${BIG}" | grep -n foo`,
  `cat "${BIG}" > "${path.join(TMP, 'copy.txt')}"`,
  `head -n 50 "${BIG}"`,
  `head "${BIG}"`,
  `tail -n 50 "${BIG}"`,
  `sed -n '1,40p' "${BIG}"`,
  `sed -n '/foo/p' "${BIG}"`,
  `Get-Content "${BIG}" -TotalCount 50`,
  `Get-Content "${BIG}" -Tail 50`,
  `Get-Content -Path "${BIG}" -Head 50`,
  `Get-Content "${BIG}" | Select-Object -First 50`,
  `gc "${BIG}" | Select-String foo`,
  `type "${BIG}" | more`,
  `cat "${SMALL}"`,
  `Get-Content "${SMALL}"`,
  `cat "${path.join(TMP, 'nao-existe.txt')}"`,
  `cat *.txt`,
  `cat $FILE`,
];
for (const target of ['codex', 'cursor']) {
  for (const command of CAPPED) {
    const v = decide(bash(command), { target });
    check(`${target}: ${command.slice(0, 40)} libera`, v === null, v && v.reason.slice(0, 120));
  }
}

console.log('\n  [a recusa ensina e a reescrita passa pelo guard]');
for (const command of [`cat "${BIG}"`, `Get-Content "${BIG}"`, `type server.log.txt`]) {
  const v = decide(bash(command), { target: 'codex' });
  const en = english(v && v.reason);
  check(`${command.slice(0, 30)}: razão em inglês e PT-BR`, v && /\(PT-BR\)/.test(v.reason) && /blindRead/.test(en), en.slice(0, 200));
  check(`${command.slice(0, 30)}: traz DO THIS INSTEAD`, /DO THIS INSTEAD/.test(en), en.slice(0, 200));
  const advice = en.split('DO THIS INSTEAD')[1] || '';
  const rewrites = [...advice.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  check(`${command.slice(0, 30)}: sugere ao menos dois comandos`, rewrites.length >= 2, advice.slice(0, 300));
  for (const r of rewrites) {
    check(`${command.slice(0, 30)} → \`${r}\` não é recusado de novo`, decide(bash(r), { target: 'codex' }) === null, r);
  }
}

console.log('\n  [o usuário desliga: regra blindRead e alvo]');
writeCfg({ rules: { blindRead: false } });
check('regra blindRead desligada: codex libera', decide(bash(`cat "${BIG}"`), { target: 'codex' }) === null);
check('regra blindRead desligada: cursor libera', decide(bash(`cat "${BIG}"`), { target: 'cursor' }) === null);
writeCfg({ targets: { codex: 'off' } });
check('alvo codex desligado: codex libera', decide(bash(`cat "${BIG}"`), { target: 'codex' }) === null);
check('alvo codex desligado: cursor segue barrando', (decide(bash(`cat "${BIG}"`), { target: 'cursor' }) || {}).rule === 'blindRead');
writeCfg({ mode: 'off' });
check('mode off: codex libera', decide(bash(`cat "${BIG}"`), { target: 'codex' }) === null);
writeCfg({ allowlist: ['server.log'] });
check('allowlist: codex libera', decide(bash(`cat "${BIG}"`), { target: 'codex' }) === null);
dropCfg();
check('config removida: volta a barrar', (decide(bash(`cat "${BIG}"`), { target: 'codex' }) || {}).rule === 'blindRead');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n  shell-read-codex: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
