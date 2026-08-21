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
 * O custo dominante aqui é o cold start do Node (~200-300 ms em Windows
 * corporativo), não a lógica. A defesa é o "matcher" em hooks.json, que impede
 * o processo de nascer para ferramentas que nunca seriam barradas.
 *
 * Contrato de saída (verificado no runtime, aceito pelos dois harnesses):
 *   { hookSpecificOutput: { hookEventName:'PreToolUse',
 *       permissionDecision:'deny'|'allow'|'ask', permissionDecisionReason:string } }
 *
 * Silêncio (stdout vazio) = libera. Qualquer erro interno = libera.
 * Um guard de economia jamais pode derrubar a sessão que ele deveria baratear.
 */

const P = require('../lib/payload.cjs');
const { decide } = require('../lib/decide.cjs');

async function main() {
  const payload = await P.readPayload();
  const verdict = decide(payload);
  if (!verdict) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: verdict.reason,
    },
  }));
}

main().catch(() => { /* falha do guard nunca bloqueia o agente */ });
