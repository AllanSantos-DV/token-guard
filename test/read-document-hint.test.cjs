#!/usr/bin/env node
'use strict';
/**
 * read-document-hint.test.cjs — a recusa de documento grande só cita o read_document (Smart Tool)
 * quando ele está registrado como servidor MCP nesta máquina; sem ele a mensagem é a de sempre.
 *
 * O hook spawnado lê o HOME isolado pelo bootstrap, então o teste liga e desliga o config do
 * harness dentro desse home descartável — nunca toca no config real do usuário.
 */
const BOOT = require('./bootstrap.cjs');

const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { smartToolPresent } = require('../lib/rules.cjs');
const { decide } = require('../lib/decide.cjs');
const DS = require('../adapters/daemon-server.cjs');
const PR = require('../lib/postresult.cjs');
const DR = require('../lib/dupread.cjs');

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}

const GUARD = path.join(__dirname, '..', 'token-guard.cjs');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-rdh-'));
const mk = (name) => { const f = path.join(WORK, name); fs.writeFileSync(f, 'x'.repeat(120000)); return f; };
const PDF = mk('manual.pdf'), DOCX = mk('relatorio.docx'), ZIP = mk('pacote.zip');

function reasonFor(file) {
  const res = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: file }, cwd: WORK }),
    encoding: 'utf8', env: process.env, timeout: 15000,
  });
  const j = JSON.parse((res.stdout || '{}').trim() || '{}');
  return { decision: j.hookSpecificOutput?.permissionDecision || 'allow', reason: j.hookSpecificOutput?.permissionDecisionReason || '' };
}

const HOST_CONFIG = path.join(os.homedir(), ['.claude', 'json'].join('.'));
const HINT = /read_document[\s\S]*info_only=true[\s\S]*range='1-5'[\s\S]*select:mcp__smart-tool__read_document/;
const withSmartTool = () => fs.writeFileSync(HOST_CONFIG, JSON.stringify({ mcpServers: { 'smart-tool': { type: 'http', url: 'http://127.0.0.1:8765/mcp' } } }));

console.log('\n  [dica do read_document · Smart Tool ausente]');
fs.rmSync(HOST_CONFIG, { force: true });
let r = reasonFor(PDF);
check('PDF grande sem Smart Tool: recusa ensina pages e não cita read_document', r.decision === 'deny' && /pages/.test(r.reason) && !/read_document/.test(r.reason), r.reason);
r = reasonFor(DOCX);
check('docx grande sem Smart Tool: recusa não cita read_document', r.decision === 'deny' && !/read_document/.test(r.reason), r.reason);

console.log('\n  [dica do read_document · Smart Tool presente]');
withSmartTool();
r = reasonFor(PDF);
check('PDF grande com Smart Tool: recusa sugere read_document (ToolSearch, info_only, range) e mantém pages', r.decision === 'deny' && HINT.test(r.reason) && /pages/.test(r.reason), r.reason);
check('a dica sai nos dois idiomas da recusa', /Se a ferramenta read_document/.test(r.reason) && /If the read_document tool/.test(r.reason), r.reason);
r = reasonFor(DOCX);
check('docx grande com Smart Tool: recusa sugere read_document', r.decision === 'deny' && HINT.test(r.reason), r.reason);
r = reasonFor(ZIP);
check('zip grande com Smart Tool: sem dica de documento (a ferramenta não lê zip)', r.decision === 'deny' && !/read_document/.test(r.reason), r.reason);

console.log('\n  [fail-open da detecção]');
fs.writeFileSync(HOST_CONFIG, '{ isto não é json');
r = reasonFor(PDF);
check('config do harness ilegível: recusa de sempre, sem dica', r.decision === 'deny' && /pages/.test(r.reason) && !/read_document/.test(r.reason), r.reason);
fs.rmSync(HOST_CONFIG, { force: true });
check('detecção que lança vira ausente', smartToolPresent({ discover: () => { throw new Error('boom'); } }) === false);

console.log('\n  [onde a detecção olha]');
const codexHome = fs.mkdtempSync(path.join(WORK, 'codex-'));
fs.mkdirSync(path.join(codexHome, '.codex'));
fs.writeFileSync(path.join(codexHome, '.codex', 'config.toml'), "[mcp_servers.smart-tool]\nurl = 'http://127.0.0.1:8765/mcp'\n");
check('Codex: [mcp_servers.smart-tool] no config.toml conta', smartToolPresent({ home: codexHome, cwd: codexHome }) === true);
const proj = fs.mkdtempSync(path.join(WORK, 'proj-'));
fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'smart-tool': { command: 'smart-tool-mcp' } } }));
check('Claude Code: .mcp.json do projeto conta', smartToolPresent({ home: path.join(WORK, 'vazio'), cwd: proj }) === true);
check('outro servidor MCP não conta como Smart Tool', smartToolPresent({ discover: () => [{ name: 'files', spec: {} }] }) === false);
check('nenhum config em lugar nenhum: ausente', smartToolPresent({ home: path.join(WORK, 'vazio'), cwd: path.join(WORK, 'vazio') }) === false);


console.log('\n  [arquivos de config: a descoberta e a chave do cache usam a mesma lista]');
const vazio = path.join(WORK, 'vazio');
const ST = { 'smart-tool': { command: 'smart-tool-mcp' } };
const projWith = (rel) => {
  const d = fs.mkdtempSync(path.join(WORK, 'pj-'));
  fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
  fs.writeFileSync(path.join(d, rel), JSON.stringify({ [rel.startsWith('.vscode') ? 'servers' : 'mcpServers']: ST }));
  return d;
};
check('VS Code: config MCP do projeto conta', smartToolPresent({ home: vazio, cwd: projWith('.vscode/mcp.json') }) === true);
check('Cursor: config MCP do projeto conta', smartToolPresent({ home: vazio, cwd: projWith('.cursor/mcp.json') }) === true);
{
  const MC = require('../lib/mcp-cost.cjs');
  const rules = require('../lib/rules.cjs');
  const cwd = path.join(WORK, 'pj-chave');
  const keyFiles = rules.smartToolConfigFiles(cwd).map((f) => path.normalize(f)).sort();
  const discFiles = MC.configFiles({ cwd, detection: true }).map((f) => path.normalize(f.file)).sort();
  check('a lista da chave do cache é exatamente a da descoberta', JSON.stringify(keyFiles) === JSON.stringify(discFiles));
  check('a lista inclui os três arquivos de projeto', ['.mcp.json', path.join('.vscode', 'mcp.json'), path.join('.cursor', 'mcp.json')].every((r) => keyFiles.includes(path.normalize(path.join(cwd, r)))));
}

console.log('\n  [escopo local do Claude Code: projects[<raiz>].mcpServers]');
{
  const home = fs.mkdtempSync(path.join(WORK, 'home-'));
  const root = fs.mkdtempSync(path.join(WORK, 'raiz-'));
  const sub = path.join(root, 'pacote', 'src');
  fs.mkdirSync(sub, { recursive: true });
  const cfgOf = (key, servers) => fs.writeFileSync(path.join(home, ['.claude', 'json'].join('.')), JSON.stringify({ mcpServers: {}, projects: { [key]: { mcpServers: servers } } }));
  cfgOf(root.replace(/\\/g, '/'), ST);
  check('Smart Tool só no escopo local do projeto: detectado no cwd da raiz', smartToolPresent({ home, cwd: root }) === true);
  check('detectado também de um subdiretório (a raiz é um ancestral)', smartToolPresent({ home, cwd: sub }) === true);
  check('escopo local de outro projeto não conta', smartToolPresent({ home, cwd: path.join(WORK, 'outro') }) === false);
  cfgOf(root.replace(/\\/g, '/'), { files: { command: 'x' } });
  check('escopo local sem o Smart Tool: ausente', smartToolPresent({ home, cwd: root }) === false);

  // Registro feito para uma pasta ACIMA do repositório não vale para o projeto: a subida para na raiz (.git).
  const pai = fs.mkdtempSync(path.join(WORK, 'pai-'));
  const repo = path.join(pai, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'src'));
  cfgOf(pai.replace(/\\/g, '/'), ST);
  check('servidor de escopo local de uma pasta acima do repositório não vale', smartToolPresent({ home, cwd: path.join(repo, 'src') }) === false);
  cfgOf(repo.replace(/\\/g, '/'), ST);
  check('servidor registrado na raiz do repositório vale em subpasta', smartToolPresent({ home, cwd: path.join(repo, 'src') }) === true);
}

console.log('\n  [a medição do mcp-cost segue sem enxergar .mcp.json nem o escopo local]');
{
  const MC = require('../lib/mcp-cost.cjs');
  const home = fs.mkdtempSync(path.join(WORK, 'home-med-'));
  const proj = projWith('.mcp.json');
  fs.writeFileSync(path.join(home, ['.claude', 'json'].join('.')), JSON.stringify({ mcpServers: {}, projects: { [proj.replace(/\\/g, '/')]: { mcpServers: ST } } }));
  check('discover sem detection não lista o .mcp.json do projeto nem o escopo local (nada novo para a sondagem subir)', MC.discover({ home, cwd: proj }).length === 0);
  check('discover com detection lista os dois', MC.discover({ home, cwd: proj, detection: true }).length >= 1);
}

console.log('\n  [daemon: a config muda entre chamadas e o veredito acompanha]');
{
  const ctx = { cache: new Map(), hits: 0, misses: 0 };
  const check1 = (payload) => DS.handleMessage({ id: 1, method: 'check', params: { payload, root: WORK } }, ctx).result;
  const payload = { tool_name: 'Read', tool_input: { file_path: PDF }, cwd: WORK };
  fs.rmSync(HOST_CONFIG, { force: true });
  const a = check1(payload);
  check('daemon sem Smart Tool: recusa sem a dica', a.verdict && !/read_document/.test(a.verdict.reason));
  withSmartTool();
  const b = check1(payload);
  check('daemon: Smart Tool instalado entre duas chamadas iguais, a dica aparece (cache não serve o veredito velho)', b.verdict && /read_document/.test(b.verdict.reason) && !b.cached, b.verdict && b.verdict.reason);
  const c = check1(payload);
  check('daemon: terceira chamada igual sai do cache com a dica', c.cached === true && /read_document/.test(c.verdict.reason));
  fs.rmSync(HOST_CONFIG, { force: true });
  const d = check1(payload);
  check('daemon: Smart Tool removido, a dica some', d.verdict && !/read_document/.test(d.verdict.reason));

  const growing = path.join(WORK, 'cresce.txt');
  fs.writeFileSync(growing, 'x'.repeat(800));
  const read = { tool_name: 'Read', tool_input: { file_path: growing }, cwd: WORK };
  const e = check1(read);
  check('daemon: arquivo pequeno é liberado', e.verdict === null);
  fs.writeFileSync(growing, 'x'.repeat(120000));
  const f = check1(read);
  check('daemon: o mesmo arquivo, agora grande, é barrado (a chave inclui o estado do alvo)', f.verdict && f.verdict.rule === 'blindRead' && !f.cached, f.verdict);
  fs.rmSync(growing);
  const g = check1(read);
  check('daemon: arquivo que sumiu não serve o veredito antigo', g.verdict === null && !g.cached);
}

console.log('\n  [redação por harness]');
{
  withSmartTool();
  const payload = { tool_name: 'Read', tool_input: { file_path: PDF }, cwd: WORK };
  const claude = decide(payload, { target: 'claude' }).reason;
  check('claude: manda carregar com ToolSearch', /ToolSearch/.test(claude) && /select:mcp__smart-tool__read_document/.test(claude), claude);
  for (const t of ['codex', 'cursor', 'copilot']) {
    const reason = decide(payload, { target: t }).reason;
    check(`${t}: cita read_document sem ToolSearch`, /read_document/.test(reason) && !/ToolSearch/.test(reason), reason);
  }
  const semTarget = decide(payload).reason;
  check('sem harness declarado: sem ToolSearch', /read_document/.test(semTarget) && !/ToolSearch/.test(semTarget));
  fs.rmSync(HOST_CONFIG, { force: true });
}

console.log('\n  [dupRead de PDF aponta pages]');
{
  const root = fs.mkdtempSync(path.join(WORK, 'dup-'));
  const cfg = { rules: { dupRead: true } };
  const body = 'p'.repeat(3000);
  const run2 = (file) => { const args = { name: 'Read', input: { file_path: file }, result: body, root, sessionId: 'dup-' + path.basename(file), cfg }; DR.noteResult(args); return DR.dedupe(args); };
  const pdf = path.join(root, 'a.pdf'); fs.writeFileSync(pdf, 'x');
  const txt = path.join(root, 'a.txt'); fs.writeFileSync(txt, 'x');
  const dupPdf = run2(pdf);
  check('releitura idêntica de PDF: manda reler com pages, não offset/limit', dupPdf && /pages/.test(dupPdf.additionalContext) && !/offset\/limit/.test(dupPdf.additionalContext), dupPdf && dupPdf.additionalContext);
  const dupTxt = run2(txt);
  check('releitura idêntica de texto segue com offset/limit', dupTxt && /offset\/limit/.test(dupTxt.additionalContext));
  const docx = path.join(root, 'a.docx'); fs.writeFileSync(docx, 'x');
  const dupDocx = run2(docx);
  check('releitura idêntica de Office: linhas não se aplicam, sem offset/limit', dupDocx && /não se aplicam/.test(dupDocx.additionalContext) && !/offset\/limit/.test(dupDocx.additionalContext), dupDocx && dupDocx.additionalContext);
}

console.log('\n  [bigResult de PDF e Office]');
{
  const big = 'y'.repeat(30000);
  const cfg = { rules: { bigResult: true }, limits: { resultCharsWithoutTrim: 1000, resultTrimKeepChars: 400 } };
  const post = (file, target) => PR.postProcess({ name: 'Read', input: { file_path: file }, result: big, root: WORK, cfg, target });
  fs.rmSync(HOST_CONFIG, { force: true });
  check('sem Smart Tool, PDF: só pages', !/read_document/.test(post(PDF, 'claude').additionalContext) && /pages/.test(post(PDF, 'claude').additionalContext));
  const docxSem = post(DOCX, 'claude').additionalContext;
  check('sem Smart Tool, docx: diz que linhas não se aplicam, sem read_document nem faixa de linhas', /lines do not apply/.test(docxSem) && !/read_document/.test(docxSem) && !/line range/.test(docxSem), docxSem);
  withSmartTool();
  const pdfClaude = post(PDF, 'claude').additionalContext;
  check('com Smart Tool, PDF no Claude Code: pages + read_document com ToolSearch', /pages/.test(pdfClaude) && /read_document/.test(pdfClaude) && /ToolSearch/.test(pdfClaude), pdfClaude);
  const docxCursor = post(DOCX, 'cursor').additionalContext;
  check('com Smart Tool, docx no Cursor: read_document sem ToolSearch e sem dica de linhas', /read_document/.test(docxCursor) && !/ToolSearch/.test(docxCursor) && !/line range/.test(docxCursor), docxCursor);
  fs.rmSync(HOST_CONFIG, { force: true });
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n  ${pass} passaram · ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
