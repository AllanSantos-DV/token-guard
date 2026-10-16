#!/usr/bin/env node
'use strict';
/**
 * session-start.cjs — hook SessionStart do Claude Code (A17).
 *
 * Um processo por SESSÃO (não por chamada) que deixa o daemon pronto antes da
 * primeira ferramenta:
 *   · sobe o daemon se ele não estiver de pé — a 1ª chamada da sessão não paga
 *     mais o bring-up (1,2-1,4 s medidos) e o hook http não cai em conexão
 *     recusada, que no Claude Code é fail-open (ferramenta passa sem guard);
 *   · aposenta daemon de versão antiga (handshake) e sobe o atual;
 *   · se há token de hook http no perfil mas o daemon de pé não abriu HTTP
 *     (subiu antes do install gravar o token), reinicia-o;
 *   · reaponta os hooks http do settings.json para a porta em que o daemon
 *     subiu de fato (daemon-http.json) — nada fica preso num endpoint antigo;
 *   · dispara o auto-update em segundo plano e relata o resultado do anterior.
 * Para o modelo não sai nada: o único stdout possível é `systemMessage`, que
 * vai ao usuário — usado só para falha (fail-loud) e para relatar o update.
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const P = require('../lib/payload.cjs');
const { tryDaemon, shutdownDaemon } = require('../lib/daemon-client.cjs');
const { checkHandshake } = require('../lib/daemon-lifecycle.cjs');
const AU = require('../lib/auto-update.cjs');
const DR = require('../lib/dupread.cjs');
const { PROTOCOL_VERSION, PACKAGE_VERSION } = require('./daemon-server.cjs');
const DH = require('./daemon-http.cjs');

const ATTEMPTS = 6;
const PAUSE_MS = 250;

/** ESTE daemon (token do dono) responde no health da porta registrada. */
function httpListening(port, token) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: DH.HEALTH, method: 'GET', timeout: 500,
      headers: { 'x-token-guard': token },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Garante daemon atual (e HTTP de pé, se há token). Devolve o problema, ou null. */
async function ensureDaemon() {
  const expected = { protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION };
  const token = DH.readToken();

  for (let i = 0; i < ATTEMPTS; i++) {
    const r = await tryDaemon('ping', {});
    // TOKEN_GUARD=off|warn faz o cliente nem tentar o daemon (lib/daemon-client.cjs): não é falha.
    // Sem token não há hook http: o hook de comando avalia inline sem o daemon.
    if (!r.ok) return !token || /^(off|0|false|warn)$/i.test(process.env.TOKEN_GUARD || '') ? null : 'o daemon não respondeu (cliente desarmado)';
    const current = checkHandshake(r.handshake, expected).ok; // velho é aposentado pelo próprio tryDaemon
    if (current && !token) return null;
    if (current) {
      // O daemon grava a porta logo após o bind: dá uma volta para ela aparecer.
      for (let k = 0; k < 4; k++) {
        if (await httpListening(DH.httpPort(), token)) {
          const sync = DH.syncClaudeSettings(DH.httpPort());
          return sync.ok ? null : `settings.json do Claude Code não reapontado: ${sync.error}`;
        }
        await new Promise((res) => setTimeout(res, PAUSE_MS));
      }
      const ep = DH.readEndpoint();
      if (ep && ep.error) return `hook http desligado — ${ep.error}`;
      await shutdownDaemon(); // de pé, mas sem HTTP: o próximo nasce lendo o token
    }
    await new Promise((res) => setTimeout(res, PAUSE_MS));
  }
  return 'o daemon não ficou pronto no início da sessão';
}

/** Auto-update em processo destacado e oculto: a sessão não espera rede nem npm. */
function launchAutoUpdate() {
  if (process.env.TOKEN_GUARD_UPDATE_CHECK === 'off') return;
  if (AU.enabled() && !AU.readInstallState()) return;
  try {
    spawn(process.execPath, [path.join(__dirname, '..', 'lib', 'auto-update.cjs')], {
      detached: true, stdio: 'ignore', windowsHide: true,
    }).unref();
  } catch { /* o próximo início de sessão tenta de novo */ }
}

async function main() {
  process.stdout.on('error', () => {});
  let payload = null;
  try { payload = await P.readPayload(); } catch { /* sem payload: nada a limpar */ }
  // Depois de compactar/limpar/retomar, a leitura anterior saiu da janela: o dedupe não pode apontar para ela.
  const sid = payload && (payload.session_id || payload.sessionId);
  if (sid && ['compact', 'clear', 'resume'].includes(payload.source)) DR.resetSession(payload.cwd || process.cwd(), sid);

  const messages = [];
  const problem = await ensureDaemon();
  if (problem) {
    messages.push(`token-guard: ${problem} — os hooks http vão falhar aberto (ferramentas sem guard) até o daemon subir.`);
  }
  const report = AU.takeReport();
  if (report) messages.push(report);
  const notice = AU.availableNotice(PACKAGE_VERSION);
  if (notice) messages.push(notice);
  launchAutoUpdate();

  if (messages.length) process.stdout.write(JSON.stringify({ systemMessage: messages.join('\n') }));
}

if (require.main === module) main().catch(() => { /* nunca bloqueia o início da sessão */ });
module.exports = {};
