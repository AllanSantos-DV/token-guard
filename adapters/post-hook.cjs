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
const EV = require('../lib/events.cjs');
const { postProcess } = require('../lib/postresult.cjs');
const { tryDaemon } = require('../lib/daemon-client.cjs');
const H = require('../lib/claude-hooks.cjs');

async function main() {
  process.stdout.on('error', () => {});
  const payload = await P.readPayload();

  const { name, input: inp, result, root, sessionId: sid, agentId } = H.postArgs(payload);
  const win = H.windowKey(sid, agentId);

  const viaDaemon = await tryDaemon('postprocess', { name, input: inp, result, root, sessionId: sid, agentId }, { atMostOnce: true });
  // sent: o daemon pode ter registrado a leitura e só a resposta ter se perdido. Refazer aqui contaria
  // duas vezes (evidência, dupRead, rajada do scout); o corte do resultado grande é idempotente e segue local.
  const lost = !!viaDaemon.sent;
  // Evidência do contrato (gatilhos codigo/teste/docs) — o daemon já gravou se serviu.
  if (!viaDaemon.ok && !lost) CT.noteTouched(root, sid, inp);
  let trimmed = viaDaemon.ok ? viaDaemon.result.trimmed : null;
  if (!viaDaemon.ok) {
    const cfg = CFG.load(root, 'claude');
    // Guard desligado (global ou só para o Claude Code): nem corta, nem registra, nem sugere.
    if (cfg.mode !== 'off') {
      const ctx = { root, target: 'claude', name, input: inp, charsPerToken: cfg.charsPerToken };
      trimmed = postProcess({ name, input: inp, result, root, cfg, target: 'claude' });
      if (trimmed && !lost) EV.recordTrim(ctx, trimmed);
      if (!lost) {
        // dupRead — registra o hash da leitura e substitui a duplicata grande. Se o
        // daemon serviu este postprocess, ele já fez isso (dispatchPostprocess).
        if (!trimmed && sid && isRead(name)) {
          try {
            trimmed = dedupe({ name, input: inp, result, root, sessionId: win, cfg });
            if (trimmed) EV.recordSaving(ctx, 'dup', 'dupRead', trimmed.savedChars);
          } catch { /* evidência */ }
        }
        const before = trimmed;
        trimmed = SCOUT.withBurst(trimmed, { name, input: inp, root, sessionId: win, cfg });
        if (trimmed !== before) EV.recordSaving(ctx, 'scout', 'scout', 0);
      }
    }
  }
  if (trimmed) process.stdout.write(JSON.stringify(H.postEnvelope(trimmed)));
}

if (require.main === module) main().catch(() => {});
module.exports = {};
