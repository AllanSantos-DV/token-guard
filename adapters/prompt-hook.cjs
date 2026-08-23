#!/usr/bin/env node
'use strict';
/**
 * prompt-hook.cjs — adapter de INJEÇÃO do contrato de saída
 * (Claude Code UserPromptSubmit).
 *
 * Fecha o circuito que estava aberto: lib/contract.cjs existia com parsing,
 * gatilho por evidência e estado por sessão — mas nada o invocava em runtime.
 * Este adapter injeta as regras da camada "sempre" UMA VEZ por sessão,
 * direto no contexto, na primeira submissão de prompt.
 *
 * LIMITAÇÃO HONESTA (v1): o payload do UserPromptSubmit não traz arquivos
 * tocados, então os gatilhos por evidência (codigo/teste/docs) continuam sem
 * injeção automática aqui — a camada "sempre" é a que entra. O bloco
 * `subagente` segue manual (`token-guard contract --subagente`).
 *
 * Fail-open absoluto: qualquer erro = silêncio. Um hook de prompt jamais
 * pode bloquear ou poluir a sessão.
 */

const path = require('path');
const CFG = require('../lib/config.cjs');
const CT = require('../lib/contract.cjs');

async function main() {
  const P = require('../lib/payload.cjs');
  // EPIPE (harness fechou o pipe cedo) é evento de stream, não exceção:
  // sem isto o processo morre com stack — violando o silêncio do fail-open.
  process.stdout.on('error', () => {});
  const payload = await P.readPayload();

  const root = payload?.cwd || payload?.workingDirectory;
  // Sem cwd do harness não há contexto válido: operar sobre process.cwd()
  // gravaria estado no diretório errado (ex.: o próprio kit). Silêncio.
  if (!root) return;
  const sessionId = payload?.session_id || payload?.sessionId || 'sem-sessao';

  const cfg = CFG.load(root);
  if (cfg.mode === 'off') return;

  const contract = CT.load(root);
  if (!contract.order.length) return;

  const state = CT.readState(root, sessionId);
  const decision = CT.decide({ contract, touched: [], injected: state.injected });
  if (!decision.text) return;

  // EMITE antes de persistir: se a entrega falhar (pipe fechado), o estado
  // continua limpo e a próxima submissão reinjeta — nunca perder o contrato.
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: decision.text,
    },
  }));

  CT.writeState(root, sessionId, {
    injected: [...state.injected, ...decision.triggers],
  });
}

if (require.main === module) {
  main().catch(() => { /* fail-open, sempre */ });
}

module.exports = {};
