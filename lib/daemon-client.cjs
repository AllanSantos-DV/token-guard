'use strict';
/**
 * lib/daemon-client.cjs — cliente único usado pelos três hooks pra falar com
 * o daemon-único. F3: só conecta num endpoint que já esteja de pé. F5:
 * mantém o daemon de pé sozinho — start-on-demand, self-heal, disarm-K.
 * QUALQUER falha (conexão, timeout, protocolo, spawn) devolve {ok:false} —
 * nunca lança; os três hooks sempre caem no caminho local (efêmero) sem
 * mudança de contrato de chamada (`tryDaemon(method, params, opts?)`).
 */

const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { encodeFrame, parseStream } = require('./ipc-frame.cjs');
const { defaultEndpoint } = require('../adapters/daemon-server.cjs');

let reqId = 0;

/**
 * TOKEN_GUARD=off|warn são os overrides de env lidos por `loadUncached()`
 * (lib/config.cjs:169-181/210) — do env do PROCESSO CHAMADOR. O daemon roda
 * num processo residente separado, com seu próprio env congelado no boot: se
 * o RPC seguisse pro daemon mesmo assim, `CFG.load()` leria o TOKEN_GUARD do
 * daemon (provavelmente ausente), não o do chamador, e o override pararia de
 * valer pros hooks que passam pelo daemon — silenciosamente: "off" viraria
 * bloqueio normal, "warn" viraria "deny" em vez de "ask". Corta ANTES de
 * conectar: com a var setada pra qualquer valor reconhecido, nunca tenta o
 * daemon — cai direto no caminho local, que já lê o env correto.
 */
function hasTokenGuardEnvOverride() {
  const env = String(process.env.TOKEN_GUARD || '').toLowerCase();
  return env === 'off' || env === '0' || env === 'false' || env === 'warn';
}

/**
 * UMA tentativa de request-response RPC contra um endpoint que já esteja de
 * pé. Nunca lança — qualquer falha de conexão/timeout/protocolo devolve
 * {ok:false}. É a peça injetável (`connectFn`) que F5 reusa tanto pra
 * tentativa inicial quanto pro polling de boot (`hello`) e pro reenvio
 * depois de subir/religar o daemon.
 *
 * @param {string} method
 * @param {object} params
 * @param {{timeoutMs?: number, endpoint?: string}} [opts]
 * @returns {Promise<{ok:true, result:object}|{ok:false}>}
 */
function connectOnce(method, params, opts) {
  const { timeoutMs = 200, endpoint } = opts || {};
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };

    let sock;
    try {
      sock = net.connect(endpoint || defaultEndpoint());
    } catch {
      finish({ ok: false });
      return;
    }

    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* noop */ }
      finish({ ok: false });
    }, timeoutMs);
    timer.unref?.();

    sock.on('error', () => {
      clearTimeout(timer);
      finish({ ok: false });
    });

    sock.on('connect', () => {
      const id = ++reqId;
      const frames = parseStream(sock);
      frames.on('data', (msg) => {
        if (!msg || msg.id !== id) return;
        clearTimeout(timer);
        try { sock.end(); } catch { /* noop */ }
        if (msg.error || !msg.result) finish({ ok: false });
        else finish({ ok: true, result: msg.result });
      });
      frames.on('error', () => {
        clearTimeout(timer);
        try { sock.destroy(); } catch { /* noop */ }
        finish({ ok: false });
      });
      try {
        sock.write(encodeFrame({ id, method, params }));
      } catch {
        clearTimeout(timer);
        finish({ ok: false });
      }
    });
  });
}

const DEFAULT_DAEMON_SERVER_PATH = path.join(__dirname, '..', 'adapters', 'daemon-server.cjs');

/**
 * Sobe o daemon real. `process.execPath` já É node aqui — os três hooks
 * rodam como `node adapters/*.cjs`, sem CLI wrapper pelo meio (ao contrário
 * do caso descrito na skill `plugin-daemon-unico`, onde `process.execPath`
 * podia ser um wrapper tipo `copilot.exe` que ignora `ELECTRON_RUN_AS_NODE`)
 * — então spawn direto com `shell:false` é correto, sem resolução de
 * PATHEXT/.cmd. `detached`+`unref` pra não prender o processo curto do hook
 * esperando o filho morrer; `env` omitido de propósito — herda o do
 * processo pai (inclui `TOKEN_GUARD_SID` se já estiver setado no ambiente).
 *
 * `endpoint` vai como argv[2] pro filho (`daemon-server.cjs`'s
 * `if (require.main === module) start(process.argv[2] || undefined)`) —
 * sem isto, um `tryDaemon(method, params, {endpoint: 'custom'})` faria o
 * bring-up subir um daemon escutando em `defaultEndpoint()` enquanto
 * `waitForEndpoint`/`connectFn` fariam polling contra o endpoint custom:
 * nunca convergem, exaurem `maxSpawnAttempts` e desarmam o cliente em
 * silêncio (achado real da rodada 1 de revisão independente F5). Hoje os
 * três hooks de produção nunca passam `opts.endpoint` (sempre usam o
 * default), mas a API pública de `tryDaemon` já aceita o parâmetro — o
 * bring-up real tinha que honrá-lo.
 */
function realSpawn(daemonServerPath, endpoint) {
  const args = endpoint ? [daemonServerPath, endpoint] : [daemonServerPath];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => { /* best-effort: waitForEndpoint detecta a falha real */ });
  child.unref();
  return child;
}

/**
 * NÃO usa `.unref()` aqui (diferente do timer de timeout em `connectOnce`,
 * que sempre tem um socket real pareado segurando o event loop até
 * resolver). Este timer É o único handle vivo durante o intervalo entre
 * polls de `waitForEndpoint` — depois que `spawnFn` desanexa o filho
 * (`detached`+`unref`) e a tentativa de conexão anterior já settou, nada
 * mais prende o loop. Com `unref()`, o processo do hook (curto, sem outro
 * trabalho pendente) encerra sozinho no meio do sleep, abandonando a
 * cadeia de retry antes de tentar de novo — bug real encontrado ao rodar
 * `selftest.cjs` (spawnSync devolvia stdout vazio: o processo morria antes
 * de escrever a decisão).
 */
function realSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * F5 — cliente com start-on-demand + self-heal + disarm-K. Seams 100%
 * injetáveis (`spawnFn`, `nowFn`, `connectFn`, `sleepFn`) pra teste
 * determinístico: zero subprocess real, zero corrida de timing real.
 *
 * DECISÃO DE DESIGN (start-on-demand e self-heal são o MESMO mecanismo):
 * os três hooks fazem UM request-response por chamada (não uma sessão longa
 * com múltiplas trocas) — "daemon nunca subiu" (ECONNREFUSED) e "daemon
 * caiu no meio" (EPIPE/EOF a meio de um request) chegam ao chamador da
 * MESMA forma: `connectOnce` já colapsa os dois casos em {ok:false} via
 * `sock.on('error')`/`frames.on('error')` (herdado do F3). Ter dois
 * caminhos de retry separados pra distinguir a causa adicionaria estado sem
 * mudar o comportamento observável — a resposta certa nos dois casos é
 * idêntica: "tenta subir/religar o daemon (bounded), reenvia este request".
 *
 * DECISÃO DE DESIGN (sem lock de spawn no lado cliente): o plano pede
 * "guard spawn with lifecycle lock (F4) so parallel clients don't
 * stampede-respawn". Em vez de um lock client-side adicional, reusa a MESMA
 * defesa em duas camadas que F4 já construiu do lado do daemon: se N
 * clientes concorrentes falharem em conectar ao mesmo tempo e cada um
 * spawnar seu próprio processo candidato a daemon, `DL.acquireLock` +
 * `server.listen()`/EADDRINUSE (adapters/daemon-server.cjs:start) já fazem
 * N-1 desses processos desistirem sozinhos via `giveUp()` — o pior caso é
 * N-1 spawns redundantes (custo de scan de AV), nunca dois daemons vivos.
 * Igual à filosofia registrada no fechamento de F4: a garantia real já
 * existe numa camada mais funda; duplicar coordenação aqui não mudaria o
 * invariante, só a probabilidade do caso raro.
 *
 * K (disarm) conta tentativas de bring-up dentro de UMA chamada de
 * `tryDaemon` (não entre chamadas): os três hooks chamam `tryDaemon` uma
 * única vez por processo (processo morre logo depois), então um contador
 * entre-chamadas nunca dispararia na prática — o retry bounded tem que
 * estar DENTRO da própria chamada pra ter efeito real.
 *
 * @param {object} [depsOverride]
 * @returns {{tryDaemon: Function}}
 */
function createClient(depsOverride) {
  const deps = {
    spawnFn: realSpawn,
    nowFn: Date.now,
    connectFn: connectOnce,
    sleepFn: realSleep,
    daemonServerPath: DEFAULT_DAEMON_SERVER_PATH,
    bootTimeoutMs: 1500,
    pollIntervalMs: 25,
    maxSpawnAttempts: 3,
    ...depsOverride,
  };

  let disarmed = false;
  let consecutiveSpawnFailures = 0;

  async function waitForEndpoint(endpoint) {
    const deadline = deps.nowFn() + deps.bootTimeoutMs;
    for (;;) {
      const hello = await deps.connectFn('hello', {}, { endpoint, timeoutMs: 200 });
      if (hello.ok) return true;
      if (deps.nowFn() >= deadline) return false;
      await deps.sleepFn(deps.pollIntervalMs);
    }
  }

  async function bringUpAndRetry(method, params, endpoint, callOpts) {
    try { deps.spawnFn(deps.daemonServerPath, endpoint); } catch { /* best-effort */ }
    const up = await waitForEndpoint(endpoint);
    if (!up) return { ok: false };
    return deps.connectFn(method, params, { ...callOpts, endpoint });
  }

  async function tryDaemon(method, params, opts) {
    if (hasTokenGuardEnvOverride() || disarmed) return { ok: false };

    const callOpts = opts || {};
    const endpoint = callOpts.endpoint || defaultEndpoint();

    const first = await deps.connectFn(method, params, { ...callOpts, endpoint });
    if (first.ok) return first;

    while (consecutiveSpawnFailures < deps.maxSpawnAttempts) {
      const res = await bringUpAndRetry(method, params, endpoint, callOpts);
      if (res.ok) {
        consecutiveSpawnFailures = 0;
        return res;
      }
      consecutiveSpawnFailures++;
    }

    disarmed = true;
    process.stderr.write(
      `token-guard: daemon indisponível após ${deps.maxSpawnAttempts} tentativa(s) de ` +
      'start-on-demand — desarmado pro resto deste processo, caindo no caminho efêmero local.\n'
    );
    return { ok: false };
  }

  return { tryDaemon };
}

const defaultClient = createClient();

/**
 * `realSpawn`/`DEFAULT_DAEMON_SERVER_PATH` exportados só pra teste de
 * integração real (subprocess de verdade, sem seam injetado) do mecanismo
 * de propagação de `endpoint` — ver test/daemon-faulttolerance.test.cjs,
 * caso "endpoint arbitrário via subprocess real". Nenhum código de produção
 * fora deste módulo deve chamá-los diretamente.
 */
module.exports = {
  tryDaemon: defaultClient.tryDaemon,
  createClient,
  realSpawn,
  DEFAULT_DAEMON_SERVER_PATH,
};
