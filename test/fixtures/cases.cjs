'use strict';

const BOOT = require('../bootstrap.cjs');

const path = require('path');
const fs = require('fs');
const os = require('os');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cases-'));
const BIG = path.join(TMP, 'BigService.java');
const SMALL = path.join(TMP, 'Small.java');
fs.writeFileSync(BIG, 'x'.repeat(120000), 'utf8');
fs.writeFileSync(SMALL, 'x'.repeat(800), 'utf8');

fs.mkdirSync(path.join(TMP, '.token-guard'), { recursive: true });
fs.writeFileSync(
  path.join(TMP, '.token-guard', 'repo-stats.json'),
  JSON.stringify({ totalFiles: 215112, pathChars: 26726490 }),
  'utf8'
);

const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-outside-'));
fs.mkdirSync(path.join(OUTSIDE, 'scratchpad'), { recursive: true });
fs.mkdirSync(path.join(OUTSIDE, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(OUTSIDE, 'target', 'classes'), { recursive: true });

const vscode = (toolName, input) => ({ toolCall: { toolName, input }, cwd: TMP });
const claude = (tool_name, tool_input) => ({ tool_name, tool_input, cwd: TMP });
const legacy = (toolName, toolInput) => ({ toolName, toolInput, cwd: TMP });

const CASES = [
  ['deny', 'glob "**/*" sem escopo (VS Code)',        vscode('glob', { pattern: '**/*' }), 'broadScan'],
  ['deny', 'glob "**" sem escopo (Claude)',           claude('Glob', { pattern: '**' }), 'broadScan'],
  ['deny', 'file_search sem escopo (legado)',         legacy('file_search', { query: '*' }), 'broadScan'],
  ['deny', 'leitura de 117 KB sem faixa',             vscode('view', { path: BIG }), 'blindRead'],
  ['deny', 'read_file grande sem faixa (Claude)',     claude('Read', { file_path: BIG }), 'blindRead'],
  ['deny', 'caminho em node_modules',                 vscode('view', { path: path.join(TMP, 'node_modules', 'x', 'i.js') }), 'noisePath'],
  ['deny', 'caminho em target DENTRO da raiz',        vscode('view', { path: path.join(TMP, 'target', 'classes', 'A.class') }), 'noisePath'],
  ['deny', 'Get-ChildItem -Recurse sem limite',       vscode('powershell', { command: 'Get-ChildItem -Recurse' }), 'shellDump'],
  ['deny', 'ls -R sem limite (Claude)',               claude('Bash', { command: 'ls -R /repo' }), 'shellDump'],
  ['deny', 'grep -r no shell',                        vscode('run_in_terminal', { command: 'grep -r TODO .' }), 'shellDump'],
  ['deny', 'grep content sem teto nem filtro',        vscode('grep', { pattern: 'Service', output_mode: 'content' }), 'broadScan'],

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

  ['allow', 'formato SDK in-process (toolArgs)',      { toolName: 'view', toolArgs: { path: SMALL }, workingDirectory: TMP }, null],

  ['allow', 'scratchpad fora da raiz não é ruído',    vscode('view', { path: path.join(OUTSIDE, 'scratchpad', 'w.out') }), null],
  ['allow', 'output de tarefa fora da raiz',          claude('Read', { file_path: path.join(OUTSIDE, 'tasks', 't.out') }), null],
  ['allow', 'build fora da raiz é contexto escolhido', claude('Read', { file_path: path.join(OUTSIDE, 'target', 'classes', 'A.class') }), null],
  ['deny', 'ruído DENTRO da raiz continua barrado',   vscode('view', { path: path.join(TMP, 'target', 'classes', 'i.class') }), 'noisePath'],

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

function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }
  try { fs.rmSync(OUTSIDE, { recursive: true, force: true }); } catch { /* noop */ }
  BOOT.restore();
}

module.exports = { CASES, TMP, BIG, SMALL, OUTSIDE, FOLD_CASE, cleanup };
