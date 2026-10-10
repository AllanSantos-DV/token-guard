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
const { noteResult, isRead } = require('../lib/dupread.cjs');
const { postProcess } = require('../lib/postresult.cjs');
const { tryDaemon } = require('../lib/daemon-client.cjs');
const H = require('../lib/claude-hooks.cjs');

async function main() {
  process.stdout.on('error', () => {});
  const payload = await P.readPayload();

  const { name, input: inp, result, root, sessionId: sid } = H.postArgs(payload);

  const viaDaemon = await tryDaemon('postprocess', { name, input: inp, result, root, sessionId: sid });
  // Evidência do contrato (gatilhos codigo/teste/docs) — o daemon já gravou se serviu.
  if (!viaDaemon.ok) CT.noteTouched(root, sid, inp);
  const trimmed = viaDaemon.ok
    ? viaDaemon.result.trimmed
    : postProcess({ name, input: inp, result, root, cfg: CFG.load(root) });
  if (trimmed) {
    process.stdout.write(JSON.stringify(H.postEnvelope(trimmed)));
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
