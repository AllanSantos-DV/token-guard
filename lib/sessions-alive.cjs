'use strict';
/**
 * sessions-alive.cjs — há sessão de Claude Code ou de Codex aberta nesta máquina?
 *
 * O daemon só pode sair por ociosidade quando ninguém o usa de verdade: uma sessão parada por
 * minutos continua dona de hooks que vão chamá-lo de novo. Claude Code registra cada sessão em
 * `~/.claude/sessions/<pid>.json`; o Codex mantém um lock exclusivo por thread aberta em
 * `~/.codex/thread-writer-locks/`. Sem registro legível, o resultado é zero (não bloqueia a saída).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** O processo `pid` existe (EPERM conta: existe, mas é de outro usuário). */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

/** Sessões do Claude Code cujo processo ainda existe. */
function claudeSessions(home) {
  const dir = path.join(home, '.claude', 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (m && pidAlive(Number(m[1]))) n++;
  }
  return n;
}

/**
 * Threads do Codex abertas: o lock de uma thread viva está aberto sem compartilhamento, e abrir
 * o arquivo falha com EBUSY/EPERM. Só o Windows dá esse sinal; no resto não há como saber.
 */
function codexSessions(home) {
  if (process.platform !== 'win32') return 0;
  const dir = path.join(home, '.codex', 'thread-writer-locks');
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.lock') || name.startsWith('.')) continue;
    try {
      fs.closeSync(fs.openSync(path.join(dir, name), 'r+'));
    } catch (err) {
      if (err.code === 'EBUSY' || err.code === 'EPERM') n++;
    }
  }
  return n;
}

/**
 * @param {string} [home] raiz do perfil (padrão: o do usuário; testes passam uma pasta própria)
 * @returns {{claude:number, codex:number, total:number}}
 */
function liveSessions(home = os.homedir()) {
  const claude = claudeSessions(home);
  const codex = codexSessions(home);
  return { claude, codex, total: claude + codex };
}

module.exports = { liveSessions };
