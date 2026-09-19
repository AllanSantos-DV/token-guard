#!/usr/bin/env node
'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decide } = require('../lib/decide.cjs');
const { parseStream, writeFrame } = require('../lib/ipc-frame.cjs');
const CFG = require('../lib/config.cjs');
const CT = require('../lib/contract.cjs');
const { noteResult, isRead } = require('../lib/dupread.cjs');
const { postProcess } = require('../lib/postresult.cjs');

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

/** Replica prompt-hook.cjs:42-52 — leitura+decisão do contrato, sem persistir estado. */
function dispatchContract(params) {
  const root = params && params.root;
  const sessionId = params && params.sessionId;
  try {
    const cfg = CFG.load(root);
    if (cfg.mode === 'off') return { ok: true, triggers: [], text: '' };
    const contract = CT.load(root);
    if (!contract.order.length) return { ok: true, triggers: [], text: '' };
    const state = CT.readState(root, sessionId);
    const touched = CT.readTouched(root, sessionId);
    const decision = CT.decide({ contract, touched, injected: state.injected });
    return { ok: true, triggers: decision.triggers, text: decision.text };
  } catch {
    return { ok: true, triggers: [], text: '' };
  }
}

/** Replica post-hook.cjs:26-53 — bigResult + dupRead, cfg carregado quente no daemon. */
function dispatchPostprocess(params) {
  const { name, input, result, root, sessionId } = params || {};
  try {
    const cfg = CFG.load(root);
    const trimmed = postProcess({ name, input, result, root, cfg });
    if (trimmed) return { ok: true, trimmed };
    if (sessionId && isRead(name)) {
      try { noteResult({ name, input, result, root, sessionId, cfg }); } catch { /* evidência */ }
    }
    return { ok: true, trimmed: null };
  } catch {
    return { ok: true, trimmed: null };
  }
}

function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || !msg.id) return null;
  const method = msg.method;

  try {
  if (method === 'hello') {
    return { id: msg.id, result: { protocolVersion: PROTOCOL_VERSION, packageVersion: PACKAGE_VERSION } };
  }

  if (method === 'ping') {
    return { id: msg.id, result: { pong: true } };
  }

  if (method === 'check') {
    const params = msg.params || {};
    const root = typeof params.root === 'string' && params.root ? params.root : process.cwd();
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

  if (method === 'contract') {
    return { id: msg.id, result: dispatchContract(msg.params || {}) };
  }

  if (method === 'postprocess') {
    return { id: msg.id, result: dispatchPostprocess(msg.params || {}) };
  }

  return { id: msg.id, error: { code: -32601, message: `Método não suportado: ${method}` } };
  } catch (err) {
    // Fail-loud pro cliente (erro visível na resposta RPC), fail-open pro processo:
    // uma requisição malformada nunca pode derrubar o daemon compartilhado.
    return { id: msg.id, error: { code: -32000, message: `Erro interno: ${err && err.message}` } };
  }
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

module.exports = {
  createServer, dispatch, dispatchContract, dispatchPostprocess, handleMessage, start,
  defaultEndpoint, ruleSetHash, PROTOCOL_VERSION, PACKAGE_VERSION,
};