'use strict';
/**
 * lib/update-check.cjs — checagem opt-out de versão nova publicada no
 * registry npm. Núcleo puro (compareVersions/isStale/decide) + I/O
 * injetável (cache em disco + HTTP), mesmo padrão REAL_DEPS/depsOverride de
 * lib/daemon-lifecycle.cjs — testável sem rede/disco real.
 *
 * Nunca chamado por hook nem pelo daemon: só por caminhos explicitamente
 * invocados pelo usuário (cli.cjs status/--version). TOKEN_GUARD_UPDATE_CHECK=off
 * desliga sem tocar cache nem rede.
 */

const fs = require('fs');
const https = require('https');
const http = require('http');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 2000;
const REGISTRY_BASE_URL = 'https://registry.npmjs.org';

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function isStale(cache, now, ttlMs) {
  if (!cache || typeof cache.checkedAt !== 'number') return true;
  return now - cache.checkedAt >= ttlMs;
}

function decide({ localVersion, latestVersion }) {
  return {
    checked: true,
    updateAvailable: compareVersions(localVersion, latestVersion) < 0,
    latestVersion,
    localVersion,
  };
}

// Semver oficial: identificadores de pre-release/build só podem conter
// [0-9A-Za-z-], separados por ponto — sem isso, um sufixo como
// "2.4.0-<sequência de escape ANSI>" passava pela validação anterior
// (`[-+].*`, que aceitava QUALQUER caractere depois do hífen).
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Extrai `version` de um corpo JSON de resposta — pura, testável sem rede.
 * Valida o formato semver antes de aceitar: este valor vai direto pra
 * `console.log` em cli.cjs, então uma string arbitrária do registry (ex.
 * sequências de escape ANSI) não deve passar sem checagem de forma.
 */
function extractVersion(statusCode, body) {
  if (statusCode !== 200) return null;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed.version === 'string' && SEMVER_RE.test(parsed.version) ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * GET de um `url` (http: ou https:, escolhido pelo protocolo) que resolve o
 * `version` do corpo JSON ou `null` em qualquer falha (status!=200, timeout,
 * erro de rede, corpo malformado) — nunca rejeita. Protocol-agnostic pra ser
 * exercitável em teste contra um servidor http local de verdade (mesmo
 * padrão de test/daemon-server.test.cjs), sem precisar de certificado TLS.
 */
const MAX_BODY_BYTES = 16 * 1024;

function fetchVersionFromUrl(url, timeoutMs) {
  const client = url.startsWith('https:') ? https : http;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(value);
    };
    // `timeout` do http.get é inatividade de socket (reseta a cada byte
    // recebido) — sozinho não protege contra um servidor "slow-drip" que
    // mantém a conexão viva enviando pouco a pouco. Deadline absoluto aqui
    // garante que checkForUpdate sempre resolve dentro de timeoutMs.
    const deadline = setTimeout(() => { req.destroy(); done(null); }, timeoutMs);
    const req = client.get(url, { timeout: timeoutMs, headers: { accept: 'application/json' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY_BYTES) { res.destroy(); done(null); }
      });
      res.on('end', () => done(extractVersion(res.statusCode, body)));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => { req.destroy(); done(null); });
    req.on('error', () => done(null));
  });
}

// `baseUrl` só existe pra permitir testar a composição real (pkgName → URL →
// fetch → version) contra um servidor http local, sem bater no registry.npmjs.org
// de verdade — em produção, REAL_DEPS.fetchLatest nunca passa esse argumento,
// então o comportamento real é sempre contra REGISTRY_BASE_URL.
function buildRegistryUrl(pkgName, baseUrl = REGISTRY_BASE_URL) {
  return `${baseUrl}/${encodeURIComponent(pkgName)}/latest`;
}

function fetchLatestReal(pkgName, timeoutMs, baseUrl = REGISTRY_BASE_URL) {
  return fetchVersionFromUrl(buildRegistryUrl(pkgName, baseUrl), timeoutMs);
}

const REAL_DEPS = {
  readCache: (cacheFile) => {
    try {
      const raw = fs.readFileSync(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.latestVersion !== 'string' || typeof parsed.checkedAt !== 'number') return null;
      if (!SEMVER_RE.test(parsed.latestVersion)) return null;
      return parsed;
    } catch {
      return null;
    }
  },
  writeCache: (cacheFile, obj) => {
    try {
      fs.mkdirSync(require('path').dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(obj));
    } catch { /* best-effort: cache é otimização, não requisito */ }
  },
  fetchLatest: (pkgName, timeoutMs) => fetchLatestReal(pkgName, timeoutMs),
};

/**
 * @param {{localVersion:string, cacheFile:string, pkgName?:string, now?:number, ttlMs?:number, timeoutMs?:number}} params
 * @param {object} [depsOverride]
 * @returns {Promise<{checked:false, reason:'disabled'|'offline'} | {checked:true, updateAvailable:boolean, latestVersion:string, localVersion:string}>}
 */
async function checkForUpdate(params, depsOverride) {
  const deps = { ...REAL_DEPS, ...depsOverride };
  const {
    localVersion,
    cacheFile,
    pkgName = '@allansantos-dev/token-guard',
    now = Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = params;

  if (process.env.TOKEN_GUARD_UPDATE_CHECK === 'off') {
    return { checked: false, reason: 'disabled' };
  }

  let cache = null;
  try { cache = deps.readCache(cacheFile); } catch { /* best-effort: cache é otimização, não requisito */ }
  if (cache && !isStale(cache, now, ttlMs)) {
    return decide({ localVersion, latestVersion: cache.latestVersion });
  }

  let latestVersion = null;
  try { latestVersion = await deps.fetchLatest(pkgName, timeoutMs); } catch { /* rede indisponível: tratado como offline abaixo */ }
  if (!latestVersion) {
    if (cache) return decide({ localVersion, latestVersion: cache.latestVersion });
    return { checked: false, reason: 'offline' };
  }

  try { deps.writeCache(cacheFile, { latestVersion, checkedAt: now }); } catch { /* best-effort: cache é otimização, não requisito */ }
  return decide({ localVersion, latestVersion });
}

module.exports = {
  compareVersions, isStale, decide, checkForUpdate, REAL_DEPS,
  extractVersion, fetchVersionFromUrl, buildRegistryUrl, fetchLatestReal,
  DEFAULT_TTL_MS, DEFAULT_TIMEOUT_MS,
};
