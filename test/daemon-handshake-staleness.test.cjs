#!/usr/bin/env node
'use strict';
/**
 * daemon-handshake-staleness.test.cjs — cliente detecta um daemon com
 * `handshake` diferente da versão local (embutido em toda resposta, não só
 * em `hello`) e pede `shutdown` pra ele, sem afetar o resultado já obtido
 * nem quebrar contra um daemon antigo que não conhece o método `shutdown`.
 * Seams 100% injetados, igual test/daemon-faulttolerance.test.cjs.
 */

require('./bootstrap.cjs');

const { createClient } = require('../lib/daemon-client.cjs');
const { handleMessage, PROTOCOL_VERSION, PACKAGE_VERSION } = require('../adapters/daemon-server.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function testHandshakeEmbeddedEmTodaResposta() {
  const ctx = { cache: new Map(), hits: 0, misses: 0 };
  const reply = handleMessage({ id: 1, method: 'ping' }, ctx);
  check('handshake vem em toda resposta, não só em hello',
    reply.handshake && reply.handshake.protocolVersion === PROTOCOL_VERSION && reply.handshake.packageVersion === PACKAGE_VERSION,
    JSON.stringify(reply));

  const errReply = handleMessage({ id: 2, method: 'nope' }, ctx);
  check('handshake também vem em resposta de erro', !!(errReply.handshake), JSON.stringify(errReply));
}

async function testClientPedeShutdownQuandoStale() {
  const connectCalls = [];
  const client = createClient({
    connectFn: async (method) => {
      connectCalls.push(method);
      if (method === 'check') {
        return { ok: true, result: { verdict: 'ok' }, handshake: { protocolVersion: PROTOCOL_VERSION, packageVersion: '0.0.1-stale' } };
      }
      if (method === 'shutdown') return { ok: true, result: { ok: true } };
      return { ok: false };
    },
  });

  const res = await client.tryDaemon('check', {}, { endpoint: 'fake' });
  check('devolve o resultado do daemon stale mesmo assim (fail-open, não bloqueia a decisão)',
    res.ok === true && res.result.verdict === 'ok');
  check('pediu shutdown pro daemon stale', connectCalls.includes('shutdown'), connectCalls.join(','));
}

async function testClientNaoPedeShutdownQuandoAtualizado() {
  const connectCalls = [];
  const client = createClient({
    connectFn: async (method) => {
      connectCalls.push(method);
      return { ok: true, result: { verdict: 'ok' }, handshake: { protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION } };
    },
  });

  const res = await client.tryDaemon('check', {}, { endpoint: 'fake' });
  check('resultado normal quando versão bate', res.ok === true);
  check('NÃO pede shutdown quando o daemon já está na versão atual', !connectCalls.includes('shutdown'), connectCalls.join(','));
}

async function testClientToleraAusenciaDeHandshake() {
  // Daemon hipotético de uma versão anterior a este handshake embutido —
  // resposta sem o campo `handshake` não pode derrubar nem travar o cliente.
  const connectCalls = [];
  const client = createClient({
    connectFn: async (method) => {
      connectCalls.push(method);
      return { ok: true, result: { verdict: 'ok' } }; // sem handshake
    },
  });

  const res = await client.tryDaemon('check', {}, { endpoint: 'fake' });
  check('resultado normal quando a resposta não traz handshake', res.ok === true);
  check('não tenta shutdown sem handshake pra comparar', !connectCalls.includes('shutdown'), connectCalls.join(','));
}

async function testServerHonraShutdown() {
  let shutdownCalled = false;
  const ctx = { cache: new Map(), hits: 0, misses: 0, requestShutdown: () => { shutdownCalled = true; } };
  const reply = handleMessage({ id: 1, method: 'shutdown' }, ctx);
  check('server responde ok à requisição de shutdown', reply.result && reply.result.ok === true);
  await new Promise((r) => setImmediate(r));
  check('server invoca o callback de shutdown injetado', shutdownCalled === true);
}

async function testServerToleraShutdownSemCallback() {
  const ctx = { cache: new Map(), hits: 0, misses: 0 }; // sem requestShutdown (ex.: createServer() direto, sem start())
  const reply = handleMessage({ id: 1, method: 'shutdown' }, ctx);
  check('shutdown sem callback injetado não lança nem derruba o handler', reply.result && reply.result.ok === true);
}

(async () => {
  await testHandshakeEmbeddedEmTodaResposta();
  await testClientPedeShutdownQuandoStale();
  await testClientNaoPedeShutdownQuandoAtualizado();
  await testClientToleraAusenciaDeHandshake();
  await testServerHonraShutdown();
  await testServerToleraShutdownSemCallback();

  console.log(`\n  daemon-handshake-staleness: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
