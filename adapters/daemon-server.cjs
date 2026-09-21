#!/usr/bin/env node
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { decide } = require('../lib/decide.cjs');
const { parseStream, writeFrame } = require('../lib/ipc-frame.cjs');
const CFG = require('../lib/config.cjs');
const CT = require('../lib/contract.cjs');
const { noteResult, isRead } = require('../lib/dupread.cjs');
const { postProcess } = require('../lib/postresult.cjs');
const DL = require('../lib/daemon-lifecycle.cjs');

const PROTOCOL_VERSION = 1;
const PACKAGE_VERSION = (() => {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
})();

/** Daemon sem requisição por este tempo se autoencerra (0 desativa). */
const IDLE_TIMEOUT_MS = Number(process.env.TOKEN_GUARD_DAEMON_IDLE_MS) || 10 * 60 * 1000;

/**
 * Fallback do SID no Windows: estável por usuário, equivalente ao
 * `process.uid` do ramo POSIX abaixo.
 * INVARIANTE: precisa render o MESMO valor que `stableWindowsSid()` de
 * install.cjs (que grava `TOKEN_GUARD_SID` via setx) — sanitização e teto de
 * 64 caracteres inclusive. Se as duas divergirem, o hook e o daemon do logon
 * calculam pipes diferentes e o daemon nunca fica quente. install.cjs é
 * deliberadamente zero-require do projeto, por isso a regra é duplicada.
 */
function defaultWindowsSid() {
  try {
    const username = os.userInfo().username;
    if (username) return username.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  } catch { /* ambiente sem userInfo (raro) */ }
  return 'default';
}

function defaultEndpoint() {
  if (process.platform === 'win32') {
    const sid = process.env.TOKEN_GUARD_SID || defaultWindowsSid();
    return `\\\\.\\pipe\\token-guard-${sid}`;
  }
  const dir = process.env.XDG_RUNTIME_DIR || '/tmp';
  const sid = process.env.TOKEN_GUARD_SID || process.uid;
  return path.join(dir, `token-guard-${sid}.sock`);
}

/**
 * Caminho do lock-record (pid+versão, F4). POSIX: o socket já tem um path de
 * fs real, então o lock vive ao lado (`<socket>.lock`). Windows: named pipe
 * não tem backing de filesystem, então o lock vai num diretório próprio sob
 * o temp dir, nomeado a partir do próprio endpoint (mesmo SID/pid usado nele).
 */
function defaultLockPath(endpointOverride) {
  const endpoint = endpointOverride || defaultEndpoint();
  if (process.platform === 'win32') {
    const name = endpoint.replace(/^\\\\\.\\pipe\\/, '');
    return path.join(os.tmpdir(), 'token-guard-locks', `${name}.lock`);
  }
  return `${endpoint}.lock`;
}

function ruleSetHash(root) {
  let h = '';
  for (const rel of ['lib/config.cjs', 'lib/rules.cjs']) {
    try { h += fs.readFileSync(path.join(__dirname, '..', rel)); } catch { /* noop */ }
  }
  // A config global (`~/.claude|.copilot|.cursor|.token-guard/`) e a config de
  // um ancestral do workspace decidem tanto quanto a do root — se não entrarem
  // na chave, o daemon serve para sempre o veredito que cacheou antes da edição.
  const stateFiles = new Set([
    path.join(root, CFG.CONFIG_NAME),
    path.join(root, '.token-guard', 'config.json'),
    path.join(root, '.token-guard', 'repo-stats.json'),
    ...CFG.configFilesInEffect(root),
  ]);
  for (const p of stateFiles) {
    try { h += fs.readFileSync(p); } catch { /* noop */ }
  }
  return crypto.createHash('sha256').update(h).digest('hex').slice(0, 16);
}

function dispatch(params) {
  const payload = params && params.payload ? params.payload : {};
  try {
    const verdict = decide(payload);
    return { ok: true, verdict };
  } catch {
    return { ok: true, verdict: null };
  }
}

/** Replica prompt-hook.cjs:42-52 — leitura+decisão do contrato, sem persistir estado. */
function dispatchContract(params) {
  const root = params && params.root;
  const sessionId = params && params.sessionId;
  try {
    const cfg = CFG.load(root);
    if (cfg.mode === 'off') return { ok: true, triggers: [], text: '' };
    const contract = CT.load(root);
    if (!contract.order.length) return { ok: true, triggers: [], text: '' };
    const state = CT.readState(root, sessionId);
    const touched = CT.readTouched(root, sessionId);
    const decision = CT.decide({ contract, touched, injected: state.injected });
    return { ok: true, triggers: decision.triggers, text: decision.text };
  } catch {
    return { ok: true, triggers: [], text: '' };
  }
}

/** Replica post-hook.cjs:26-53 — bigResult + dupRead, cfg carregado quente no daemon. */
function dispatchPostprocess(params) {
  const { name, input, result, root, sessionId } = params || {};
  try {
    const cfg = CFG.load(root);
    const trimmed = postProcess({ name, input, result, root, cfg });
    if (trimmed) return { ok: true, trimmed };
    if (sessionId && isRead(name)) {
      try { noteResult({ name, input, result, root, sessionId, cfg }); } catch { /* evidência */ }
    }
    return { ok: true, trimmed: null };
  } catch {
    return { ok: true, trimmed: null };
  }
}

/** Anexado a toda resposta (sucesso ou erro) — permite ao cliente detectar um daemon desatualizado sem pagar um roundtrip 'hello' extra. */
const HANDSHAKE = { protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION };

function handleMessage(msg, ctx) {
  const reply = routeMessage(msg, ctx);
  if (reply) reply.handshake = HANDSHAKE;
  return reply;
}

function routeMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || !msg.id) return null;
  const method = msg.method;

  try {
  if (method === 'hello') {
    return { id: msg.id, result: { protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION } };
  }

  if (method === 'ping') {
    return { id: msg.id, result: { pong: true } };
  }

  // Introspecção do próprio processo: o RSS medido de fora (`tasklist`/`ps`)
  // custa um spawn, e spawn no Windows bloqueia o event loop de quem mede —
  // o que contamina justamente a latência que o benchmark quer medir.
  if (method === 'stats') {
    return {
      id: msg.id,
      result: {
        pid: process.pid,
        rssBytes: process.memoryUsage().rss,
        uptimeMs: Math.round(process.uptime() * 1000),
        cacheEntries: ctx.cache.size,
        hits: ctx.hits,
        misses: ctx.misses,
      },
    };
  }

  if (method === 'shutdown') {
    if (typeof ctx.requestShutdown === 'function') setImmediate(ctx.requestShutdown);
    return { id: msg.id, result: { ok: true } };
  }

  if (method === 'check') {
    const params = msg.params || {};
    const root = typeof params.root === 'string' && params.root ? params.root : process.cwd();
    const hash = ruleSetHash(root);
    const key = `${root}\u0000${hash}\u0000${JSON.stringify(params.payload || {})}`;
    const cached = ctx.cache.get(key);
    if (cached !== undefined) {
      ctx.hits++;
      return { id: msg.id, result: { ok: true, verdict: cached, cached: true } };
    }
    const out = dispatch(params);
    if (out.ok) {
      ctx.cache.set(key, out.verdict);
      ctx.misses++;
    }
    return { id: msg.id, result: out };
  }

  if (method === 'contract') {
    return { id: msg.id, result: dispatchContract(msg.params || {}) };
  }

  if (method === 'postprocess') {
    return { id: msg.id, result: dispatchPostprocess(msg.params || {}) };
  }

  return { id: msg.id, error: { code: -32601, message: `Método não suportado: ${method}` } };
  } catch (err) {
    // Fail-loud pro cliente (erro visível na resposta RPC), fail-open pro processo:
    // uma requisição malformada nunca pode derrubar o daemon compartilhado.
    return { id: msg.id, error: { code: -32000, message: `Erro interno: ${err && err.message}` } };
  }
}

function createServer(ctxOverride) {
  const ctx = ctxOverride || {
    cache: new Map(),
    hits: 0,
    misses: 0,
    lastActivity: Date.now(),
  };
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    const frames = parseStream(socket);
    frames.on('data', (msg) => {
      ctx.lastActivity = Date.now();
      const reply = handleMessage(msg, ctx);
      if (reply) writeFrame(socket, reply);
    });
    frames.on('error', () => socket.destroy());
    frames.on('end', () => socket.end());
  });
  server.ctx = ctx;
  return server;
}

/** Sem `.unref()` de propósito: este timer é o que mantém o daemon vivo até decidir morrer. */
function scheduleIdleShutdown(server, lockFile, idleTimeoutMs, depsOverride) {
  const deps = {
    nowFn: Date.now,
    setIntervalFn: setInterval,
    clearIntervalFn: clearInterval,
    unlinkFn: (p) => { try { fs.unlinkSync(p); } catch { /* best-effort */ } },
    exitFn: (code) => process.exit(code),
    ...depsOverride,
  };
  if (!(idleTimeoutMs > 0)) return null;
  const checkEveryMs = Math.min(idleTimeoutMs, 60000);
  const timer = deps.setIntervalFn(() => {
    if (deps.nowFn() - server.ctx.lastActivity < idleTimeoutMs) return;
    deps.clearIntervalFn(timer);
    process.stderr.write(`token-guard daemon ocioso por ${idleTimeoutMs}ms — encerrando.\n`);
    deps.unlinkFn(lockFile);
    server.close(() => deps.exitFn(0));
  }, checkEveryMs);
  return timer;
}

/**
 * Reivindica o mutex de reclaim de socket órfão. Caminho livre: `wx` puro
 * (O_EXCL do SO) — atômico, nunca disputado incorretamente.
 *
 * Caminho de dono morto — histórico (rodadas 4-7 de revisão independente
 * F4): unlink+recreate simples (r4, TOCTOU sem revalidação) → releitura de
 * confirmação antes do unlink (r5, janela residual estreita mas real) →
 * rename-to-destino-fixo+releitura (r6, PROVADO incorreto por prova lógica:
 * rename-para-destino-fixo nunca falha por já existir, não é CAS) → arbiter
 * em duas camadas cujo self-heal reintroduzia o mesmo unlink+recreate um
 * nível abaixo (r7, reproduzido empiricamente 15/15 pelo revisor) →
 * rename-from-source (fix da r7) — que um stress test empírico desta sessão
 * (8 processos reais concorrentes × 15 trials, script descartável, não
 * versionado) provou AINDA correr: um processo atrasado pode renomear o
 * lock que outro processo JÁ recriou como vivo, porque a decisão "dono
 * morto" (leitura) e a ação de roubo (rename) não são atômicas juntas — o
 * primitivo de rename em si é exclusivo, mas não valida que o conteúdo
 * ainda é o mesmo que justificou a decisão de roubar. Uma correção
 * genuinamente livre desta corrida exigiria um protocolo de
 * settling/backoff (ex.: bakery algorithm) — desproporcional pro que este
 * mutex de fato protege.
 *
 * DECISÃO DE DESIGN (limite reconhecido, não bug pendente): este mutex é
 * uma OTIMIZAÇÃO pra evitar que dois processos façam unlink+listen
 * redundante no MESMO socket órfão ao mesmo tempo. A garantia real de
 * singleton não depende dele — vem do `server.listen()` mais abaixo, cujo
 * `EADDRINUSE` é arbitrado pelo próprio SO (duas camadas de defesa:
 * lock-record como pré-checagem rápida, bind real como autoridade final).
 * Se este mutex correr, o pior caso é dois processos tentando unlink+listen
 * no mesmo socket quase ao mesmo tempo — autocorrigido, porque o bind
 * exclusivo do SO ainda garante que só um processo fica de pé escutando.
 * Best-effort aqui é suficiente; perseguir exclusão perfeita neste nível
 * não muda a invariante que realmente importa (nunca dois daemons vivos
 * escutando o mesmo endpoint).
 *
 * Nuance validada na rodada 8 de revisão independente F4 (reprodução
 * empírica fresca, 16/16 trials em POSIX real): se o processo B "rouba" e
 * apaga o arquivo de socket bem na janela transitória em que o processo A
 * está ELE MESMO no meio do próprio unlink→listen (não um daemon A já
 * estável — esse caso o `probe` abaixo detecta de forma confiável), o
 * arquivo pode sumir debaixo de A. A não perde o fd que já tem nem aceita
 * conexão de mais ninguém no mesmo bind, mas fica inalcançável via o path
 * até sua própria tentativa de retry falhar com EADDRINUSE de novo e
 * desistir via `giveUp()` — autolimitado, nunca viola "dois processos
 * aceitando conexão no mesmo path simultaneamente".
 */
function claimOrphanMutex(mutexPath) {
  const token = `${process.pid}:${crypto.randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(mutexPath, token, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
  }
  let ownerPid;
  try { ownerPid = parseInt(fs.readFileSync(mutexPath, 'utf8'), 10); } catch { return false; }
  if (!Number.isInteger(ownerPid) || ownerPid <= 0 || DL.REAL_DEPS.isAlive(ownerPid)) return false;
  try {
    fs.unlinkSync(mutexPath);
  } catch {
    return false;
  }
  try {
    fs.writeFileSync(mutexPath, token, { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function start(endpointOverride) {
  const endpoint = endpointOverride || defaultEndpoint();
  const lockFile = defaultLockPath(endpoint);

  // F4 (D4/D5): antes de tentar o listen, decide via lock-record se já existe
  // outro daemon vivo neste endpoint. Isto é só a primeira linha de defesa —
  // a autoridade real é o próprio `listen()` abaixo (EADDRINUSE), que cobre a
  // janela de corrida entre este check e o listen.
  const lockResult = DL.acquireLock({
    lockFile, pid: process.pid, protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION,
  });
  if (!lockResult.acquired) {
    process.stderr.write(`token-guard daemon já em execução (pid ${lockResult.existing.pid}) — encerrando (singleton)\n`);
    process.exit(0);
    return null;
  }
  // Lock reclamado de um daemon anterior que morreu sem limpar: no POSIX o
  // arquivo de socket pode ter sobrevivido ao processo morto e bloquear o
  // listen() com EADDRINUSE mesmo sem ninguém escutando — remove antes.
  if (lockResult.reclaimedStale && process.platform !== 'win32') {
    try { fs.unlinkSync(endpoint); } catch { /* pode já não existir */ }
  }

  const server = createServer();
  server.ctx.requestShutdown = () => {
    process.stderr.write('token-guard daemon: shutdown solicitado (versão desatualizada) — encerrando.\n');
    try { fs.unlinkSync(lockFile); } catch { /* best-effort */ }
    server.close(() => process.exit(0));
  };

  // Mutex de arquivo (create exclusivo `wx` — atômico no POSIX) pro trecho
  // crítico de reclaim de socket órfão abaixo. Sem isto, dois daemons
  // concorrentes reclamando o MESMO socket órfão simultaneamente podiam
  // ambos "vencer" (um deles apaga o socket que o outro acabou de vincular)
  // e ficar dois processos vivos ao mesmo tempo — achado da rodada 2 de
  // revisão independente F4, sobre o fix do achado CRITICAL da rodada 1.
  let orphanMutexPath = null;
  const releaseOrphanMutex = () => {
    if (!orphanMutexPath) return;
    try { fs.unlinkSync(orphanMutexPath); } catch { /* best-effort */ }
    orphanMutexPath = null;
  };

  const onListening = () => {
    releaseOrphanMutex();
    // D5: restringe o socket POSIX ao dono (equivalente Windows — DACL do
    // named pipe — não é exposto pela API pública do Node; verificação fica
    // no script manual scripts/verify-daemon-security.ps1, não fingida aqui).
    if (process.platform !== 'win32') {
      try { fs.chmodSync(endpoint, 0o700); } catch { /* best-effort */ }
    }
    process.stderr.write(`token-guard daemon pronto em ${endpoint} (${PACKAGE_VERSION})\n`);
    scheduleIdleShutdown(server, lockFile, IDLE_TIMEOUT_MS);
  };
  // Já retried o listen uma vez após remover um socket órfão? Cobre o caso em
  // que o lock-record está ausente/corrompido (então `acquireLock` não marcou
  // `reclaimedStale`) mas o arquivo de socket de um daemon anterior morto
  // sobreviveu no disco — sem isto, esse cenário derrubava o daemon novo pra
  // sempre com um falso "já em execução" (achado de revisão independente F4).
  let retriedOrphanUnlink = false;
  const giveUp = () => {
    releaseOrphanMutex();
    process.stderr.write(`token-guard daemon já em execução em ${endpoint} — encerrando (singleton)\n`);
    process.exit(0);
  };
  server.once('listening', onListening);
  server.on('error', (err) => {
    releaseOrphanMutex();
    if (DL.isSingletonConflict(err)) {
      if (!retriedOrphanUnlink && process.platform !== 'win32') {
        retriedOrphanUnlink = true;
        orphanMutexPath = `${endpoint}.reclaim`;
        if (!claimOrphanMutex(orphanMutexPath)) {
          // outro processo já está no meio de um reclaim deste MESMO
          // endpoint agora (e está vivo) — não corre junto (exatamente a
          // race encontrada na revisão F4); desiste nesta tentativa,
          // fail-open pro caminho ephemeral do cliente (lib/daemon-client.cjs).
          orphanMutexPath = null;
          giveUp();
          return;
        }
        // EADDRINUSE aqui pode ser um socket de verdade (daemon vivo cujo
        // lock-record sumiu por fora — ex.: apagado manualmente) OU um
        // arquivo de socket órfão de um processo morto. Sonda com uma
        // conexão real antes de decidir: conectou = tem alguém do outro
        // lado, desiste; recusado/sem ninguém = órfão, remove e tenta de novo.
        const probe = net.connect(endpoint);
        probe.once('connect', () => { probe.destroy(); giveUp(); });
        probe.once('error', () => {
          try {
            fs.unlinkSync(endpoint);
            server.listen(endpoint);
          } catch {
            giveUp();
          }
        });
        return;
      }
      giveUp();
      return;
    }
    process.stderr.write(`token-guard daemon falhou: ${err.message}\n`);
    process.exit(1);
  });
  server.listen(endpoint);
  return server;
}

if (require.main === module) start(process.argv[2] || undefined);

module.exports = {
  createServer, dispatch, dispatchContract, dispatchPostprocess, handleMessage, start,
  scheduleIdleShutdown,
  defaultEndpoint, defaultWindowsSid, defaultLockPath, ruleSetHash, PROTOCOL_VERSION, PACKAGE_VERSION,
  IDLE_TIMEOUT_MS,
};
