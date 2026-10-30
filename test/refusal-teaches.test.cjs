'use strict';
/**
 * refusal-teaches.test.cjs — a recusa educa o agente e nunca pergunta ao usuário.
 *
 * O usuário sempre confirma um `ask`, então perguntar não treina ninguém; quem
 * educa é o deny com a reescrita pronta. Garantias:
 *   · toda recusa de toda regra é `deny` — em block, em "warn" (aposentado: config
 *     e env) — e nenhuma linha do código emite `ask`;
 *   · o texto traz "DO THIS INSTEAD" com algo executável (comando entre crases ou
 *     chamada de ferramenta com argumentos);
 *   · o comando alternativo que a recusa sugere passa pelo próprio guard (a recusa
 *     que manda fazer o que ela mesma nega foi a classe de falso positivo nº 1).
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CASES, TMP, BIG, BIG_ZIP, cleanup } = require('./fixtures/cases.cjs');
const { decide } = require('../lib/decide.cjs');
const CFG = require('../lib/config.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`);
}

const claude = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: TMP });
const english = (r) => String(r).split('\n(PT-BR)')[0];
/** Algo que o agente executa: comando entre crases ou chamada de ferramenta com argumentos. */
const EXECUTABLE = /`[^`]+`|(?:Grep|Glob|Read)\s+(?:pattern|file_path)=|pages: "/;

console.log('\n  [toda recusa é deny com reescrita executável]');

const EXTRA = [
  ['node_modules (dependência)', claude('Read', { file_path: path.join(TMP, 'node_modules', 'pkg', 'index.js') })],
  ['vendor (dependência)', claude('Read', { file_path: path.join(TMP, 'vendor', 'lib', 'x.php') })],
  ['.git (controle de versão)', claude('Read', { file_path: path.join(TMP, '.git', 'objects', 'ab', 'cdef') })],
  ['logs (saída de execução)', claude('Read', { file_path: path.join(TMP, 'logs', 'app.log') })],
  ['dist (artefato de build)', claude('Read', { file_path: path.join(TMP, 'dist', 'bundle.js') })],
  ['dir /s', claude('Bash', { command: 'dir /s' })],
  ['tree', claude('Bash', { command: 'tree' })],
  ['findstr /s', claude('Bash', { command: 'findstr /s TODO *' })],
];

const seen = new Set();
const verdicts = [];
for (const [expected, label, payload] of CASES) {
  if (expected !== 'deny') continue;
  verdicts.push([label, payload]);
}
for (const [label, payload] of EXTRA) verdicts.push([label, payload]);

for (const [label, payload] of verdicts) {
  const v = decide(payload);
  check(`${label}: nega`, v && v.decision === 'deny', v);
  if (!v) continue;
  seen.add(v.rule);
  const en = english(v.reason);
  check(`${label}: ensina (DO THIS INSTEAD)`, /DO THIS INSTEAD/.test(en), en.slice(0, 200));
  check(`${label}: a correção é executável`, EXECUTABLE.test(en.split('DO THIS INSTEAD')[1] || ''), en.slice(-300));
  check(`${label}: não manda pedir confirmação ao usuário`, !/confirm|you approve|se você confirmar/i.test(en), en.slice(0, 200));
}
check('as quatro regras de recusa foram exercitadas', ['noisePath', 'blindRead', 'broadScan', 'shellDump'].every((r) => seen.has(r)), [...seen]);

console.log('\n  [binário em pasta de saída: a dica não manda ler como texto]');
{
  const v = decide(claude('Read', { file_path: path.join(TMP, 'tmp', 'bundle.zip') }));
  const reason = english(v && v.reason);
  check('binário em tmp/: nega sem sugerir tail/grep/Get-Content no binário',
    v && v.decision === 'deny' && !/\btail\b|\bgrep\b|Get-Content/.test(reason), reason);
  const office = english((decide(claude('Read', { file_path: path.join(TMP, 'logs', 'relatorio.xlsx') })) || {}).reason);
  check('planilha em logs/: a dica não manda tail/grep no binário', !/\btail\b|\bgrep\b|Get-Content/.test(office), office);
  const big = decide(claude('Read', { file_path: BIG_ZIP }));
  const bigReason = english(big && big.reason);
  check('binário grande sem faixa: blindRead não manda grep/sed/Get-Content no binário',
    big && big.rule === 'blindRead' && !/\bgrep\b|\bsed\b|Get-Content/.test(bigReason) && EXECUTABLE.test(bigReason), bigReason);
}

console.log('\n  [a correção sugerida passa pelo próprio guard]');
{
  const shellCases = [
    'Get-ChildItem -Recurse', 'gci -r', 'ls -R /repo', 'dir /s', 'find src', 'tree', 'findstr /s TODO *',
    'rg --files', 'fd .', 'grep -r TODO .', 'rg -n TODO .', 'grep -rn "Service" .', 'grep -rni TODO .', 'grep -nr TODO .', 'egrep -Rn foo .',
  ];
  const quoted = /`([^`]+)`/g;
  for (const command of shellCases) {
    const v = decide(claude('Bash', { command }));
    check(`"${command}" é recusado`, v && v.decision === 'deny', v);
    if (!v) continue;
    const advice = english(v.reason).split('DO THIS INSTEAD')[1] || '';
    const suggested = [...advice.matchAll(quoted)].map((m) => m[1])
      .filter((c) => /^(?:Get-ChildItem|ls|dir|find|tree|Select-String|rg|fd|grep|egrep|fgrep|git)\b/i.test(c) && !/token-guard|audit/.test(c));
    check(`"${command}": a recusa sugere ao menos um comando`, suggested.length > 0, advice.slice(0, 300));
    for (const s of suggested) {
      const again = decide(claude('Bash', { command: s }));
      check(`"${command}" → \`${s}\` não é recusado de novo`, again === null, again && again.reason.slice(0, 120));
    }
  }
}

console.log('\n  [nenhum caminho pergunta ao usuário]');
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refuse-warn-'));
  fs.writeFileSync(path.join(repo, 'token-guard.config.json'), JSON.stringify({ mode: 'warn' }), 'utf8');
  const payload = { tool_name: 'Glob', tool_input: { pattern: '**' }, cwd: repo };
  CFG.clearMemo();
  const viaConfig = decide(payload);
  check('config { mode: "warn" } nega (não pergunta)', viaConfig && viaConfig.decision === 'deny', viaConfig);

  fs.rmSync(path.join(repo, 'token-guard.config.json'));
  process.env.TOKEN_GUARD = 'warn';
  CFG.clearMemo();
  const viaEnv = decide(payload);
  check('TOKEN_GUARD=warn nega (não pergunta)', viaEnv && viaEnv.decision === 'deny', viaEnv);
  delete process.env.TOKEN_GUARD;
  CFG.clearMemo();
  fs.rmSync(repo, { recursive: true, force: true });

  const status = CFG.statusSummary(TMP);
  check('o status não anuncia "warn" como modo ativo', !/modo: warn/.test(status), status);

  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(cjs|mjs)$/.test(e.name)) files.push(p);
  });
  ['lib', 'adapters'].forEach((d) => walk(path.join(__dirname, '..', d)));
  const offenders = files.filter((f) => /(?:decision|permission|permissionDecision)['"]?\s*[:=]\s*['"]ask['"]/.test(fs.readFileSync(f, 'utf8')));
  check('nenhum arquivo de lib/ ou adapters/ emite "ask"', offenders.length === 0, offenders);
}

cleanup();
console.log(`\n  recusa que ensina: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
