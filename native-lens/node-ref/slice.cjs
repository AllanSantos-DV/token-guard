'use strict';
/**
 * slice.cjs — referência Node do slice PreToolUse: o `decide` real atrás do contrato HTTP de SPEC.md.
 * É o termo de comparação "mesmo corte" dos protótipos nativos: tira do custo do daemon inteiro tudo
 * que não é o guard (roteamento, cache de veredito, eventos, UI, MCP).
 *
 *   node slice.cjs --port N --token T
 */

const http = require('http');
const crypto = require('crypto');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const { decide } = require(path.join(root, 'lib', 'decide.cjs'));
const H = require(path.join(root, 'lib', 'claude-hooks.cjs'));

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg('port'));
const token = String(arg('token') || '');

const sameToken = (a, b) => {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const server = http.createServer((req, res) => {
  const send = (status, body, extra) => {
    res.writeHead(status, { 'content-type': 'application/json', ...(extra || {}) });
    res.end(body);
  };
  const route = String(req.url || '').split('?')[0];
  const health = req.method === 'GET' && route === '/token-guard/health';
  if (!health && !(req.method === 'POST' && route === '/token-guard/pre')) return send(404, JSON.stringify({ error: 'rota desconhecida' }));
  if (!sameToken(req.headers['x-token-guard'], token)) return send(401, JSON.stringify({ error: 'token ausente ou invalido' }));
  if (health) return send(200, JSON.stringify({ ok: true, pid: process.pid, impl: 'node' }));
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, JSON.stringify({ error: 'JSON invalido' })); }
    const verdict = decide(payload);
    send(200, JSON.stringify(H.preEnvelope(verdict) || {}), verdict ? { 'x-tg-rule': verdict.rule } : undefined);
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`READY port=${port} impl=node\n`);
});
