'use strict';
/**
 * claude-hooks.cjs — o contrato de hook do Claude Code num lugar só.
 *
 * Os três eventos (PreToolUse, PostToolUse, UserPromptSubmit) chegam por dois
 * caminhos: hook de comando (adapters/*.cjs, um processo por chamada) e hook
 * http (servidor do daemon, sem processo). Os dois montam a resposta aqui —
 * mesma extração do payload, mesmo envelope, byte a byte.
 */

const crypto = require('crypto');

function preEnvelope(verdict) {
  if (!verdict) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  };
}

function postArgs(payload) {
  return {
    name: payload?.tool_name || payload?.toolName || '',
    input: payload?.tool_input || payload?.toolInput || {},
    result: payload?.tool_response ?? payload?.toolResponse ?? payload?.tool_result ?? payload?.tool_output,
    root: payload?.cwd || process.cwd(),
    sessionId: payload?.session_id || payload?.sessionId,
    // Presente só quando a chamada acontece dentro de um subagente (a janela dele é outra).
    agentId: payload?.agent_id || payload?.agentId,
  };
}

/**
 * Chave da JANELA de contexto: o subagente divide o `session_id` com o pai, mas tem janela própria.
 * Estado que descreve "o que esta janela já viu" (dupRead, rajada do scout) usa esta chave; o que
 * descreve a sessão inteira (contrato, evidência) segue no sessionId.
 */
function windowKey(sessionId, agentId) {
  return sessionId && agentId ? `${sessionId}~${agentId}` : sessionId;
}

/** String (Read/MCP texto) ou objeto de shell já cortado; o stub informativo
 *  (token_guard_truncated) não é formato que o harness aceite de volta. */
function replaceable(v) {
  return typeof v === 'string' ||
    (Boolean(v) && typeof v === 'object' && !Array.isArray(v) && !v.token_guard_truncated);
}

function postEnvelope(trimmed) {
  if (!trimmed) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: replaceable(trimmed.modifiedResult) ? trimmed.modifiedResult : undefined,
      additionalContext: trimmed.additionalContext,
    },
  };
}

/** Raiz e sessão do UserPromptSubmit; null = sem cwd do harness (não há contexto válido). */
function promptArgs(payload) {
  const root = payload?.cwd || payload?.workingDirectory;
  if (!root) return null;
  // Sem id do harness: deriva da RAIZ (não um 'sem-sessao' global que
  // misturaria sessões de repositórios diferentes na mesma máquina).
  const sessionId = payload?.session_id || payload?.sessionId
    || `sess-${crypto.createHash('sha1').update(root).digest('hex').slice(0, 8)}`;
  return { root, sessionId, transcriptPath: payload?.transcript_path || payload?.transcriptPath };
}

/** `warning` vai ao usuário (systemMessage), não ao modelo: não custa token. */
function promptEnvelope(text, warning) {
  if (!text && !warning) return null;
  const out = {};
  if (text) out.hookSpecificOutput = { hookEventName: 'UserPromptSubmit', additionalContext: text };
  if (warning) out.systemMessage = warning;
  return out;
}

module.exports = { preEnvelope, postArgs, windowKey, postEnvelope, promptArgs, promptEnvelope };
