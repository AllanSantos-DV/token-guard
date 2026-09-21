#!/usr/bin/env node
'use strict';
/**
 * daemon-faulttolerance.test.cjs — F5: start-on-demand, self-heal, disarm-K
 * em lib/daemon-client.cjs. Seams 100% injetados (spawnFn/nowFn/connectFn/
 * sleepFn) — zero subprocess real, zero corrida de timing real. Estilo
 * manual check/pass/fail, igual test/epipe.test.cjs.
 */

require('./bootstrap.cjs');

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createClient, realSpawn, DEFAULT_DAEMON_SERVER_PATH } = require('../lib/daemon-client.cjs');
const { defaultLockPath } = require('../adapters/daemon-server.cjs');

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

/** nowFn cujo cada chamada já avança além de qualquer bootTimeoutMs pequeno —
 * faz waitForEndpoint expirar depois de exatamente UMA tentativa de 'hello',
 * sem depender de sleepFn real. */
function expiringNowFn() {
  let n = 0;
  return () => {
    const v = n;
    n += 100;
    return v;
  };
}

async function testStartOnDemand() {
  console.log('\n  [start-on-demand: daemon ausente, sobe e serve o request]');

  const spawnCalls = [];
  const connectCalls = [];
  const client = createClient({
    spawnFn: (daemonServerPath) => { spawnCalls.push(daemonServerPath); },
    nowFn: Date.now,
    sleepFn: () => Promise.resolve(),
    connectFn: async (method, params, opts) => {
      connectCalls.push(method);
      if (method === 'hello') return { ok: true, result: {} };
      if (connectCalls.filter((m) => m === 'check').length === 1) {
        return { ok: false }; // primeira tentativa: daemon ainda não está de pé
      }
      return { ok: true, result: { verdict: 'ok' } }; // reenvio após bring-up
    },
    bootTimeoutMs: 1000,
    pollIntervalMs: 10,
    maxSpawnAttempts: 3,
  });

  const res = await client.tryDaemon('check', { a: 1 });
  check('resultado ok:true com o result do reenvio', res.ok === true && res.result && res.result.verdict === 'ok',
    JSON.stringify(res));
  check('spawnFn chamado exatamente 1 vez', spawnCalls.length === 1, `chamado ${spawnCalls.length}x`);
  check('sequência de métodos: check, hello, check', connectCalls.join(',') === 'check,hello,check',
    connectCalls.join(','));
}

async function testSelfHeal() {
  console.log('\n  [self-heal: socket cai entre duas chamadas, religa exatamente uma vez]');

  const spawnCalls = [];
  const connectCalls = [];
  let firstCallDone = false;
  const client = createClient({
    spawnFn: (daemonServerPath) => { spawnCalls.push(daemonServerPath); },
    nowFn: Date.now,
    sleepFn: () => Promise.resolve(),
    connectFn: async (method) => {
      connectCalls.push(method);
      if (!firstCallDone) {
        // primeira chamada de tryDaemon: daemon já está de pé, serve direto
        if (method === 'check') return { ok: true, result: { verdict: 'first' } };
      }
      if (method === 'hello') return { ok: true, result: {} };
      // segunda chamada: primeiro 'check' falha (socket morto), reenvio depois do bring-up sucede
      const checksSoFar = connectCalls.filter((m) => m === 'check').length;
      if (checksSoFar === 2) return { ok: false };
      return { ok: true, result: { verdict: 'second' } };
    },
    bootTimeoutMs: 1000,
    pollIntervalMs: 10,
    maxSpawnAttempts: 3,
  });

  const first = await client.tryDaemon('check', {});
  firstCallDone = true;
  check('primeira chamada serviu direto (daemon já de pé)', first.ok === true && first.result.verdict === 'first',
    JSON.stringify(first));
  check('spawnFn não chamado na primeira chamada', spawnCalls.length === 0, `chamado ${spawnCalls.length}x`);

  const second = await client.tryDaemon('check', {});
  check('segunda chamada se autocura e serve', second.ok === true && second.result.verdict === 'second',
    JSON.stringify(second));
  check('spawnFn chamado exatamente 1 vez no total (só na 2ª chamada)', spawnCalls.length === 1,
    `chamado ${spawnCalls.length}x`);
}

async function testCustomEndpointPropagatesToSpawn() {
  console.log('\n  [endpoint customizado: spawnFn recebe o MESMO endpoint que o polling usa]');

  const spawnArgs = [];
  const connectCalls = [];
  const connectEndpoints = [];
  const client = createClient({
    spawnFn: (daemonServerPath, endpoint) => { spawnArgs.push([daemonServerPath, endpoint]); },
    nowFn: Date.now,
    sleepFn: () => Promise.resolve(),
    connectFn: async (method, params, opts) => {
      connectCalls.push(method);
      connectEndpoints.push(opts && opts.endpoint);
      if (method === 'hello') return { ok: true, result: {} };
      if (connectCalls.filter((m) => m === 'check').length === 1) {
        return { ok: false }; // primeira tentativa: daemon ainda não está de pé no endpoint custom
      }
      return { ok: true, result: { verdict: 'ok' } }; // reenvio após bring-up
    },
    bootTimeoutMs: 1000,
    pollIntervalMs: 10,
    maxSpawnAttempts: 3,
  });

  const res = await client.tryDaemon('check', {}, { endpoint: '/tmp/custom-endpoint.sock' });
  check('resultado ok:true', res.ok === true, JSON.stringify(res));
  check('spawnFn recebeu o endpoint customizado (não o default)',
    spawnArgs.length === 1 && spawnArgs[0][1] === '/tmp/custom-endpoint.sock',
    JSON.stringify(spawnArgs));
  check('todo polling/reenvio usou o MESMO endpoint customizado',
    connectEndpoints.every((e) => e === '/tmp/custom-endpoint.sock'),
    connectEndpoints.join(','));
}

async function testRealSubprocessHonorsArgvEndpoint() {
  console.log('\n  [integração real: subprocess de verdade honra endpoint via argv, não coincidência de env]');

  // Endpoint arbitrário — NÃO é o que defaultEndpoint() produziria (nem por
  // TOKEN_GUARD_SID nem por pid): se o filho real ignorasse argv[2] e
  // recalculasse defaultEndpoint() por conta própria (o bug original), a
  // conexão abaixo falharia (ninguém escutando nesse endpoint específico).
  const tmpBase = process.platform === 'win32' ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'tg-argv-propagation-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\tg-argv-propagation-test-${process.pid}`
    : path.join(tmpBase, 'd.sock');

  // Remove TOKEN_GUARD_SID do env do processo de teste antes do spawn: prova
  // que a convergência não é coincidência via env (realSpawn herda o env do
  // pai), só via argv.
  const hadSid = Object.prototype.hasOwnProperty.call(process.env, 'TOKEN_GUARD_SID');
  const prevSid = process.env.TOKEN_GUARD_SID;
  delete process.env.TOKEN_GUARD_SID;

  // DECISÃO (achado da rodada 3 de revisão independente F5): diferente dos
  // subprocessos "-e" de test/daemon-singleton.test.cjs, este spawna o
  // ENTRYPOINT CLI real de produção (`realSpawn` -> `node
  // adapters/daemon-server.cjs <endpoint>`) de propósito — é exatamente esse
  // entrypoint (`if (require.main === module) start(process.argv[2] ||
  // undefined)`) que este teste precisa provar, então não dá pra embutir um
  // self-destruct DENTRO do processo filho sem tocar código de produção só
  // por causa de um teste (fora de escopo aqui). Mitigação aceita: orçamento
  // de tempo generoso (5s, igual ao teto de daemon-singleton.test.cjs) +
  // `finally` que sempre mata o filho nos dois caminhos normais (sucesso e
  // timeout). Risco residual: só se o PRÓPRIO processo de teste morrer de
  // forma anormal (SIGKILL externo) antes do finally — não coberto, aceito
  // porque o CI deste projeto não usa `timeout-minutes`/`concurrency` que
  // cancelariam o job no meio.
  let child;
  let connected = false;
  try {
    child = realSpawn(DEFAULT_DAEMON_SERVER_PATH, endpoint);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !connected) {
      connected = await new Promise((resolve) => {
        const sock = net.connect(endpoint);
        sock.once('connect', () => { sock.destroy(); resolve(true); });
        sock.once('error', () => resolve(false));
      });
      if (!connected) await new Promise((r) => { setTimeout(r, 50); });
    }
  } finally {
    if (hadSid) process.env.TOKEN_GUARD_SID = prevSid; else delete process.env.TOKEN_GUARD_SID;
    try { if (child) process.kill(child.pid); } catch { /* melhor esforço */ }
    if (tmpBase) { try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* melhor esforço */ } }
    // Achado da rodada 4 de revisão independente F5: `realSpawn` sobe o
    // `start()` real de produção, que SEMPRE grava um lock-record (F4,
    // `DL.acquireLock`) — no POSIX ele mora dentro de `tmpBase` (já limpo
    // acima), mas no Windows vive num caminho fixo fora do endpoint
    // (`os.tmpdir()/token-guard-locks/<pipe>.lock`, via `defaultLockPath`),
    // nunca coberto pela limpeza do ramo POSIX. Sem isto, cada execução local
    // deste teste no Windows deixava um `.lock` órfão acumulando em %TEMP%.
    try { fs.rmSync(defaultLockPath(endpoint), { force: true }); } catch { /* melhor esforço */ }
  }

  check('subprocess real (spawn de verdade, node adapters/daemon-server.cjs) ficou de pé ' +
    'exatamente no endpoint arbitrário passado via argv', connected, endpoint);
}

async function testDisarm() {
  console.log('\n  [disarm-K: 3 falhas seguidas de bring-up desarmam o cliente]');

  const spawnCalls = [];
  const origStderrWrite = process.stderr.write;
  let stderrOutput = '';
  process.stderr.write = (chunk, ...args) => {
    stderrOutput += chunk;
    return origStderrWrite.call(process.stderr, chunk, ...args);
  };

  const client = createClient({
    spawnFn: (daemonServerPath) => { spawnCalls.push(daemonServerPath); },
    nowFn: expiringNowFn(),
    sleepFn: () => Promise.resolve(),
    connectFn: async () => ({ ok: false }), // hello e check inicial sempre falham
    bootTimeoutMs: 10,
    pollIntervalMs: 5,
    maxSpawnAttempts: 3,
  });

  const res = await client.tryDaemon('check', {});
  process.stderr.write = origStderrWrite;

  check('resultado final ok:false', res.ok === false, JSON.stringify(res));
  check('spawnFn chamado exatamente maxSpawnAttempts (3) vezes', spawnCalls.length === 3,
    `chamado ${spawnCalls.length}x`);
  check('log de stderr emitido sobre desarme', /desarmado/.test(stderrOutput), stderrOutput);

  const res2 = await client.tryDaemon('check', {});
  check('após desarmar, chamada seguinte não spawna de novo', spawnCalls.length === 3,
    `chamado ${spawnCalls.length}x após 2ª tryDaemon`);
  check('após desarmar, chamada seguinte devolve ok:false direto', res2.ok === false, JSON.stringify(res2));
}

async function main() {
  await testStartOnDemand();
  await testSelfHeal();
  await testCustomEndpointPropagatesToSpawn();
  await testRealSubprocessHonorsArgvEndpoint();
  await testDisarm();

  console.log('');
  console.log(`  ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}

main();
