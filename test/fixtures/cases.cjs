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
// Mesmo tamanho do BIG: o que muda a decisão é o TIPO, não os bytes.
const BIG_PNG = path.join(TMP, 'dashboard.png');
const BIG_SVG = path.join(TMP, 'diagram.svg');
const BIG_PDF = path.join(TMP, 'manual.pdf');
const BIG_NB = path.join(TMP, 'analise.ipynb');
for (const f of [BIG_PNG, BIG_SVG, BIG_PDF, BIG_NB]) fs.writeFileSync(f, 'x'.repeat(120000), 'utf8');

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

  // Replay 2026-10: falsos positivos reais, e os vizinhos que DEVEM seguir barrados.
  ['allow', 'gci -Recurse com -Filter tem filtro',        vscode('powershell', { command: 'Get-ChildItem "$env:USERPROFILE\\.claude\\plugins\\data" -Recurse -Filter "dashboard.json" -ErrorAction SilentlyContinue' }), null],
  ['allow', 'pwsh -c com gci -Recurse -Filter',           claude('Bash', { command: "pwsh -NoProfile -c 'Get-ChildItem \"$env:LOCALAPPDATA\\Packages\" -Recurse -Filter ext4.vhdx -EA 0 | Select FullName'" }), null],
  ['allow', 'gci -Recurse filtrado por Where-Object',     vscode('powershell', { command: "Get-ChildItem C:/h -Recurse -File | Where-Object { $_.Name -match 'x' } | ForEach-Object FullName" }), null],
  ['allow', 'find com -newer é filtro',                   claude('Bash', { command: 'find . -newer transcript.txt -type f | sort' }), null],
  ['allow', 'git ls-files --others (só não rastreados)',  claude('Bash', { command: 'git ls-files --others --exclude-standard' }), null],
  ['allow', 'git ls-files -mo (modificados+novos)',       claude('Bash', { command: 'git stash create; git ls-files -mo --exclude-standard' }), null],
  ['allow', 'heredoc de mensagem de commit não é comando', claude('Bash', { command: "bash scripts/git-commit.sh \"$(cat <<'EOF'\nchore: x\n\n- git ls-files sem escopo e barrado\n- tree e ls -R tambem\nEOF\n)\"" }), null],
  ['allow', 'git ls-files dentro de mensagem -m',         claude('Bash', { command: 'git commit -m "docs: git ls-files sem escopo"' }), null],
  ['deny', 'dump DEPOIS do heredoc continua barrado',     claude('Bash', { command: "cat <<EOF > notas.txt\nx\nEOF\nls -R ." }), 'shellDump'],
  ['deny', 'git ls-files -s lista a árvore inteira',      claude('Bash', { command: 'git ls-files -s' }), 'shellDump'],
  ['deny', 'gci -Recurse sem filtro segue barrado',       vscode('powershell', { command: 'Get-ChildItem C:/h -Recurse | ForEach-Object FullName' }), 'shellDump'],
  ['allow', 'ler o integral salvo pelo bigResult',        claude('Read', { file_path: path.join(TMP, '.token-guard', 'results', '1790-tool-ab12.txt'), limit: 50 }), null],
  ['allow', 'grep no integral salvo pelo bigResult',      claude('Grep', { pattern: 'FAIL', path: path.join(TMP, '.token-guard', 'results', '1790-shell-cd34.txt') }), null],
  ['deny', 'outro arquivo de .token-guard segue ruído',   claude('Read', { file_path: path.join(TMP, '.token-guard', 'sessions', 'abc.json') }), 'noisePath'],
  ['allow', 'pipeline do PowerShell continuado na linha seguinte', vscode('powershell', { command: "Get-ChildItem \"$env:USERPROFILE\\.claude\" -File -Recurse -ErrorAction SilentlyContinue |\n    Where-Object { $_.Name -like '*.json' } |\n    Select-Object -First 20 FullName" }), null],
  ['allow', 'gci -Recurse -Depth 2 tem teto',             vscode('powershell', { command: 'Get-ChildItem $appData -Recurse -Depth 2 -ErrorAction SilentlyContinue' }), null],
  ['allow', '"tree" dentro de código entre aspas não é comando', claude('Bash', { command: "node -e \"const d = load();\nconst o = {\n  tree: d.raw && d.raw.tree,\n};\nconsole.log(o)\"" }), null],
  ['allow', 'find num ARQUIVO é checagem de existência',  claude('Bash', { command: 'echo "=== plano ===\nfind docs/plans/analise.md 2>&1' }), null],
  ['deny', 'continuação com \\ não esconde o dump',       claude('Bash', { command: 'ls -R \\\n  src' }), 'shellDump'],
  ['allow', 'bloco ForEach multilinha que filtra com Select-String', vscode('powershell', { command: "Get-ChildItem \"$env:USERPROFILE\\.claude\" -File -Recurse -ErrorAction SilentlyContinue |\n    ForEach-Object {\n        if (Select-String -Path $_.FullName -Pattern 'api' -Quiet) {\n            Write-Host $_.FullName\n        }\n    }" }), null],
  ['deny', 'bloco ForEach que só imprime segue barrado',  vscode('powershell', { command: "Get-ChildItem C:/h -Recurse |\n  ForEach-Object {\n    Write-Host $_.FullName\n  }" }), 'shellDump'],
  ['allow', 'glob por NOME (o próprio deny recomenda)',   claude('Glob', { pattern: '**/*Service*' }), null],
  ['allow', 'glob por nome com hífen',                     claude('Glob', { pattern: '**/*model-router**' }), null],
  ['allow', 'glob por nome de config',                     claude('Glob', { pattern: '**/vitest.config.*' }), null],
  ['deny', 'glob "*" na raiz segue sem escopo',            claude('Glob', { pattern: '*' }), 'broadScan'],
  ['deny', 'glob "**/*?" sem trecho literal segue sem escopo', claude('Glob', { pattern: '**/*?' }), 'broadScan'],
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
  // Sessão com cwd num ANCESTRAL do %TEMP% (ex.: a pasta do usuário): o %TEMP%
  // em si não é diretório de build — saída de tarefa do harness é contexto.
  ['allow', 'saída de tarefa do harness em %TEMP% com cwd ancestral', { tool_name: 'Read', tool_input: { file_path: path.join(os.tmpdir(), 'claude', 'C--x', 's1', 'tasks', 't.output') }, cwd: path.dirname(path.dirname(os.tmpdir())) }, null],
  ['deny', 'node_modules dentro do %TEMP% continua ruído com cwd ancestral', { tool_name: 'Read', tool_input: { file_path: path.join(os.tmpdir(), 'algum-pkg', 'node_modules', 'x', 'i.js') }, cwd: path.dirname(path.dirname(os.tmpdir())) }, 'noisePath'],
  ['deny', 'ruído DENTRO da raiz continua barrado',   vscode('view', { path: path.join(TMP, 'target', 'classes', 'i.class') }), 'noisePath'],

  ['allow', 'glob com extensão',                      vscode('glob', { pattern: '**/*.java' }), null],
  ['allow', 'glob ancorado em diretório',             vscode('glob', { pattern: 'src/main/**' }), null],
  ['allow', 'glob amplo mas com paths',               vscode('glob', { pattern: '**/*', paths: ['src'] }), null],
  ['allow', 'leitura com faixa de linhas',            vscode('view', { path: BIG, view_range: [40, 90] }), null],
  ['allow', 'leitura com offset/limit',               claude('Read', { file_path: BIG, offset: 10, limit: 60 }), null],
  ['allow', 'imagem grande sem faixa (Read entrega como imagem)', claude('Read', { file_path: BIG_PNG }), null],
  ['deny', 'SVG grande sem faixa (é texto)',          claude('Read', { file_path: BIG_SVG }), 'blindRead'],
  ['allow', 'PDF grande com pages',                   claude('Read', { file_path: BIG_PDF, pages: '1-5' }), null],
  ['deny', 'PDF grande sem pages',                    claude('Read', { file_path: BIG_PDF }), 'blindRead'],
  ['deny', 'notebook grande com offset/limit (Read ignora a faixa)', claude('Read', { file_path: BIG_NB, offset: 1, limit: 40 }), 'blindRead'],
  ['allow', 'notebook com view_range (faixa real)',    vscode('view', { path: BIG_NB, view_range: [1, 40] }), null],
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

module.exports = { CASES, TMP, BIG, SMALL, OUTSIDE, FOLD_CASE, BIG_PDF, BIG_NB, cleanup };
