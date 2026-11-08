'use strict';

const { execFileSync } = require('child_process');

/**
 * Roda um comando externo sem janela e sem eco; devolve true se saiu com 0.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {boolean}
 */
function runQuiet(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = { runQuiet };
