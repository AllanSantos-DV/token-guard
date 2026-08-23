#!/usr/bin/env node
'use strict';
/**
 * post-hook.cjs — adapter do evento POST-execução (Claude Code PostToolUse).
 *
 * Diferença honesta para o modo plugin do Copilot: o hook de comando do
 * Claude Code não substitui o resultado que já entrou na janela — ele ORIENTA.
 * O que este adapter entrega:
 *   · a versão integral da saída gigante gravada em .token-guard/results/;
 *   · um aviso com a alternativa barata pronta para reexecutar;
 *   · calibração: o agente aprende a limitar na próxima chamada.
 * A economia real por substituição acontece no modo plugin (Copilot SDK,
 * modifiedResult) — veja adapters/copilot-cli.mjs e docs/IDES.md.
 *
 * Contrato de saída: silêncio = nada a fazer. Erro interno = silêncio
 * (fail-open: um pós-processador jamais pode perturbar a sessão).
 */

const P = require('../lib/payload.cjs');
const CFG = require('../lib/config.cjs');
const { postProcess } = require('../lib/postresult.cjs');

async function main() {
  // EPIPE (harness fechou o pipe cedo) é evento de stream, não exceção:
  // sem isto o processo morre com stack — violando o silêncio do fail-open.
  process.stdout.on('error', () => {});

  const payload = await P.readPayload();

  const name = payload?.tool_name || payload?.toolName || '';
  const root = payload?.cwd || process.cwd();
  const cfg = CFG.load(root);

  const verdict = postProcess({
    name,
    input: payload?.tool_input || payload?.toolInput || {},
    result: payload?.tool_response ?? payload?.toolResponse ?? payload?.tool_result,
    root,
    cfg,
  });

  if (!verdict) return;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: verdict.additionalContext,
    },
  }));
}

if (require.main === module) {
  main().catch(() => { /* fail-open, sempre */ });
}

module.exports = { };
