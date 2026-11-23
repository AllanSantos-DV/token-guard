'use strict';
/**
 * gen-cases.cjs — gera os casos de equivalência do slice PreToolUse a partir dos CASES reais do
 * projeto, com a resposta esperada obtida RODANDO o `decide` real (não escrita à mão).
 *
 *   node native-lens/equivalence/gen-cases.cjs <pasta-de-trabalho>
 *
 * Os arquivos que os casos leem (BigService.java, repo-stats.json…) ficam em <pasta>/fixtures: os casos
 * trazem caminhos absolutos e os protótipos nativos leem o mesmo disco.
 */

const fs = require('fs');
const path = require('path');

const work = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('uso: gen-cases.cjs <pasta-de-trabalho>'); process.exit(2); }
const fixRoot = path.join(work, 'fixtures');
fs.rmSync(fixRoot, { recursive: true, force: true });
fs.mkdirSync(fixRoot, { recursive: true });
process.env.TEMP = fixRoot;
process.env.TMP = fixRoot;
process.env.TMPDIR = fixRoot;

const FX = require('../../test/fixtures/cases.cjs');
const { decide } = require('../../lib/decide.cjs');
const H = require('../../lib/claude-hooks.cjs');

const out = [];
const seen = new Set();

function add(id, label, payload, group) {
  const key = JSON.stringify(payload);
  if (seen.has(key)) return;
  seen.add(key);
  const verdict = decide(payload);
  out.push({
    id,
    group,
    label,
    payload,
    expect: {
      body: H.preEnvelope(verdict) || {},
      rule: verdict ? verdict.rule : null,
      decision: verdict ? verdict.decision : null,
    },
  });
}

FX.CASES.forEach(([want, label, payload, rule], i) => {
  add(`base-${i}`, label, payload, 'base');
  const got = decide(payload);
  const ok = want === 'deny' ? got && got.rule === rule : !got;
  if (!ok) throw new Error(`caso base ${i} (${label}) discorda do próprio decide: esperado ${want}/${rule}`);
});

const shellCmd = (p) => (p && p.tool_input && typeof p.tool_input.command === 'string') ? p.tool_input.command
  : (p && p.toolCall && p.toolCall.input && typeof p.toolCall.input.command === 'string') ? p.toolCall.input.command : null;

const VARIANTS = [
  ['espaços à frente', (c) => `   ${c}`],
  ['quebra de linha no fim', (c) => `${c}\n`],
  ['prefixo cd &&', (c) => `cd src && ${c}`],
  ['prefixo de env', (c) => `CI=1 ${c}`],
  ['teto no pipe', (c) => `${c} | head -50`],
  ['2>&1', (c) => `${c} 2>&1`],
  ['encadeado com ;', (c) => `echo ok; ${c}`],
  ['CRLF', (c) => c.replace(/\n/g, '\r\n') + '\r\n'],
  ['sem espaço nenhum extra, entre aspas', (c) => `bash -c "${c.replace(/"/g, "'")}"`],
  ['maiúsculas no comando', (c) => c.toUpperCase()],
  ['unicode no argumento', (c) => `${c} "ação ✓ não"`],
];

let n = 0;
for (const c of FX.CASES) {
  const payload = c[2];
  const cmd = shellCmd(payload);
  if (cmd === null) continue;
  for (const [vlabel, fn] of VARIANTS) {
    const next = JSON.parse(JSON.stringify(payload));
    if (next.tool_input) next.tool_input.command = fn(cmd);
    else next.toolCall.input.command = fn(cmd);
    add(`mut-${n++}`, `${c[1]} · ${vlabel}`, next, 'mutation');
  }
}

const EXTRA = [
  ['tool_input como string (inválido)', { tool_name: 'Bash', tool_input: 'ls -R .', cwd: FX.TMP }],
  ['tool_input nulo', { tool_name: 'Bash', tool_input: null, cwd: FX.TMP }],
  ['sem cwd', { tool_name: 'Glob', tool_input: { pattern: '**/*' } }],
  ['comando não string', { tool_name: 'Bash', tool_input: { command: 42 }, cwd: FX.TMP }],
  ['nome de ferramenta com maiúsculas e hífen', { tool_name: 'Run-In-Terminal', tool_input: { command: 'tree' }, cwd: FX.TMP }],
  ['comando de 20 KB sem dump', { tool_name: 'Bash', tool_input: { command: `echo ${'a'.repeat(20000)}` }, cwd: FX.TMP }],
  ['comando de 20 KB com dump no fim', { tool_name: 'Bash', tool_input: { command: `echo ${'a'.repeat(20000)}\nls -R .` }, cwd: FX.TMP }],
  ['cwd inexistente com leitura', { tool_name: 'Read', tool_input: { file_path: path.join(fixRoot, 'nao-existe', 'x.java') }, cwd: path.join(fixRoot, 'nao-existe') }],
  ['arquivo inexistente', { tool_name: 'Read', tool_input: { file_path: path.join(FX.TMP, 'Inexistente.java') }, cwd: FX.TMP }],
  ['caminho relativo ao cwd', { tool_name: 'Read', tool_input: { file_path: 'BigService.java' }, cwd: FX.TMP }],
  ['glob sem pattern', { tool_name: 'Glob', tool_input: {}, cwd: FX.TMP }],
  ['grep com output_mode content e head_limit 0', { tool_name: 'Grep', tool_input: { pattern: 'x', output_mode: 'content', head_limit: 0 }, cwd: FX.TMP }],
];
EXTRA.forEach(([label, payload], i) => add(`extra-${i}`, label, payload, 'extra'));

const mkProject = (name, markerFile, totalFiles) => {
  const dir = path.join(fixRoot, name);
  fs.mkdirSync(path.join(dir, '.token-guard'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  if (markerFile) fs.writeFileSync(path.join(dir, markerFile), '{}');
  if (totalFiles !== null) fs.writeFileSync(path.join(dir, '.token-guard', 'repo-stats.json'), JSON.stringify({ totalFiles, pathChars: totalFiles * 80 }));
  fs.writeFileSync(path.join(dir, 'src', 'Big.java'), 'y'.repeat(80000));
  return dir;
};
const PROJECTS = [
  ['proj-small', mkProject('proj-small-pkg', 'package.json', 10)],
  ['proj-big', mkProject('proj-big-git', 'go.mod', 50000)],
  ['proj-edge', mkProject('proj-edge-399', 'Cargo.toml', 399)],
  ['proj-edge400', mkProject('proj-edge-400', 'pom.xml', 400)],
  ['proj-nostats', mkProject('proj-nostats', 'build.gradle', null)],
  ['proj-badjson', (() => { const d = mkProject('proj-badjson', 'package.json', null); fs.writeFileSync(path.join(d, '.token-guard', 'repo-stats.json'), '{nao json'); return d; })()],
  ['proj-nan', (() => { const d = mkProject('proj-nan', 'package.json', null); fs.writeFileSync(path.join(d, '.token-guard', 'repo-stats.json'), '{"totalFiles":"muitos"}'); return d; })()],
];
for (const [tag, dir] of PROJECTS) {
  const roots = [dir, path.join(dir, 'src'), path.join(dir, 'src', 'deep')];
  roots.forEach((cwd, i) => {
    add(`${tag}-glob-${i}`, `${tag}: glob amplo, cwd nível ${i}`, { tool_name: 'Glob', tool_input: { pattern: '**/*' }, cwd }, 'project');
    add(`${tag}-grep-${i}`, `${tag}: grep content sem teto, cwd nível ${i}`, { tool_name: 'Grep', tool_input: { pattern: 'x', output_mode: 'content' }, cwd }, 'project');
    add(`${tag}-ls-${i}`, `${tag}: ls -R, cwd nível ${i}`, { tool_name: 'Bash', tool_input: { command: 'ls -R .' }, cwd }, 'project');
    add(`${tag}-read-${i}`, `${tag}: leitura grande sem faixa, cwd nível ${i}`, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'src', 'Big.java') }, cwd }, 'project');
    add(`${tag}-nm-${i}`, `${tag}: node_modules, cwd nível ${i}`, { tool_name: 'Read', tool_input: { file_path: path.join(dir, 'node_modules', 'a', 'b.js') }, cwd }, 'project');
  });
}

const dest = path.join(work, 'cases.jsonl');
fs.writeFileSync(dest, out.map((c) => JSON.stringify(c)).join('\n') + '\n');
const by = out.reduce((a, c) => { a[c.group] = (a[c.group] || 0) + 1; return a; }, {});
const denies = out.filter((c) => c.expect.rule).length;
console.log(JSON.stringify({ dest, total: out.length, byGroup: by, denies, allows: out.length - denies, fixtures: FX.TMP }));
