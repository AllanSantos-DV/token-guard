#!/usr/bin/env node
'use strict';
/**
 * cursor-hook.cjs — adapter do Cursor (IDE e CLI).
 *
 * O Cursor não tem um evento genérico "antes de qualquer ferramenta". Ele tem
 * eventos NOMEADOS, cada um com o seu próprio formato. Este adapter existe para
 * traduzir esses eventos para o envelope que lib/decide.cjs já entende, e para
 * traduzir o veredito de volta ao contrato do Cursor.
 *
 * EVENTOS COBERTOS
 *   beforeReadFile        → sintetiza uma chamada de leitura     (blindRead, noisePath)
 *   beforeShellExecution  → sintetiza uma chamada de shell       (shellDump)
 *   beforeMCPExecution    → repassa tool_name/tool_input direto  (todas as regras)
 *
 * COBERTURA REAL — leia antes de esperar paridade
 *   O Cursor não expõe evento para grep/glob/busca semântica, então a regra
 *   broadScan NÃO tem como disparar aqui. No Cursor CLI (`cursor-agent`) só
 *   beforeShellExecution é entregue, o que reduz a cobertura a shellDump.
 *   Isso é limitação do harness, não deste adapter. Veja docs/IDES.md.
 *
 * CONTRATO DE SAÍDA
 *   { "permission": "allow" | "deny" | "ask",
 *     "userMessage": string,     // aparece para a pessoa
 *     "agentMessage": string }   // é o que o agente lê — aqui vai a correção
 *
 * FAIL-OPEN EXPLÍCITO
 *   O Cursor trata hook quebrado como fail-CLOSED (nega). Isso é o oposto do
 *   princípio deste projeto, então nós SEMPRE escrevemos um veredito válido:
 *   qualquer erro interno vira `allow` explícito, nunca silêncio.
 */

const P = require('../lib/payload.cjs');
const { decide } = require('../lib/decide.cjs');

/** O Cursor mapeia 'ask' para confirmação do usuário; 'deny' corta a chamada. */
const ALLOW = { permission: 'allow' };

function eventName(payload) {
  return P.firstString(payload?.hook_event_name, payload?.hookEventName, payload?.event);
}

function workspaceRoot(payload) {
  const roots = payload?.workspace_roots || payload?.workspaceRoots;
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0]) return roots[0];
  return P.cwd(payload);
}

/**
 * Traduz o evento do Cursor para o envelope canônico do token-guard.
 * @returns {object|null} payload normalizado, ou null se o evento não nos interessa
 */
function toCanonical(payload) {
  const evt = eventName(payload);
  const cwd = workspaceRoot(payload);

  if (evt === 'beforeReadFile') {
    const file = P.firstString(payload?.file_path, payload?.filePath, payload?.path);
    if (!file) return null;
    // O Cursor não informa faixa de linhas: para o núcleo, isto é leitura cega.
    return { toolName: 'read_file', toolInput: { path: file }, cwd };
  }

  if (evt === 'beforeShellExecution') {
    const command = P.firstString(payload?.command, payload?.cmd);
    if (!command) return null;
    return { toolName: 'bash', toolInput: { command }, cwd };
  }

  if (evt === 'beforeMCPExecution') {
    const name = P.firstString(payload?.tool_name, payload?.toolName);
    if (!name) return null;
    return { toolName: name, toolInput: payload?.tool_input || payload?.toolInput || {}, cwd };
  }

  return null; // afterFileEdit, stop, etc.: fora do escopo de economia de contexto
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj));
}

async function main() {
  let payload;
  try {
    payload = await P.readPayload();
  } catch {
    return respond(ALLOW);
  }

  let verdict = null;
  try {
    const canonical = toCanonical(payload);
    if (canonical) verdict = decide(canonical);
  } catch {
    return respond(ALLOW); // fail-open, sempre
  }

  if (!verdict) return respond(ALLOW);

  respond({
    permission: verdict.decision === 'ask' ? 'ask' : 'deny',
    userMessage: `token-guard: chamada barata disponível (regra: ${verdict.rule}).`,
    agentMessage: verdict.reason,
  });
}

// Só executa quando invocado como hook. Quando importado pelos testes, exporta
// apenas a tradução — nada de consumir stdin nem escrever em stdout.
if (require.main === module) {
  main().catch(() => respond(ALLOW));
}

module.exports = { toCanonical, eventName, workspaceRoot };
