'use strict';
/**
 * lib/daemon-lifecycle.cjs — lógica pura de singleton-lock e handshake de
 * versão do daemon (F4). Todo primitivo que toca o SO (ler/escrever/checar
 * arquivo, sondar se um pid está vivo) é injetável, então este módulo é
 * testável inteiramente com filesystem mockado e pid falso — sem pipe/socket
 * real. `adapters/daemon-server.cjs` liga as implementações reais de fs/process.
 */

const fs = require('fs');
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

const SINGLETON_CONFLICT_CODES = new Set(['EADDRINUSE']);

/** Erro de `server.listen()` que significa "outro daemon já está de pé neste endpoint". */
function isSingletonConflict(err) {
  return !!err && SINGLETON_CONFLICT_CODES.has(err.code);
}

module.exports = {
  readLockRecord, writeLockRecord, acquireLock, checkHandshake, isSingletonConflict,
  REAL_DEPS,
};
