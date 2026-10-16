'use strict';
/**
 * daemon-status.cjs — o daemon e o hook http estão de pé? (A25)
 *
 * Só OBSERVA: não sobe daemon, não reaponta settings. "Hook http não bloqueia"
 * tem causas distintas e cada uma sai com um rótulo próprio: daemon fora do ar,
 * porta ocupada por outro processo, token divergente, settings apontando para
 * outra porta ou sem hook registrado.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { connectOnce } = require('./daemon-client.cjs');
const { PACKAGE_VERSION } = require('../adapters/daemon-server.cjs');
const H = require('../adapters/daemon-http.cjs');

const TG_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/token-guard\//;

/** GET /health com o token do dono. Nunca lança. */
function probeHealth(port, token, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1', port, path: H.HEALTH, timeout: timeoutMs,
      headers: token ? { 'x-token-guard': token } : {},
    }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve({ state: 'ok' });
      else if (res.statusCode === 401) resolve({ state: 'token', detail: 'responde, mas recusa o token (outro dono ou token regravado)' });
      else resolve({ state: 'foreign', detail: `HTTP ${res.statusCode} — não é o daemon do token-guard` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ state: 'timeout', detail: 'sem resposta' }); });
    req.on('error', (e) => resolve({ state: 'down', detail: e.code || e.message }));
  });
}

/** Portas dos hooks http do token-guard no settings.json do Claude Code. */
function registeredPorts(settingsFile) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const ports = new Set();
    for (const entries of Object.values((settings && settings.hooks) || {})) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        for (const h of Array.isArray(entry && entry.hooks) ? entry.hooks : []) {
          const m = h && h.type === 'http' && typeof h.url === 'string' ? TG_URL_RE.exec(h.url) : null;
          if (m) ports.add(Number(m[1]));
        }
      }
    }
    return { ports: [...ports] };
  } catch (err) {
    return err.code === 'ENOENT' ? { ports: [] } : { ports: [], error: err.message };
  }
}

/**
 * @returns {Promise<{ipc:{ok:boolean,version?:string}, http:{port:number,state:string,detail?:string},
 *   settings:{ports:number[],error?:string}, verdict:string}>}
 */
async function inspect({ settingsFile = H.claudeSettingsPath() } = {}) {
  const hello = await connectOnce('hello', {}, { timeoutMs: 500 });
  const ipc = hello.ok ? { ok: true, version: hello.result.packageVersion } : { ok: false };
  const port = H.httpPort();
  const httpState = await probeHealth(port, H.readToken());
  const settings = registeredPorts(settingsFile);

  let verdict;
  if (!settings.ports.length) verdict = 'sem hook http registrado em ~/.claude/settings.json (o Claude Code usa o hook de comando, se houver)';
  else if (!settings.ports.includes(port)) verdict = `settings aponta para ${settings.ports.join(',')} mas o daemon usa ${port}: reabra a sessão ou rode init`;
  else if (httpState.state !== 'ok') verdict = `hook http registrado na ${port}, mas o daemon não atende (${httpState.state}): conexão recusada = fail-open, nada é barrado`;
  else verdict = 'hook http registrado e respondendo';
  return { ipc, http: { port, ...httpState }, settings, packageVersion: PACKAGE_VERSION, verdict };
}

module.exports = { inspect, probeHealth, registeredPorts };
