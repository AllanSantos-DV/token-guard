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

fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n  ${pass} passaram · ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
