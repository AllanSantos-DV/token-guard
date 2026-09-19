#!/usr/bin/env node
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decide } = require('../lib/decide.cjs');
const { parseStream, writeFrame } = require('../lib/ipc-frame.cjs');

const PROTOCOL_VERSION = 1;
const PACKAGE_VERSION = (() => {
  try { return require('../package.json').version; } catch { return '0.0.0'; }
})();

function defaultEndpoint() {
  if (process.platform === 'win32') {
    const sid = process.env.TOKEN_GUARD_SID || String(process.pid);
    return `\\\\.\\pipe\\token-guard-${sid}`;
  }
  const dir = process.env.XDG_RUNTIME_DIR || '/tmp';
  return path.join(dir, `token-guard-${process.uid}.sock`);
}

function ruleSetHash(root) {
  let h = '';
  for (const rel of ['lib/config.cjs', 'lib/rules.cjs']) {
    try { h += fs.readFileSync(path.join(__dirname, '..', rel)); } catch { /* noop */ }
  }
  const stateFiles = [
    path.join(root, 'token-guard.config.json'),
    path.join(root, '.token-guard', 'config.json'),
    path.join(root, '.token-guard', 'repo-stats.json'),
  ];
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

function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || !msg.id) return null;
  const method = msg.method;

  if (method === 'hello') {
    return { id: msg.id, result: { protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION } };
  }

  if (method === 'ping') {
    return { id: msg.id, result: { pong: true } };
  }

  if (method === 'check') {
    const params = msg.params || {};
    const root = params.root || process.cwd();
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

  return { id: msg.id, error: { code: -32601, message: `Método não suportado: ${method}` } };
}

function createServer(ctxOverride) {
  const ctx = ctxOverride || {
    cache: new Map(),
    hits: 0,
    misses: 0,
  };
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    const frames = parseStream(socket);
    frames.on('data', (msg) => {
      const reply = handleMessage(msg, ctx);
      if (reply) writeFrame(socket, reply);
    });
    frames.on('error', () => socket.destroy());
    frames.on('end', () => socket.end());
  });
  server.ctx = ctx;
  return server;
}

function start(endpointOverride) {
  const endpoint = endpointOverride || defaultEndpoint();
  const server = createServer();
  server.listen(endpoint, () => {
    process.stderr.write(`token-guard daemon pronto em ${endpoint} (${PACKAGE_VERSION})\n`);
  });
  server.on('error', (err) => {
    process.stderr.write(`token-guard daemon falhou: ${err.message}\n`);
    process.exit(1);
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, dispatch, handleMessage, start, defaultEndpoint, ruleSetHash, PROTOCOL_VERSION, PACKAGE_VERSION };