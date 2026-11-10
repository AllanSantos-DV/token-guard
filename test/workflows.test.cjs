'use strict';
/**
 * workflows.test.cjs — o GitHub Actions hospedado não roda suíte de teste nem usa runner Windows ou macOS.
 *
 * As suítes rodam no pre-check local antes de cada release; no Actions hospedado sobra só checagem estática
 * leve em Linux. O detector lê o YAML como texto (sem dependência) e ignora comentários.
 */

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '.github', 'workflows');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

const NON_LINUX_RUNNER = /\b(?:windows|macos)(?:-[\w.]+)?\b/i;
const TEST_COMMANDS = [
  /\b(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test\b/,
  /\bnode\s+--test\b/,
  /\bnode\s+\S*(?:\btest\/|\.test\.|selftest)\S*/,
  /\b(?:npx\s+)?(?:jest|vitest|mocha|ava|playwright\s+test)\b/,
];

/** Linhas do workflow sem comentários (linha inteira ou trecho depois de " #"). */
function codeLines(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '')).filter((l) => l.trim());
}

/** Problemas do workflow: runner fora de Linux ou passo que roda teste. */
function workflowProblems(text) {
  const problems = [];
  for (const line of codeLines(text)) {
    if (/^\s*(?:runs-on|os)\s*:|^\s*-\s*\S|\[/.test(line) && NON_LINUX_RUNNER.test(line)) problems.push(`runner fora de Linux: ${line.trim()}`);
    if (TEST_COMMANDS.some((re) => re.test(line))) problems.push(`comando de teste: ${line.trim()}`);
  }
  return problems;
}

console.log('\n  [workflows · Actions hospedado sem teste e só Linux]');

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));
check('há workflows para conferir', files.length > 0, files);
for (const f of files) {
  const problems = workflowProblems(fs.readFileSync(path.join(DIR, f), 'utf8'));
  check(`${f}: nenhum runner Windows ou macOS e nenhum passo de teste`, problems.length === 0, problems);
}

const MATRIX_WINDOWS_AND_TESTS = [
  'jobs:',
  '  test:',
  '    strategy:',
  '      matrix:',
  '        os: [ubuntu-latest, windows-latest]',
  '    runs-on: ${{ matrix.os }}',
  '    steps:',
  '      - run: node selftest.cjs',
  '      - run: node test/install.test.cjs && node test/daemon-http.test.cjs',
  '      - run: npm test',
].join('\n');
const flagged = workflowProblems(MATRIX_WINDOWS_AND_TESTS);
check('o detector acusa a matriz com windows-latest', flagged.some((p) => p.includes('windows-latest')), flagged);
check('o detector acusa node selftest.cjs, node test/... e npm test', ['selftest.cjs', 'test/install.test.cjs', 'npm test'].every((s) => flagged.some((p) => p.includes(s))), flagged);
check('o detector acusa runs-on: macos-14', workflowProblems('    runs-on: macos-14').length === 1);
check('checagem estática leve não é acusada', workflowProblems([
  '    runs-on: ubuntu-latest',
  '      # windows e npm test só em comentário não contam',
  "      - run: node -e \"const a=require('./package.json').version\"",
  '      - run: npm publish --provenance',
].join('\n')).length === 0);

console.log(`\n  workflows: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
