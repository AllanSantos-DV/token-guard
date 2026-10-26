#!/usr/bin/env node
'use strict';
/**
 * subagent-start.cjs — hook SubagentStart do Claude Code (P1).
 *
 * Injeta o bloco `subagente` do contrato no início da conversa do scout, antes
 * do primeiro prompt: quem roda em contexto descartável devolve só dado, sem a
 * cola manual de `token-guard contract --subagente`. O matcher do registro
 * (`^scout$`) limita o hook ao scout; o evento não bloqueia a criação do subagente.
 *
 * Fail-open absoluto: qualquer erro = silêncio.
 */

const CFG = require('../lib/config.cjs');
const CT = require('../lib/contract.cjs');

/** Texto do bloco `subagente` para a raiz; '' quando o guard está off ou o contrato não o define. */
function subagentContext(root) {
  if (CFG.load(root).mode === 'off') return '';
  return CT.subagentText(CT.load(root));
}

function envelope(text) {
  if (!text) return null;
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } };
}

async function main() {
  const P = require('../lib/payload.cjs');
  process.stdout.on('error', () => {});
  const payload = await P.readPayload();
  const root = payload?.cwd;
  const out = root && envelope(subagentContext(root));
  if (out) process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
  main().catch(() => { /* fail-open, sempre */ });
}

module.exports = { subagentContext, envelope };
