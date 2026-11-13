'use strict';
/**
 * statedir.cjs — onde o token-guard grava o estado de uma sessão.
 *
 * O estado só vive em `<projeto>/.token-guard` quando a sessão nasceu num projeto de verdade.
 * Pasta por onde o agente navega depois (Área de Trabalho, AppData, node_modules de outro
 * pacote) nunca ganha pasta nenhuma: o estado vai para a pasta de dados do usuário.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MARKERS = ['.git', 'package.json', 'token-guard.config.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle'];
const USER_FOLDERS = new Set(['desktop', 'documents', 'downloads', 'pictures', 'videos', 'music', 'onedrive']);
const SYSTEM_SEGMENTS = new Set(['appdata', 'node_modules', 'windows', 'program files', 'program files (x86)', 'programdata', 'system32']);
const SYSTEM_LEAVES = new Set(['bin', 'sbin', 'etc', 'usr', 'var']);
const PIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Pasta de dados por usuário, fora de qualquer projeto. */
function dataHome() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'token-guard');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'token-guard');
  return path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'token-guard');
}

/** SHA-1 hex de `text`. */
function sha(text) { return crypto.createHash('sha1').update(text).digest('hex'); }

/** true se `a` e `b` são a mesma pasta (sem diferenciar caixa onde o sistema não diferencia). */
function sameDir(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** true se a pasta jamais pode ser raiz de projeto (home, pasta pessoal, sistema, raiz de disco). */
function neverProject(dir) {
  const abs = path.resolve(dir);
  if (path.dirname(abs) === abs) return true;
  const home = os.homedir();
  if (sameDir(abs, home)) return true;
  if (sameDir(path.dirname(abs), home) && USER_FOLDERS.has(path.basename(abs).toLowerCase())) return true;
  const rel = path.relative(home, abs);
  const inHome = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (SYSTEM_LEAVES.has(path.basename(abs).toLowerCase())) return true;
  const segments = (inHome ? rel : abs).split(/[\\/]/).map((s) => s.toLowerCase());
  const tempIdx = segments.findIndex((s, i) => s === 'appdata' && segments[i + 1] === 'local' && segments[i + 2] === 'temp');
  return (tempIdx >= 0 ? segments.slice(tempIdx + 3) : segments).some((s) => SYSTEM_SEGMENTS.has(s));
}

/** Raiz do projeto que contém `dir` (primeiro ancestral com marcador), ou null. */
function projectRoot(dir) {
  let cur = path.resolve(dir);
  for (;;) {
    if (neverProject(cur)) return null;
    if (MARKERS.some((m) => fs.existsSync(path.join(cur, m)))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

/** Arquivo que fixa a pasta de origem da sessão; subagentes (`id~agente`) dividem o do pai. */
function pinFile(sessionId) {
  const raw = String(sessionId).split('~')[0];
  return path.join(dataHome(), 'origins', `${sha(raw).slice(0, 24)}.json`);
}

/**
 * Pasta onde a sessão nasceu: a primeira vista fica fixada em disco, as seguintes (depois de
 * um `cd` do agente) voltam a ela. Sem gravação possível, vale a pasta recebida.
 */
function originOf(root, sessionId) {
  if (!sessionId) return root;
  const file = pinFile(sessionId);
  try {
    const pinned = JSON.parse(fs.readFileSync(file, 'utf8')).root;
    if (typeof pinned === 'string' && pinned) return pinned;
  } catch { /* primeira vez nesta sessão */ }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ root: path.resolve(root) }), 'utf8');
    prune(path.dirname(file));
  } catch { /* sem pino a sessão segue com a pasta recebida */ }
  return root;
}

/** Pino é cache: sessão parada há mais de uma semana não volta. */
function prune(dir, now = Date.now()) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try { if (now - fs.statSync(p).mtimeMs > PIN_TTL_MS) fs.unlinkSync(p); } catch { /* sumiu no caminho */ }
    }
  } catch { /* pasta ausente */ }
}

/**
 * Pasta de estado de `root`, no contexto de `sessionId` quando houver.
 * @param {string} root pasta atual da chamada
 * @param {string} [sessionId]
 * @returns {string}
 */
function stateDir(root, sessionId) {
  const origin = path.resolve(originOf(root || process.cwd(), sessionId));
  const project = projectRoot(origin);
  return project
    ? path.join(project, '.token-guard')
    : path.join(dataHome(), 'state', sha(origin.toLowerCase()).slice(0, 16));
}

module.exports = { stateDir, projectRoot, dataHome, originOf, neverProject };
