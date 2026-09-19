#!/usr/bin/env node
'use strict';
/**
 * post-hook.cjs — adapter do evento POST-execução (Claude Code PostToolUse).
 *
 * Duas funções pós-execução:
 *   1. bigResult: resultado >25k chars → stub + integral em disco + alternativa
 *   2. dupRead: registra leituras para dedupe na próxima chamada idêntica
 *
 * Diferença honesta vs Copilot plugin: o hook de comando do CC não substitui
 * o resultado — orienta. A substituição real é no modo plugin (modifiedResult).
 *
 * Fail-open: qualquer erro → silêncio. stdout error → noop.
 */

const P = require('../lib/payload.cjs');
const CFG = require('../lib/config.cjs');
const CT = require('../lib/contract.cjs');
const { noteResult, isRead } = require('../lib/dupread.cjs');
const { postProcess } = require('../lib/postresult.cjs');
const { tryDaemon } = require('../lib/daemon-client.cjs');

async function main() {
  process.stdout.on('error', () => {});
  const payload = await P.readPayload();

  const name = payload?.tool_name || payload?.toolName || '';
  const root = payload?.cwd || process.cwd();
  const inp = payload?.tool_input || payload?.toolInput || {};
  const result = payload?.tool_response ?? payload?.toolResponse ?? payload?.tool_result
    ?? payload?.tool_output;
  const sid = payload?.session_id || payload?.sessionId;

  const viaDaemon = await tryDaemon('postprocess', { name, input: inp, result, root, sessionId: sid });
  const trimmed = viaDaemon.ok
    ? viaDaemon.result.trimmed
    : postProcess({ name, input: inp, result, root, cfg: CFG.load(root) });
  if (trimmed) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput:
          typeof trimmed.modifiedResult === 'string' ? trimmed.modifiedResult : undefined,
        additionalContext: trimmed.additionalContext,
      },
    }));
    return;
  }

  // dupRead — registra hash da leitura para dedupe futuro. Se o daemon serviu
  // este postprocess, ele já rodou noteResult internamente (dispatchPostprocess).
  if (!viaDaemon.ok && sid && isRead(name)) {
    try {
      noteResult({ name, input: inp, result, root, sessionId: sid, cfg: CFG.load(root) });
    } catch { /* evidência */ }
  }
}

if (require.main === module) main().catch(() => {});
module.exports = {};
