#!/usr/bin/env node
'use strict';
/**
 * selftest.cjs — bateria de casos contra o hook real.
 *
 *   node selftest.cjs
 *
 * Cada caso monta um payload no formato de um runtime diferente, executa
 * token-guard.cjs como processo (exatamente como o harness faz) e confere
 * se a decisão foi a esperada. Sem dependências, sem framework.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const GUARD = path.join(__dirname, 'token-guard.cjs');

/* ---------- fixtures em disco ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-selftest-'));
const BIG = path.join(TMP, 'BigService.java');
const SMALL = path.join(TMP, 'Small.java');
fs.writeFileSync(BIG, 'x'.repeat(120000), 'utf8');
fs.writeFileSync(SMALL, 'x'.repeat(800), 'utf8');

// stats fingidas: repositório grande, para os guards de varredura valerem
fs.mkdirSync(path.join(TMP, '.token-guard'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, '.token-guard', 'repo-stats.json'),
  JSON.stringify({ totalFiles: 215112, pathChars: 26726490 }),
  'utf8'
);

// Em Windows/macOS o filesystem não distingue caixa; em Linux sim.
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

// Repositório FORA do fixture: caminhos absolutos reais para provar que
// noisePath não julga o que está fora da raiz do workspace.
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-outside-'));
fs.mkdirSync(path.join(OUTSIDE, 'scratchpad'), { recursive: true });
fs.mkdirSync(path.join(OUTSIDE, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(OUTSIDE, 'target', 'classes'), { recursive: true });

function run(payload, env, spawnCwd) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    cwd: spawnCwd,
    timeout: 15000,
  });
  const out = (res.stdout || '').trim();
  if (!out) return { decision: 'allow', reason: '' };
  try {
    const j = JSON.parse(out);
    return {
      decision: j.hookSpecificOutput?.permissionDecision || 'allow',
      reason: j.hookSpecificOutput?.permissionDecisionReason || '',
    };
  } catch {
    return { decision: 'parse-error', reason: out };
  }
}

/* payloads nos 3 formatos de runtime */
const vscode = (toolName, input) => ({ toolCall: { toolName, input }, cwd: TMP });
const claude = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: TMP });
const legacy = (toolName, toolInput) => ({ toolName, toolInput, cwd: TMP });

const CASES = [
  // ---- deve BLOQUEAR ----
  ['deny', 'glob "**/*" sem escopo (VS Code)',        vscode('glob', { pattern: '**/*' }), 'broadScan'],
  ['deny', 'glob "**" sem escopo (Claude)',           claude('Glob', { pattern: '**' }), 'broadScan'],
  ['deny', 'file_search sem escopo (legado)',         legacy('file_search', { query: '*' }), 'broadScan'],
  ['deny', 'leitura de 117 KB sem faixa',             vscode('view', { path: BIG }), 'blindRead'],
  ['deny', 'read_file grande sem faixa (Claude)',     claude('Read', { file_path: BIG }), 'blindRead'],
  ['deny', 'caminho em node_modules',                 vscode('view', { path: path.join(TMP, 'node_modules', 'x', 'i.js') }), 'noisePath'],
  ['deny', 'caminho em target DENTRO da raiz',        vscode('view', { path: path.join(TMP, 'target', 'classes', 'A.class') }), 'noisePath'],
  // Fora da raiz NÃO é ruído (decisão do replay real) — coberto pelos casos
  // OUTSIDE acima com caminhos absolutos reais.
  ['deny', 'Get-ChildItem -Recurse sem limite',       vscode('powershell', { command: 'Get-ChildItem -Recurse' }), 'shellDump'],
  ['deny', 'ls -R sem limite (Claude)',               claude('Bash', { command: 'ls -R /repo' }), 'shellDump'],
  ['deny', 'grep -r no shell',                        vscode('run_in_terminal', { command: 'grep -r TODO .' }), 'shellDump'],
  ['deny', 'grep content sem teto nem filtro',        vscode('grep', { pattern: 'Service', output_mode: 'content' }), 'broadScan'],

  // ---- deve BLOQUEAR (regressões do gate adversarial 2026-08) ----
  ['deny', 'rg --files sem limite',                   claude('Bash', { command: 'rg --files' }), 'shellDump'],
  ['deny', 'rg conteúdo no repo inteiro',             claude('Bash', { command: 'rg -n TODO .' }), 'shellDump'],
  ['deny', 'fd sem filtro de extensão',               claude('Bash', { command: 'fd .' }), 'shellDump'],
  ['deny', 'gci -r (alias PowerShell)',               claude('Bash', { command: 'gci -r' }), 'shellDump'],
  ['deny', 'dir -Recurse (PowerShell)',               vscode('powershell', { command: 'dir -Recurse' }), 'shellDump'],
  ['deny', 'find <dir> sem filtro',                   claude('Bash', { command: 'find src' }), 'shellDump'],
  ['deny', 'find <path absoluto unix>',               claude('Bash', { command: 'find /var/log' }), 'shellDump'],
  ['deny', 'git ls-files sem escopo',                 vscode('bash', { command: 'git ls-files' }), 'shellDump'],
  ['allow', 'git ls-files escopado é barato',         vscode('bash', { command: 'git ls-files docs/plans/' }), null],
  ['deny', 'prefixo de env não esconde dump',         vscode('bash', { command: 'FOO=1 tree' }), 'shellDump'],
  ['deny', 'prefixo de env em busca conteúdo',        vscode('bash', { command: 'FOO=1 rg -n TODO .' }), 'shellDump'],
  ['allow', 'switch do find.exe não é dump',          vscode('bash', { command: 'find /c "TODO" notes.txt' }), null],
  [FOLD_CASE ? 'deny' : 'allow', 'casing de ruído segue a plataforma', vscode('view', { path: path.join(TMP, 'src', 'Node_Modules', 'i.js') }), FOLD_CASE ? 'noisePath' : null],
  ['deny', 'offset=0 sem limit é leitura inteira',    vscode('view', { path: BIG, offset: 0 }), 'blindRead'],

  // ---- deve LIBERAR ----
  ['allow', 'git commit contendo a palavra tree',     claude('Bash', { command: 'git commit -m "fix tree view"' }), null],
  ['allow', 'script chamado tree.js',                 vscode('bash', { command: 'node scripts/tree.js --all' }), null],
  ['allow', 'grep -r alimentado por pipe é filtrado', vscode('bash', { command: 'cat a.txt | grep -r foo' }), null],
  ['allow', 'redirect para arquivo não entra na janela', vscode('powershell', { command: 'dir /s /b > arquivos.txt' }), null],
  ['allow', 'find com -maxdepth tem teto',            claude('Bash', { command: 'find . -maxdepth 1' }), null],
  ['allow', 'grep -r com escopo de diretório',        vscode('bash', { command: 'grep -rn TODO src/' }), null],
  ['allow', 'rg com escopo de diretório',             vscode('bash', { command: 'rg TODO lib/' }), null],
  ['allow', 'glob com grupo de extensão {ts,tsx}',    vscode('glob', { pattern: '**/*.{ts,tsx}' }), null],
  ['allow', 'head_limit em string conta como teto',   vscode('grep', { pattern: 'Service', output_mode: 'content', head_limit: '50' }), null],
  ['allow', 'payload malformado falha aberto',        { tool_name: 'Glob', tool_input: ['não', 'é', 'objeto'], cwd: TMP }, null],
  ['allow', 'listagem de um diretório é limitada por natureza', vscode('list_directory', { path: '.' }), null],

  // formatos de envelope
  ['allow', 'formato SDK in-process (toolArgs)',      { toolName: 'view', toolArgs: { path: SMALL }, workingDirectory: TMP }, null],

  // ---- deve LIBERAR (regressões do replay real 2026-08) ----
  // Fora da raiz NÃO é ruído. Fixtures usam caminhos ABSOLUTOS REAIS fora do
  // TMP (criado no topo): um "C:/..." só é absoluto no Windows; no Linux
  // cairia DENTRO do fixture ao resolver e viraria outro teste.
  ['allow', 'scratchpad fora da raiz não é ruído',    vscode('view', { path: path.join(OUTSIDE, 'scratchpad', 'w.out') }), null],
  ['allow', 'output de tarefa fora da raiz',          claude('Read', { file_path: path.join(OUTSIDE, 'tasks', 't.out') }), null],
  ['allow', 'build fora da raiz é contexto escolhido', claude('Read', { file_path: path.join(OUTSIDE, 'target', 'classes', 'A.class') }), null],
  ['deny', 'ruído DENTRO da raiz continua barrado',   vscode('view', { path: path.join(TMP, 'target', 'classes', 'i.class') }), 'noisePath'],

  // ---- deve LIBERAR (originais) ----
  ['allow', 'glob com extensão',                      vscode('glob', { pattern: '**/*.java' }), null],
  ['allow', 'glob ancorado em diretório',             vscode('glob', { pattern: 'src/main/**' }), null],
  ['allow', 'glob amplo mas com paths',               vscode('glob', { pattern: '**/*', paths: ['src'] }), null],
  ['allow', 'leitura com faixa de linhas',            vscode('view', { path: BIG, view_range: [40, 90] }), null],
  ['allow', 'leitura com offset/limit',               claude('Read', { file_path: BIG, offset: 10, limit: 60 }), null],
  ['allow', 'arquivo pequeno inteiro',                vscode('view', { path: SMALL }), null],
  ['allow', 'grep files_with_matches (barato)',       vscode('grep', { pattern: 'Service' }), null],
  ['allow', 'grep content com head_limit',            vscode('grep', { pattern: 'Service', output_mode: 'content', head_limit: 40 }), null],
  ['allow', 'grep content com filtro glob',           vscode('grep', { pattern: 'Service', output_mode: 'content', glob: '*.java' }), null],
  ['allow', 'Get-ChildItem -Recurse com -First',      vscode('powershell', { command: 'Get-ChildItem -Recurse | Select-Object -First 50' }), null],
  ['allow', 'find com -name',                         claude('Bash', { command: 'find . -name "*.java"' }), null],
  ['allow', 'ferramenta fora das famílias',           vscode('create_pull_request', { title: 'x' }), null],
  ['allow', 'payload vazio',                          {}, null],
];

let pass = 0, fail = 0;
const failures = [];

console.log('\n  token-guard · selftest');
console.log('  ' + '─'.repeat(72));

for (const [expected, label, payload, expectRule] of CASES) {
  const { decision, reason } = run(payload);
  const ok = decision === expected && (!expectRule || reason.includes(expectRule));
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else {
    fail++;
    failures.push({ label, expected, got: decision, expectRule, reason: reason.slice(0, 220) });
    console.log(`  FALHA ${label}  (esperado ${expected}${expectRule ? '/' + expectRule : ''}, obteve ${decision})`);
  }
}

/* escape hatches */
console.log('  ' + '─'.repeat(72));
const off = run(vscode('glob', { pattern: '**/*' }), { TOKEN_GUARD: 'off' });
if (off.decision === 'allow') { pass++; console.log('  ok    TOKEN_GUARD=off libera tudo'); }
else { fail++; failures.push({ label: 'TOKEN_GUARD=off', expected: 'allow', got: off.decision }); console.log('  FALHA TOKEN_GUARD=off'); }

const warn = run(vscode('glob', { pattern: '**/*' }), { TOKEN_GUARD: 'warn' });
if (warn.decision === 'ask') { pass++; console.log('  ok    TOKEN_GUARD=warn vira "ask" e mantém a correção'); }
else { fail++; failures.push({ label: 'TOKEN_GUARD=warn', expected: 'ask', got: warn.decision }); console.log('  FALHA TOKEN_GUARD=warn'); }

/* a mensagem realmente ensina? */
const sample = run(vscode('glob', { pattern: '**/*' }));
const teaches = /DO THIS INSTEAD/.test(sample.reason) && /PT-BR/.test(sample.reason);
if (teaches) { pass++; console.log('  ok    o bloqueio injeta a correção (EN + PT-BR)'); }
else { fail++; failures.push({ label: 'mensagem corretiva', reason: sample.reason.slice(0, 200) }); console.log('  FALHA mensagem corretiva ausente'); }

/* blindRead resolve caminho relativo contra o cwd do PAYLOAD, não o do processo.
   O hook pode ser spawnado de qualquer lugar; o arquivo pertence ao workspace. */
const relName = 'sub-relbig.log';
fs.mkdirSync(path.join(TMP, 'sub'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'sub', relName), 'y'.repeat(120000), 'utf8');
const cwdMiss = run({ tool_name: 'View', tool_input: { path: `sub/${relName}` }, cwd: TMP }, null, os.tmpdir());
if (cwdMiss.decision === 'deny' && /blindRead/.test(cwdMiss.reason)) {
  pass++; console.log('  ok    blindRead resolve relativo contra o cwd do payload');
} else {
  fail++;
  failures.push({ label: 'blindRead cwd relativo', expected: 'deny/blindRead', got: cwdMiss.decision });
  console.log(`  FALHA blindRead cwd relativo (obteve ${cwdMiss.decision})`);
}

console.log('  ' + '─'.repeat(72));
console.log(`  ${pass} passaram · ${fail} falharam\n`);

if (fail) {
  console.log('  DETALHE DAS FALHAS');
  for (const f of failures) console.log('  · ' + JSON.stringify(f, null, 2).replace(/\n/g, '\n    '));
  console.log('');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }
try { if (typeof OUTSIDE !== 'undefined') fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch { /* noop */ }
process.exit(fail ? 1 : 0);
