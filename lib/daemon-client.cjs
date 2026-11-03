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
const crypto = require('crypto');
const { encodeFrame, parseStream, MAX_FRAME_BYTES } = require('./ipc-frame.cjs');
const { defaultEndpoint, PROTOCOL_VERSION, PACKAGE_VERSION } = require('../adapters/daemon-server.cjs');
const { checkHandshake, daemonIsNewer } = require('./daemon-lifecycle.cjs');

let reqId = 0;

/**
 * TOKEN_GUARD=off é o override de env lidos por `loadUncached()`
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
  return env === 'off' || env === '0' || env === 'false';
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
  const { timeoutMs = 200, endpoint, requestKey } = opts || {};
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

    // `sent`: o pedido saiu pelo socket, então o daemon pode já tê-lo processado mesmo sem a resposta chegar.
    let sent = false;
    const fail = () => finish(sent ? { ok: false, sent: true } : { ok: false });

    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* noop */ }
      fail();
    }, timeoutMs);
    timer.unref?.();

    sock.on('error', () => {
      clearTimeout(timer);
      fail();
    });
    // Par que fecha sem responder (daemon que sai no meio do pedido): sem isto a promessa ficava pendente
    // com o timer em unref, e um processo sem outro handle (o instalador) saía calado no meio da troca.
    sock.on('close', () => {
      clearTimeout(timer);
      fail();
    });

    sock.on('connect', () => {
      const id = ++reqId;
      const frames = parseStream(sock);
      frames.on('data', (msg) => {
        if (!msg || msg.id !== id) return;
        clearTimeout(timer);
        try { sock.end(); } catch { /* noop */ }
        if (msg.error || !msg.result) finish({ ok: false });
        else finish({ ok: true, result: msg.result, handshake: msg.handshake });
      });
      frames.on('error', () => {
        clearTimeout(timer);
        try { sock.destroy(); } catch { /* noop */ }
        fail();
      });
      try {
        sock.write(encodeFrame(requestKey ? { id, method, params, requestKey } : { id, method, params }));
        sent = true;
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

  /** Detecta staleness no caminho rápido (daemon já de pé, resposta de `check`/`contract`/`postprocess`) — `waitForEndpoint` só chama `hello` durante boot, nunca depois. */
  async function retireIfStale(handshake, endpoint) {
    if (!handshake) return;
    const expected = { protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION };
    if (checkHandshake(handshake, expected).ok || daemonIsNewer(handshake, expected)) return;
    await deps.connectFn('shutdown', {}, { endpoint, timeoutMs: 200 });
  }

  async function tryDaemon(method, params, opts) {
    if (hasTokenGuardEnvOverride() || disarmed) return { ok: false };

    // Mesma chave em todo reenvio desta chamada: o daemon reconhece o pedido repetido e não grava de novo
    // o que já registrou (evento de bloqueio), mesmo que a resposta tenha se perdido.
    const callOpts = { requestKey: crypto.randomBytes(8).toString('hex'), ...(opts || {}) };

    // Payload acima do teto de frame (resultado gigante no postprocess) nunca
    // passa pelo daemon: tentar só estoura o frame, dispara o bring-up 3x e
    // desarma o cliente. Vai direto pro caminho local, sem desarmar.
    // Mede com a requestKey dentro: é o frame que de fato sai.
    let frameBytes;
    try { frameBytes = Buffer.byteLength(encodeFrame({ id: 0, method, params, requestKey: callOpts.requestKey })); } catch { return { ok: false }; }
    if (frameBytes > MAX_FRAME_BYTES) return { ok: false };
    const endpoint = callOpts.endpoint || defaultEndpoint();

    const first = await deps.connectFn(method, params, { ...callOpts, endpoint });
    if (first.ok) {
      await retireIfStale(first.handshake, endpoint);
      return first;
    }
    // Método que muda estado (postprocess: dupRead, rajada) não é reenviado nem refeito localmente se o
    // daemon pode já tê-lo processado: o segundo registro faria a 1ª leitura da janela parecer duplicata.
    if (callOpts.atMostOnce && first.sent) return { ok: false, sent: true };

    // anySent: algum envio saiu pelo socket; o chamador não deve refazer localmente o que o daemon pode ter gravado.
    let anySent = !!first.sent;
    while (consecutiveSpawnFailures < deps.maxSpawnAttempts) {
      const res = await bringUpAndRetry(method, params, endpoint, callOpts);
      if (res.ok) {
        consecutiveSpawnFailures = 0;
        return res;
      }
      if (res.sent) anySent = true;
      // Mesma garantia do primeiro envio: se este saiu e a resposta se perdeu, não há novo reenvio.
      if (callOpts.atMostOnce && res.sent) return { ok: false, sent: true };
      consecutiveSpawnFailures++;
    }

    disarmed = true;
    process.stderr.write(
      `token-guard: daemon indisponível após ${deps.maxSpawnAttempts} tentativa(s) de ` +
      'start-on-demand — desarmado pro resto deste processo, caindo no caminho efêmero local.\n'
    );
    return anySent ? { ok: false, sent: true } : { ok: false };
  }

  return { tryDaemon };
}

const defaultClient = createClient();

/**
 * Pede ao daemon do endpoint que encerre (SessionStart reiniciando um daemon
 * sem HTTP, teardown de teste). Só o daemon de verdade responde — nada de
 * matar por pid de lock, que pode ter sido reusado por outro processo.
 * @returns {Promise<{ok:true, result:object}|{ok:false}>} ok:false = ninguém escutando
 */
function shutdownDaemon(endpoint) {
  return connectOnce('shutdown', {}, { endpoint: endpoint || defaultEndpoint(), timeoutMs: 1000 });
}

/**
 * Troca o daemon logo depois de os arquivos da instalação serem substituídos (init e auto-update): sem
 * isto o processo antigo seguia no ar com o código velho e o novo só nascia quando um hook ou a tarefa de
 * vigia dava por falta dele (7 minutos de conexão recusada medidos na 2.16.0).
 *
 * Ordem (a que o Windows exige): pede o encerramento limpo pelo pipe; espera o antigo SAIR (pipe mudo,
 * health calado, pid morto); só se ele não sair e o pid estiver provado por ele mesmo (health/stats), encerra
 * por esse pid; sobe o novo; devolve só quando o health responde com a versão esperada e um pid diferente
 * do antigo. Qualquer etapa que não fecha devolve `{ok:false, error}` com o motivo: nunca um "subiu" presumido.
 *
 * @param {object} [opts] seams de teste: connectFn, healthFn, readEndpointFn, spawnFn, isAliveFn, killFn,
 *   sleepFn, nowFn; endpoint, token, expectedVersion, daemonServerPath; stopTimeoutMs, killWaitMs, bootTimeoutMs, pollMs
 * @returns {Promise<{ok:true, pid:number, port:number|null, version:string, oldPid:number|null, oldVersion:string|null,
 *   killed:boolean, gapMs:number, totalMs:number}|{ok:false, error:string}>}
 */
async function swapDaemon(opts) {
  const DH = require('../adapters/daemon-http.cjs');
  const o = {
    expectedVersion: PACKAGE_VERSION,
    endpoint: defaultEndpoint(),
    daemonServerPath: DEFAULT_DAEMON_SERVER_PATH,
    token: DH.readToken(),
    stopTimeoutMs: 8000,
    killWaitMs: 3000,
    bootTimeoutMs: 20000,
    pollMs: 100,
    connectFn: connectOnce,
    healthFn: DH.probeHealth,
    readEndpointFn: DH.readEndpoint,
    spawnFn: realSpawn,
    isAliveFn: (pid) => require('./daemon-lifecycle.cjs').REAL_DEPS.isAlive(pid),
    killFn: (pid) => process.kill(pid),
    sleepFn: realSleep,
    nowFn: Date.now,
    ...opts,
  };
  const t0 = o.nowFn();
  const hello = () => o.connectFn('hello', {}, { endpoint: o.endpoint, timeoutMs: 300 });
  const health = async (ep) => (o.token && ep ? o.healthFn(ep.port, o.token) : null);

  // 1. Quem está no ar agora, e com que pid (o pid vem do próprio processo, nunca de arquivo).
  const oldEp = o.readEndpointFn();
  const oldHealth = await health(oldEp);
  const ipcUp = (await hello()).ok;
  let oldPid = oldHealth ? oldHealth.pid : null;
  if (ipcUp && !oldPid) {
    const st = await o.connectFn('stats', {}, { endpoint: o.endpoint, timeoutMs: 300 });
    if (st.ok && Number.isInteger(st.result.pid)) oldPid = st.result.pid;
  }
  const oldVersion = oldHealth ? oldHealth.version : null;

  // 2. Encerramento limpo e espera de saída.
  const left = async () => {
    if ((await hello()).ok) return false;
    const h = await health(oldEp);
    if (h && (oldPid === null || h.pid === oldPid)) return false;
    return !(oldPid !== null && o.isAliveFn(oldPid));
  };
  const waitLeft = async (ms) => {
    const deadline = o.nowFn() + ms;
    for (;;) {
      if (await left()) return true;
      if (o.nowFn() >= deadline) return false;
      await o.sleepFn(o.pollMs);
    }
  };
  const shutdownAt = o.nowFn();
  let killed = false;
  if (ipcUp || oldHealth) {
    if (ipcUp) await o.connectFn('shutdown', {}, { endpoint: o.endpoint, timeoutMs: 1000 });
    if (!(await waitLeft(o.stopTimeoutMs))) {
      if (oldPid === null) {
        return { ok: false, error: `o daemon antigo não saiu em ${o.stopTimeoutMs} ms e não deu para provar o pid dele` };
      }
      killed = true;
      try { o.killFn(oldPid); } catch (err) {
        if (err.code !== 'ESRCH') return { ok: false, error: `o daemon antigo (pid ${oldPid}, versão ${oldVersion || 'anterior à 2.16.1'}) não saiu e não pôde ser encerrado: ${err.message}` };
      }
      if (!(await waitLeft(o.killWaitMs))) {
        return { ok: false, error: `o daemon antigo (pid ${oldPid}, versão ${oldVersion || 'anterior à 2.16.1'}) segue na porta depois do encerramento forçado` };
      }
    }
  }

  // 3. Sobe o novo e espera a prova de que é ele.
  try { o.spawnFn(o.daemonServerPath, o.endpoint); } catch (err) {
    return { ok: false, error: `não consegui iniciar o daemon novo: ${err.message}` };
  }
  const deadline = o.nowFn() + o.bootTimeoutMs;
  for (;;) {
    const ep = o.readEndpointFn();
    if (ep && ep.error && ep.version === o.expectedVersion && ep.pid !== oldPid && !(oldEp && ep.pid === oldEp.pid)) {
      return { ok: false, error: `o daemon novo subiu sem HTTP: ${ep.error}` };
    }
    const hi = await hello();
    if (hi.ok && hi.result.packageVersion === o.expectedVersion) {
      const h = await health(ep);
      if (!o.token) {
        return { ok: true, pid: null, port: null, version: o.expectedVersion, oldPid, oldVersion, killed, gapMs: o.nowFn() - shutdownAt, totalMs: o.nowFn() - t0 };
      }
      if (h && h.version === o.expectedVersion && h.pid !== oldPid) {
        return { ok: true, pid: h.pid, port: ep.port, version: h.version, oldPid, oldVersion, killed, gapMs: o.nowFn() - shutdownAt, totalMs: o.nowFn() - t0 };
      }
    }
    if (o.nowFn() >= deadline) {
      return { ok: false, error: `o daemon novo não respondeu o health com a versão ${o.expectedVersion} em ${o.bootTimeoutMs} ms (veja ${require('./daemon-lifecycle.cjs').lifecycleLogPath()})` };
    }
    await o.sleepFn(o.pollMs);
  }
}

/**
 * `realSpawn`/`DEFAULT_DAEMON_SERVER_PATH` exportados só pra teste de
 * integração real (subprocess de verdade, sem seam injetado) do mecanismo
 * de propagação de `endpoint` — ver test/daemon-faulttolerance.test.cjs,
 * caso "endpoint arbitrário via subprocess real". Nenhum código de produção
 * fora deste módulo deve chamá-los diretamente.
 */
module.exports = {
  tryDaemon: defaultClient.tryDaemon,
  shutdownDaemon,
  swapDaemon,
  createClient,
  connectOnce,
  realSpawn,
  DEFAULT_DAEMON_SERVER_PATH,
};
