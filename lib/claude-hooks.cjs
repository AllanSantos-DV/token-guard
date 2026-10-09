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
  };
}

function postEnvelope(trimmed) {
  if (!trimmed) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      updatedToolOutput: typeof trimmed.modifiedResult === 'string' ? trimmed.modifiedResult : undefined,
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
  return { root, sessionId };
}

function promptEnvelope(text) {
  if (!text) return null;
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } };
}

module.exports = { preEnvelope, postArgs, postEnvelope, promptArgs, promptEnvelope };
