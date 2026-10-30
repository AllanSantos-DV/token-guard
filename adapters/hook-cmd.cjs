#!/usr/bin/env node
'use strict';
/**
 * hook-cmd.cjs — adapter de hook PreToolUse no formato COMANDO.
 *
 * Serve DOIS harnesses com o mesmo binário, porque o contrato é idêntico:
 *   · GitHub Copilot CLI  — .github/hooks/hooks.json  (viaja no git)
 *   · Claude Code         — ~/.claude/settings.json   (escopo usuário ou projeto)
 *
 * Envelope de entrada (normalizado em lib/payload.cjs):
 *   Copilot/VS Code : { toolCall: { toolName, input } }
 *   Claude Code     : { tool_name, tool_input, cwd }
 *
 * Existe também o modo "plugin" (adapters/copilot-cli.mjs), que roda a MESMA
 * decisão in-process e por isso não paga o custo de spawn. Veja README › Escopo.
 *
 * ORÇAMENTO DE TEMPO
 * O custo dominante aqui é o cold start do Node (centenas de ms em Windows
 * corporativo, medido por bench/latency.cjs), não a lógica. A defesa é o "matcher" em hooks.json, que impede
 * o processo de nascer para ferramentas que nunca seriam barradas.
 *
 * Contrato de saída (verificado no runtime, aceito pelos dois harnesses):
 *   { hookSpecificOutput: { hookEventName:'PreToolUse',
 *       permissionDecision:'deny'|'allow', permissionDecisionReason:string } }
 *
 * Silêncio (stdout vazio) = libera. Qualquer erro interno = libera.
 * Um guard de economia jamais pode derrubar a sessão que ele deveria baratear.
 */

const P = require('../lib/payload.cjs');
const { decide } = require('../lib/decide.cjs');
const { tryDaemon } = require('../lib/daemon-client.cjs');
const H = require('../lib/claude-hooks.cjs');
const EV = require('../lib/events.cjs');

async function main() {
  const payload = await P.readPayload();
  const root = P.cwd(payload);

  const target = P.harnessOf(payload);
  const viaDaemon = await tryDaemon('check', { root, payload, target });
  // Com o daemon, ele já registrou o evento; sem ele, registra aqui (a tela enxerga os dois caminhos).
  const verdict = viaDaemon.ok ? viaDaemon.result.verdict : decide(payload, { target });
  if (!viaDaemon.ok) EV.recordDeny(verdict, target, payload);
  const out = H.preEnvelope(verdict);
  if (out) process.stdout.write(JSON.stringify(out));
}

main().catch(() => { /* falha do guard nunca bloqueia o agente */ });
