'use strict';
/**
 * decide.cjs — a decisão, em um só lugar.
 *
 * Os dois modos de execução compartilham este módulo, para que o comportamento
 * seja idêntico nos dois:
 *   · hook de comando  (token-guard.cjs)  — escopo repositório, viaja no git
 *   · hook in-process  (extension.mjs)    — escopo máquina, sem custo de spawn
 *
 * Contrato: decide(payload) → null (libera) | { decision, reason }
 */

const P = require('./payload.cjs');

/**
 * Triagem barata por nome de ferramenta.
 * Deliberadamente permissiva: casa por substring, então variantes desconhecidas
 * de harness continuam entrando no guard em vez de escaparem em silêncio.
 */
const WATCHED = /(view|read|grep|glob|search|list_dir|list_files|list_director|bash|shell|powershell|pwsh|terminal|run_command|execute_command|find_files|cat_file|open_file|ripgrep)/i;

function isWatched(name) {
  return Boolean(name) && WATCHED.test(name);
}

/**
 * @param {object} payload  em qualquer formato de runtime suportado
 * @returns {{decision:'deny'|'ask', reason:string, rule:string}|null}
 */
function decide(payload) {
  try {
    const name = P.toolName(payload);
    if (!isWatched(name)) return null;

    // require preguiçoso: o caso comum (ferramenta não vigiada) sai sem tocar em disco
    const CFG = require('./config.cjs');
    const root = P.cwd(payload);
    const cfg = CFG.load(root);
    if (cfg.mode === 'off') return null;

    const RULES = require('./rules.cjs');
    const input = P.toolInput(payload);
    const stats = CFG.repoStats(root);

    const hit = RULES.evaluate({ name, input, root, cfg, stats, P });
    if (!hit) return null;

    const suffix = stats
      ? ''
      : '\n[dica: rode `npx token-guard audit` uma vez — com as estatísticas em cache ' +
        'o guard calibra os limites ao tamanho real deste repositório.]';

    const reason = hit.reason + suffix;

    if (cfg.mode === 'warn') {
      return {
        decision: 'ask',
        rule: hit.id,
        reason: `[aviso — token-guard em modo "warn"; a chamada segue se você confirmar]\n${reason}`,
      };
    }
    return { decision: 'deny', rule: hit.id, reason };
  } catch {
    return null; // fail-open absoluto: payload hostil nunca derruba nem bloqueia
  }
}

module.exports = { decide, isWatched, WATCHED };
