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
 *     (subiu antes do install gravar o token), reinicia-o.
 * Nunca escreve no stdout: nada entra na janela do modelo.
 */

const http = require('http');
const P = require('../lib/payload.cjs');
const { tryDaemon, shutdownDaemon } = require('../lib/daemon-client.cjs');
const { checkHandshake } = require('../lib/daemon-lifecycle.cjs');
const { PROTOCOL_VERSION, PACKAGE_VERSION } = require('./daemon-server.cjs');
const DH = require('./daemon-http.cjs');

const ATTEMPTS = 6;
const PAUSE_MS = 250;

/** Algo responde na porta do hook http (404 numa rota qualquer basta). */
function httpListening() {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: DH.httpPort(), path: '/', method: 'GET', timeout: 500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function main() {
  process.stdout.on('error', () => {});
  try { await P.readPayload(); } catch { /* o payload não é usado */ }

  const expected = { protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION };
  const wantHttp = Boolean(DH.readToken());

  for (let i = 0; i < ATTEMPTS; i++) {
    const r = await tryDaemon('ping', {});
    if (!r.ok) break; // cliente desarmado: o stderr dele já explicou
    const current = checkHandshake(r.handshake, expected).ok; // velho é aposentado pelo próprio tryDaemon
    if (current && (!wantHttp || await httpListening())) return;
    if (current) await shutdownDaemon(); // de pé, mas sem HTTP: o próximo nasce lendo o token
    await new Promise((res) => setTimeout(res, PAUSE_MS));
  }
  process.stderr.write('token-guard: o daemon não ficou pronto no início da sessão — os hooks http vão falhar aberto até ele subir.\n');
}

if (require.main === module) main().catch(() => { /* nunca bloqueia o início da sessão */ });
module.exports = {};
