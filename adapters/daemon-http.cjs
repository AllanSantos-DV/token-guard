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

const MAX_BODY_BYTES = 64 * 1024 * 1024; // PostToolUse traz o resultado inteiro
const ROUTES = { '/token-guard/pre': 'pre', '/token-guard/post': 'post', '/token-guard/prompt': 'prompt' };

/** Porta estável por conta de usuário (a URL vai fixa no settings.json). */
function httpPort() {
  const override = Number(process.env.TOKEN_GUARD_HTTP_PORT);
  if (Number.isInteger(override) && override > 0 && override < 65536) return override;
  let user;
  try { user = os.userInfo().username; } catch { user = process.env.USERNAME || process.env.USER || 'default'; }
  return 41000 + (crypto.createHash('sha1').update(String(user)).digest().readUInt32BE(0) % 8000);
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
  const out = H.promptEnvelope(decision.text);
  if (out) CT.writeState(args.root, args.sessionId, { injected: [...state.injected, ...(decision.triggers || [])] });
  return out;
}

/**
 * @param {{token:string, handle:(msg:object)=>object, onActivity?:()=>void}} opts
 *        handle = handleMessage do daemon, já ligado ao contexto dele.
 */
function createHttpServer({ token, handle, onActivity }) {
  return http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    };
    const kind = ROUTES[String(req.url || '').split('?')[0]];
    if (req.method !== 'POST' || !kind) return send(404, '{"error":"rota desconhecida"}');
    if (!sameToken(req.headers['x-token-guard'], token)) return send(401, '{"error":"token ausente ou invalido"}');

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

module.exports = { createHttpServer, httpPort, httpTokenPath, readToken };
