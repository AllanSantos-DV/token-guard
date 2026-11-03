'use strict';
/**
 * lib/daemon-lifecycle.cjs — lógica pura de singleton-lock e handshake de
 * versão do daemon (F4). Todo primitivo que toca o SO (ler/escrever/checar
 * arquivo, sondar se um pid está vivo) é injetável, então este módulo é
 * testável inteiramente com filesystem mockado e pid falso — sem pipe/socket
 * real. `adapters/daemon-server.cjs` liga as implementações reais de fs/process.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_DEPS = {
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p, s) => fs.writeFileSync(p, s),
  exists: (p) => fs.existsSync(p),
  mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  isAlive: (pid) => {
    try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
  },
};

function readLockRecord(lockFile, depsOverride) {
  const deps = { ...REAL_DEPS, ...depsOverride };
  if (!deps.exists(lockFile)) return null;
  let raw;
  try { raw = deps.readFile(lockFile); } catch { return null; }
  let rec;
  try { rec = JSON.parse(raw); } catch { return null; }
  if (
    !rec ||
    typeof rec.pid !== 'number' || !Number.isInteger(rec.pid) || rec.pid <= 0 ||
    typeof rec.protocolVersion !== 'number' ||
    typeof rec.packageVersion !== 'string'
  ) {
    return null;
  }
  return rec;
}

function writeLockRecord(lockFile, record, depsOverride) {
  const deps = { ...REAL_DEPS, ...depsOverride };
  try { deps.mkdirp(path.dirname(lockFile)); } catch { /* já existe / best-effort */ }
  // Best-effort: falha de I/O aqui (disco cheio, AV segurando o arquivo) não
  // pode derrubar o daemon — o lock-record é só a primeira linha de defesa,
  // a autoridade real do singleton é o EADDRINUSE do listen() em daemon-server.cjs.
  try { deps.writeFile(lockFile, JSON.stringify(record)); } catch { /* best-effort */ }
}

/**
 * Decide se este processo pode assumir o lock-record (pid+versão) do daemon.
 * Lock ausente ou corrompido ⇒ livre pra assumir. Lock presente com pid VIVO
 * (e diferente do nosso) ⇒ outro daemon já está de pé, recusa. Lock presente
 * com pid morto ⇒ resíduo de um daemon anterior que caiu sem limpar — assume
 * e sinaliza `reclaimedStale` pro chamador decidir se precisa remover um
 * socket/pipe órfão antes de dar `listen()`.
 *
 * @param {{lockFile:string, pid:number, protocolVersion:number, packageVersion:string}} params
 * @param {object} [depsOverride]
 * @returns {{acquired:true, reclaimedStale:boolean} | {acquired:false, reason:'alive', existing:object}}
 */
function acquireLock(params, depsOverride) {
  const deps = { ...REAL_DEPS, ...depsOverride };
  const { lockFile, pid, protocolVersion, packageVersion } = params;
  const existing = readLockRecord(lockFile, deps);
  if (existing && existing.pid !== pid && deps.isAlive(existing.pid)) {
    return { acquired: false, reason: 'alive', existing };
  }
  writeLockRecord(lockFile, { pid, protocolVersion, packageVersion }, deps);
  return { acquired: true, reclaimedStale: !!existing };
}

/**
 * Compara a resposta do RPC `hello` do daemon contra a versão esperada pelo
 * cliente. Puro — não conecta em nada, só julga os dois objetos.
 * @param {{protocolVersion?:number, packageVersion?:string}} hello
 * @param {{protocolVersion:number, packageVersion:string}} expected
 * @returns {{ok:true} | {ok:false, reason:'no-reply'|'protocol-mismatch'|'version-mismatch'}}
 */
function checkHandshake(hello, expected) {
  if (!hello || typeof hello !== 'object') return { ok: false, reason: 'no-reply' };
  if (hello.protocolVersion !== expected.protocolVersion) return { ok: false, reason: 'protocol-mismatch' };
  if (hello.packageVersion !== expected.packageVersion) return { ok: false, reason: 'version-mismatch' };
  return { ok: true };
}

/** Compara versões x.y.z numericamente (sufixo de pré-release ignorado). */
function compareVersions(a, b) {
  const part = (v) => String(v).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pa = part(a);
  const pb = part(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * O daemon que respondeu é de versão MAIS NOVA que a do cliente? Um cliente velho (cópia esquecida em
 * .github/token-guard, runtime de outro alvo) não pode aposentá-lo: o cliente novo o reaposentaria e os dois
 * brigariam a cada chamada. Só a versão do pacote conta: o protocolVersion é único (1) e a igualdade dele
 * segue no handshake. Quem rebaixa de propósito é o init (swapDaemon), que não passa por aqui; o setup e o
 * SessionStart recusam reiniciar daemon mais novo.
 */
function daemonIsNewer(hello, expected) {
  return !!hello && typeof hello.packageVersion === 'string' && compareVersions(hello.packageVersion, expected.packageVersion) > 0;
}

const SINGLETON_CONFLICT_CODES = new Set(['EADDRINUSE']);

/** Erro de `server.listen()` que significa "outro daemon já está de pé neste endpoint". */
function isSingletonConflict(err) {
  return !!err && SINGLETON_CONFLICT_CODES.has(err.code);
}

/* ------------------------------------------------------------------ */
/* Registro de início e saída: uma queda deixa a causa gravada.         */
/* ------------------------------------------------------------------ */

const LIFECYCLE_MAX_BYTES = 128 * 1024;

/** Arquivo no diretório de dados do usuário (junto de daemon-http.json). */
function lifecycleLogPath() {
  return path.join(os.homedir(), '.token-guard', 'daemon.log');
}

/**
 * Acrescenta UMA linha JSON (`at`, `event`, `pid` + campos). Melhor esforço: o registro nunca derruba o
 * daemon. Passando o teto, mantém só a metade final, cortada em fim de linha.
 */
function logLifecycle(event, fields, file = lifecycleLogPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > LIFECYCLE_MAX_BYTES) {
        const raw = fs.readFileSync(file, 'utf8');
        const tail = raw.slice(raw.length >> 1);
        fs.writeFileSync(file, tail.slice(tail.indexOf('\n') + 1));
      }
    } catch { /* arquivo ainda não existe */ }
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ...fields }) + '\n');
  } catch { /* best-effort */ }
}

/** Última linha legível do registro (null se não há). */
function lastLifecycleRecord(file = lifecycleLogPath()) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines[i]); } catch { /* linha cortada: tenta a anterior */ }
    }
  } catch { /* sem arquivo */ }
  return null;
}

let exitReason = null;
let exitHooked = false;
let started = false;
/** O primeiro motivo vence: o gatilho real (sinal, ociosidade, pedido) vem antes do process.exit que o segue. */
function noteExitReason(reason) { if (!exitReason) exitReason = reason; }

/**
 * Um `start` sem `exit` posterior do mesmo pid, no mesmo endpoint, é um daemon que não saiu limpo (morte
 * forçada ou queda). Não pergunta se o pid está vivo: pid reusado por outro processo esconderia a queda.
 * Outro endpoint (outro SID, teste) tem vida própria e não conta.
 */
function unfinishedStart(file, endpoint, selfPid) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return null; }
  const open = new Map();
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.event === 'start') open.set(rec.pid, rec);
    else if (rec.event === 'exit' || rec.event === 'previous-unclean') open.delete(rec.event === 'exit' ? rec.pid : rec.prevPid);
  }
  let found = null;
  for (const rec of open.values()) {
    if (rec.pid !== selfPid && rec.endpoint === endpoint) found = rec;
  }
  return found;
}

/**
 * Registra os ganchos de saída e de sinal. Chamado no início do start() do daemon, para que uma falha
 * ANTES de escutar também deixe a linha de `exit` com o motivo. Quem perde o singleton (sai 0 sem
 * motivo anotado e sem ter iniciado) não grava nada: o vigia o faz a cada poucos minutos.
 */
function hookProcess(file = lifecycleLogPath()) {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', (code) => {
    if (!started && !exitReason) return;
    logLifecycle('exit', { code, reason: exitReason || 'sem motivo anotado' }, file);
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(sig, () => { noteExitReason(`sinal ${sig}`); process.exit(0); });
    } catch { /* sinal inexistente nesta plataforma */ }
  }
  process.on('uncaughtException', (err) => {
    noteExitReason(`uncaughtException: ${err && err.message}`);
    try { process.stderr.write(`token-guard daemon: ${err && err.stack || err}\n`); } catch { /* stderr fechado */ }
    process.exit(1);
  });
}

/**
 * Chamado quando o daemon passou a escutar. Grava `start`; se havia um `start` do mesmo endpoint sem
 * `exit`, grava antes `previous-unclean`. Garante os ganchos de saída (normalmente já postos por hookProcess).
 */
function recordStart(fields, file = lifecycleLogPath()) {
  const prev = unfinishedStart(file, fields.endpoint, process.pid);
  if (prev) {
    logLifecycle('previous-unclean', { prevPid: prev.pid, prevStartedAt: prev.at, prevVersion: prev.version, endpoint: fields.endpoint }, file);
  }
  started = true;
  logLifecycle('start', fields, file);
  hookProcess(file);
}

module.exports = {
  readLockRecord, writeLockRecord, acquireLock, checkHandshake, isSingletonConflict,
  lifecycleLogPath, logLifecycle, lastLifecycleRecord, noteExitReason, recordStart, hookProcess, compareVersions, daemonIsNewer,
  REAL_DEPS,
};
