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

/** Porta que os clientes devem usar: a fixada, senão a registrada pelo daemon; null = nenhum daemon subiu o http ainda. */
function httpPort() {
  const rec = readEndpoint();
  return fixedPort() || (rec && rec.port) || null;
}

/** Ordem de bind: a última registrada, depois qualquer livre (0). Fixada: só ela. */
function candidatePorts() {
  const fixed = fixedPort();
  if (fixed) return [fixed];
  const rec = readEndpoint();
  return rec ? [rec.port, 0] : [0];
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

const TG_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/token-guard\/([a-z]+)(?:\?[^#]*)?$/;

/**
 * URL do hook http: a origem declarada (`hook-origin`) e o arquivo de execução que é dono da porta
 * (`port-file`, relativo ao perfil) vão na query, que o roteador ignora. Porta 0 = ainda sem daemon;
 * o daemon reescreve a URL com a porta em que subiu.
 */
function hookUrl(port, route) {
  return `http://127.0.0.1:${port || 0}/token-guard/${route}?hook-origin=token-guard&port-file=~/.token-guard/daemon-http.json`;
}

/**
 * Reaponta os hooks http do token-guard no settings.json do Claude Code para
 * `port` — só esses, só se a URL difere da canônica, gravação atômica. O watcher do
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
        if (m && h.url !== hookUrl(port, m[2])) { h.url = hookUrl(port, m[2]); changed++; }
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
  if (decision.text) CT.commitInjection(args.root, args.sessionId, state, decision);
  return out;
}

/**
 * @param {{token:string, handle:(msg:object)=>object, onActivity?:()=>void, ui?:{handle:Function}}} opts
 *        handle = handleMessage do daemon, já ligado ao contexto dele.
 *        ui = tela de setup (adapters/daemon-ui.cjs): atende /token-guard/ui* e /token-guard/stream
 *        com a própria autenticação (bilhete+cookie; token do dono para o ícone).
 */
function createHttpServer({ token, handle, onActivity, ui, version }) {
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
    // A versão deixa quem trocou os arquivos provar que o processo que responde é o novo, não o antigo.
    if (health) return send(200, JSON.stringify({ ok: true, pid: process.pid, version: version || null }));

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

/**
 * Pergunta ao health da porta quem responde. Resolve `{pid, version}` (version null num daemon antigo,
 * que não a informava) ou null se ninguém do token do dono atendeu.
 */
function probeHealth(port, token, timeoutMs = 500) {
  return new Promise((resolve) => {
    if (!port) return resolve(null);
    const req = http.request({
      host: '127.0.0.1', port, path: HEALTH, method: 'GET', timeout: timeoutMs,
      headers: { 'x-token-guard': token },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const j = JSON.parse(body);
          resolve(j && j.ok ? { pid: j.pid, version: j.version || null } : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

module.exports = {
  probeHealth, createHttpServer, httpPort, httpTokenPath, readToken, sameToken,
  fixedPort, candidatePorts, hookUrl, listenFirstFree,
  answer, endpointPath, readEndpoint, writeJsonAtomic, claudeSettingsPath, syncClaudeSettings, HEALTH,
};
