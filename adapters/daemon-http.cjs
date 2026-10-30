'use strict';
/**
 * daemon-http.cjs — hook http do Claude Code servido pelo daemon (A16).
 *
 * No hook de comando o harness abre um processo Node por chamada; numa máquina
 * com antivírus que inspeciona cada processo novo, é isso — não a decisão —
 * que custa (~500 ms medidos). O Claude Code também aceita hook `type: "http"`:
 * ele faz POST do mesmo JSON de entrada e lê a resposta no mesmo formato de
 * saída. Aqui o daemon, que já está de pé, responde direto — sem processo.
 *
 * Segurança: escuta só em 127.0.0.1 e exige o token do usuário no header
 * `X-Token-Guard` (arquivo no perfil, gravado pelo install e copiado para o
 * settings.json). Sem o arquivo de token, o listener nem sobe.
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('../lib/payload.cjs');
const CT = require('../lib/contract.cjs');
const H = require('../lib/claude-hooks.cjs');
const CW = require('../lib/ctxwatch.cjs');

const MAX_BODY_BYTES = 64 * 1024 * 1024; // PostToolUse traz o resultado inteiro
const ROUTES = { '/token-guard/pre': 'pre', '/token-guard/post': 'post', '/token-guard/prompt': 'prompt' };
const HEALTH = '/token-guard/health';

/** Porta fixada por env: sem fallback — ocupada, o HTTP não sobe (e avisa alto). */
function fixedPort() {
  const override = Number(process.env.TOKEN_GUARD_HTTP_PORT);
  return Number.isInteger(override) && override > 0 && override < 65536 ? override : null;
}

/** Porta preferida, estável por conta de usuário. */
function defaultPort() {
  let user;
  try { user = os.userInfo().username; } catch { user = process.env.USERNAME || process.env.USER || 'default'; }
  return 41000 + (crypto.createHash('sha1').update(String(user)).digest().readUInt32BE(0) % 8000);
}

/** Onde o daemon registra a porta em que o HTTP subiu de fato. */
function endpointPath() {
  return path.join(os.homedir(), '.token-guard', 'daemon-http.json');
}

function readEndpoint() {
  try {
    const e = JSON.parse(fs.readFileSync(endpointPath(), 'utf8'));
    return e && Number.isInteger(e.port) && e.port > 0 && e.port < 65536 ? e : null;
  } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tg-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

/** Porta que os clientes devem usar: a fixada, senão a registrada pelo daemon, senão a preferida. */
function httpPort() {
  const rec = readEndpoint();
  return fixedPort() || (rec && rec.port) || defaultPort();
}

/** Ordem de bind: preferida, última registrada, qualquer livre (0). Fixada: só ela. */
function candidatePorts() {
  const fixed = fixedPort();
  if (fixed) return [fixed];
  const rec = readEndpoint();
  return [...new Set([defaultPort(), rec && rec.port, 0].filter((p) => p !== null && p !== undefined))];
}

/**
 * Sobe `server` na primeira porta livre de `ports` (127.0.0.1). Resolve a
 * porta escolhida; rejeita com o último erro se nenhuma serviu.
 */
function listenFirstFree(server, ports) {
  return new Promise((resolve, reject) => {
    let i = 0;
    const attempt = () => {
      const port = ports[i];
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err && err.code === 'EADDRINUSE' && ++i < ports.length) return attempt();
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    attempt();
  });
}

function claudeSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

const TG_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)(\/token-guard\/[a-z]+)$/;

/**
 * Reaponta os hooks http do token-guard no settings.json do Claude Code para
 * `port` — só esses, só se a porta mudou, gravação atômica. O watcher do
 * Claude Code relê hooks alterados no arquivo, então a sessão aberta segue o
 * daemon que voltou em outra porta.
 * @returns {{ok:true, changed:number} | {ok:false, error:string}}
 */
function syncClaudeSettings(port, file = claudeSettingsPath()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    return err.code === 'ENOENT' ? { ok: true, changed: 0 } : { ok: false, error: `${file}: ${err.message}` };
  }
  let settings;
  try { settings = JSON.parse(raw); } catch (err) { return { ok: false, error: `${file} não é JSON válido: ${err.message}` }; }
  let changed = 0;
  for (const entries of Object.values((settings && settings.hooks) || {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const h of Array.isArray(entry && entry.hooks) ? entry.hooks : []) {
        const m = h && h.type === 'http' && typeof h.url === 'string' ? TG_URL_RE.exec(h.url) : null;
        if (m && Number(m[1]) !== port) { h.url = `http://127.0.0.1:${port}${m[2]}`; changed++; }
      }
    }
  }
  if (!changed) return { ok: true, changed: 0 };
  try { writeJsonAtomic(file, settings); } catch (err) { return { ok: false, error: `${file}: ${err.message}` }; }
  return { ok: true, changed };
}

function httpTokenPath() {
  return path.join(os.homedir(), '.token-guard', 'daemon-http.token');
}

function readToken() {
  try {
    const t = fs.readFileSync(httpTokenPath(), 'utf8').trim();
    return t || null;
  } catch { return null; }
}

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Decide um evento com o mesmo roteamento do RPC (cache de veredito incluso). */
function answer(kind, payload, handle) {
  if (kind === 'pre') {
    const r = handle({ id: 1, method: 'check', params: { root: P.cwd(payload), payload } });
    return H.preEnvelope(r && r.result && r.result.verdict);
  }
  if (kind === 'post') {
    const r = handle({ id: 1, method: 'postprocess', params: H.postArgs(payload) });
    return H.postEnvelope(r && r.result && r.result.trimmed);
  }
  const args = H.promptArgs(payload);
  if (!args) return null;
  const state = CT.readState(args.root, args.sessionId);
  const r = handle({ id: 1, method: 'contract', params: args });
  const decision = (r && r.result) || {};
  const out = H.promptEnvelope(decision.text, CW.check(args));
  if (decision.text) CT.writeState(args.root, args.sessionId, { injected: [...state.injected, ...(decision.triggers || [])] });
  return out;
}

/**
 * @param {{token:string, handle:(msg:object)=>object, onActivity?:()=>void, ui?:{handle:Function}}} opts
 *        handle = handleMessage do daemon, já ligado ao contexto dele.
 *        ui = tela de setup (adapters/daemon-ui.cjs): atende /token-guard/ui* e /token-guard/stream
 *        com a própria autenticação (bilhete+cookie; token do dono para o ícone).
 */
function createHttpServer({ token, handle, onActivity, ui }) {
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    const route = String(req.url || '').split('?')[0];
    try {
      if (ui && ui.handle(req, res, route)) return;
    } catch (err) {
      // A tela nunca derruba o daemon que carrega os hooks de todo mundo (fail-open).
      if (!res.headersSent) return send(500, JSON.stringify({ error: `tela: ${err && err.message}` }));
      res.end();
      return;
    }
    const kind = ROUTES[route];
    const health = req.method === 'GET' && route === HEALTH;
    if (!health && (req.method !== 'POST' || !kind)) return send(404, '{"error":"rota desconhecida"}');
    if (!sameToken(req.headers['x-token-guard'], token)) return send(401, '{"error":"token ausente ou invalido"}');
    // Prova de que quem responde na porta é ESTE daemon (com o token do dono), não um forasteiro.
    if (health) return send(200, JSON.stringify({ ok: true, pid: process.pid }));

    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { send(413, '{"error":"payload grande demais"}'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      if (onActivity) onActivity();
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, '{"error":"JSON invalido"}'); }
      try {
        send(200, JSON.stringify(answer(kind, payload, handle) || {}));
      } catch (err) {
        // Fail-loud: o Claude Code mostra o erro (não bloqueante) em vez de
        // seguir como se o guard tivesse aprovado em silêncio.
        send(500, JSON.stringify({ error: `token-guard: ${err && err.message}` }));
      }
    });
  });
}

module.exports = {
  createHttpServer, httpPort, httpTokenPath, readToken,
  fixedPort, defaultPort, candidatePorts, listenFirstFree,
  endpointPath, readEndpoint, writeJsonAtomic, claudeSettingsPath, syncClaudeSettings, HEALTH,
};
