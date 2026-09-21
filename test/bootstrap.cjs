'use strict';
/**
 * bootstrap.cjs — isolamento obrigatório de qualquer teste que exercite
 * `decide()` ou spawne um dos hooks. Deve ser o PRIMEIRO require do arquivo.
 *
 * Três vazamentos do ambiente de quem roda `npm test` mudam o veredito e
 * fazem o teste passar ou falhar por motivo alheio ao código:
 *
 *   1. Config global (`~/.claude|.copilot|.cursor|.token-guard/
 *      token-guard.config.json`) — um `mode: "warn"` no perfil do dev vira
 *      `ask` onde o teste espera `deny`. Defesa: HOME/USERPROFILE apontando
 *      pra um diretório vazio, que é de onde `os.homedir()` sai.
 *   2. Daemon da sessão real. `defaultEndpoint()` deriva o pipe/socket do
 *      usuário do SO, NÃO do HOME — então redirecionar o home não basta: o
 *      hook spawnado pelo teste alcança o daemon que já estava de pé, carregado
 *      com a config real. Defesa: `TOKEN_GUARD_SID` próprio por processo de
 *      teste (daemon dedicado) + idle curto, pra ele não sobreviver à rodada.
 *   3. `TOKEN_GUARD` no shell do dev, que desliga ou afrouxa o guard inteiro.
 *      Defesa: remover do ambiente; quem testa escape hatch passa a var no
 *      env do spawn, caso a caso.
 *
 * A restauração roda em `process.on('exit')` — nenhum teste precisa lembrar.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ISOLATED_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-isolated-home-'));

const SAVED = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  TOKEN_GUARD: process.env.TOKEN_GUARD,
  TOKEN_GUARD_SID: process.env.TOKEN_GUARD_SID,
  TOKEN_GUARD_DAEMON_IDLE_MS: process.env.TOKEN_GUARD_DAEMON_IDLE_MS,
};

process.env.HOME = ISOLATED_HOME;
process.env.USERPROFILE = ISOLATED_HOME;
delete process.env.TOKEN_GUARD;
process.env.TOKEN_GUARD_SID = `tg-test-${process.pid}`;
process.env.TOKEN_GUARD_DAEMON_IDLE_MS = SAVED.TOKEN_GUARD_DAEMON_IDLE_MS || '15000';

try { require('../lib/config.cjs').clearMemo(); } catch { /* config ainda não carregada */ }

let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fs.rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch { /* melhor esforço */ }
  try { require('../lib/config.cjs').clearMemo(); } catch { /* noop */ }
}

process.on('exit', restore);

module.exports = { ISOLATED_HOME, restore };
