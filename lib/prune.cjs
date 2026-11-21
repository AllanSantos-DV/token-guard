'use strict';
/**
 * prune.cjs — poda de arquivos de estado velhos, no máximo uma vez por hora por pasta.
 *
 * Podar a cada gravação custa um stat por arquivo da pasta, que só cresce enquanto as sessões
 * duram; o daemon e o hook pagam isso dentro do orçamento curto de cada chamada. A hora da última
 * poda fica no mtime de um arquivo marcador dentro da pasta.
 */

const fs = require('fs');
const path = require('path');

const STAMP = '.pruned';
const EVERY_MS = 60 * 60 * 1000;

/**
 * Apaga de `dir` o que não é tocado há mais de `ttlMs`.
 * @param {string} dir
 * @param {number} ttlMs
 * @param {number} [now]
 */
function pruneOlder(dir, ttlMs, now = Date.now()) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try { if (now - fs.statSync(p).mtimeMs > ttlMs) fs.unlinkSync(p); } catch { /* sumiu no caminho */ }
    }
  } catch { /* pasta ausente */ }
}

/**
 * Como `pruneOlder`, mas só se a última poda de `dir` tem mais de uma hora.
 * @param {string} dir
 * @param {number} ttlMs
 * @param {number} [now]
 */
function pruneOlderIfDue(dir, ttlMs, now = Date.now()) {
  const stamp = path.join(dir, STAMP);
  try { if (now - fs.statSync(stamp).mtimeMs < EVERY_MS) return; } catch { /* nunca podou */ }
  pruneOlder(dir, ttlMs, now);
  try { fs.writeFileSync(stamp, '', 'utf8'); } catch { /* a próxima gravação poda de novo */ }
}

module.exports = { pruneOlder, pruneOlderIfDue };
