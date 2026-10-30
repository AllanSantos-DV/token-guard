#!/usr/bin/env node
'use strict';
/**
 * post-hook.cjs — adapter do evento POST-execução (Claude Code PostToolUse).
 *
 * Três funções pós-execução:
 *   1. evidência do contrato: o arquivo tocado alimenta os gatilhos codigo/teste/docs
 *   2. bigResult: resultado >25k chars → stub + integral em disco + alternativa
 *      (substitui via updatedToolOutput no Claude Code ≥ 2.1.121; antes, só orienta)
 *   3. dupRead: registra leituras para dedupe na próxima chamada idêntica
 *
 * Fail-open: qualquer erro → silêncio. stdout error → noop.
 */

const P = require('../lib/payload.cjs');
const CFG = require('../lib/config.cjs');
const CT = require('../lib/contract.cjs');
const { dedupe, isRead } = require('../lib/dupread.cjs');
const SCOUT = require('../lib/scout.cjs');
const { postProcess } = require('../lib/postresult.cjs');
const { tryDaemon } = require('../lib/daemon-client.cjs');
const H = require('../lib/claude-hooks.cjs');

async function main() {
  process.stdout.on('error', () => {});
  const payload = await P.readPayload();

  const { name, input: inp, result, root, sessionId: sid, agentId } = H.postArgs(payload);
  const win = H.windowKey(sid, agentId);

  const viaDaemon = await tryDaemon('postprocess', { name, input: inp, result, root, sessionId: sid, agentId });
  // Evidência do contrato (gatilhos codigo/teste/docs) — o daemon já gravou se serviu.
  if (!viaDaemon.ok) CT.noteTouched(root, sid, inp);
  let trimmed = viaDaemon.ok ? viaDaemon.result.trimmed : null;
  if (!viaDaemon.ok) {
    const cfg = CFG.load(root, 'claude');
    // Guard desligado (global ou só para o Claude Code): nem corta, nem registra, nem sugere.
    if (cfg.mode !== 'off') {
      trimmed = postProcess({ name, input: inp, result, root, cfg });
      // dupRead — registra o hash da leitura e substitui a duplicata grande. Se o
      // daemon serviu este postprocess, ele já fez isso (dispatchPostprocess).
      if (!trimmed && sid && isRead(name)) {
        try { trimmed = dedupe({ name, input: inp, result, root, sessionId: win, cfg }); } catch { /* evidência */ }
      }
      trimmed = SCOUT.withBurst(trimmed, { name, input: inp, root, sessionId: win, cfg });
    }
  }
  if (trimmed) process.stdout.write(JSON.stringify(H.postEnvelope(trimmed)));
}

if (require.main === module) main().catch(() => {});
module.exports = {};
