'use strict';
/**
 * ctxwatch.cjs — aviso de peso de contexto (UserPromptSubmit).
 *
 * Medição nos transcripts de 2026-10-12: sessões que passaram de 200k tokens de
 * contexto foram ~68% do gasto do dia. Cada chamada relê o contexto inteiro do
 * cache, então o custo por turno cresce linear com ele. O token-guard barra
 * leitura cara, mas ninguém avisava o humano de que a SESSÃO ficou cara.
 *
 * O aviso vai em `systemMessage` (vai para o usuário, não entra no contexto do
 * modelo: não custa token). Só o humano pode rodar /compact ou /clear.
 * Fail-open: qualquer erro = sem aviso.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const COST = require('./cost.cjs');
const CFG = require('./config.cjs');

const TAIL_BYTES = 512 * 1024;
const FIRST_WARN = 120000; // tokens de contexto
const STEP = 60000; // reavisa a cada degrau novo

/** Último uso reportado no transcript: { tokens, model } ou null. */
function lastUsage(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (!l || l.indexOf('"usage"') === -1) continue;
      let o;
      try { o = JSON.parse(l); } catch { continue; } // 1ª linha do recorte pode vir cortada
      const u = o && o.message && o.message.usage;
      if (!u || o.type !== 'assistant' || o.isSidechain) continue;
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (tokens > 0) return { tokens, model: o.message.model || '' };
    }
  } catch { /* fail-open */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return null;
}

function bucket(tokens) {
  return tokens < FIRST_WARN ? 0 : 1 + Math.floor((tokens - FIRST_WARN) / STEP);
}

/** Custo de reler o contexto inteiro do cache numa chamada, com o fator e a faixa do próprio modelo. */
function usdPerTurn(tokens, model, prices = COST.DEFAULT_PRICES) {
  const p = COST.priceOf(model, prices);
  return p && Number.isFinite(p.in)
    ? COST.callCost({ input: 0, output: 0, cacheRead: tokens, cacheWrite5m: 0, cacheWrite1h: 0 }, p)
    : null;
}

/** Mesma tabela de preços do `token-guard cost`: `cost.prices` da config, senão o padrão. */
function pricesFor(root) {
  try {
    const p = CFG.load(root).cost?.prices;
    return p && typeof p === 'object' ? p : COST.DEFAULT_PRICES;
  } catch { return COST.DEFAULT_PRICES; }
}

function message(tokens, model, prices) {
  const usd = usdPerTurn(tokens, model, prices);
  const cost = usd === null ? '' : ` (~US$ ${usd.toFixed(2)} só de reler o contexto a cada chamada)`;
  return `token-guard: contexto em ~${Math.round(tokens / 1000)}k tokens${cost}. `
    + 'Se a tarefa atual fechou, /compact ou /clear agora barateia todos os turnos seguintes.';
}

function stateFile(root, sessionId) {
  const h = crypto.createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 16);
  return path.join(root, '.token-guard', 'sessions', `ctxwatch-${h}.json`);
}

function readBucket(file) {
  try { return Number(JSON.parse(fs.readFileSync(file, 'utf8')).bucket) || 0; } catch { return 0; }
}

/**
 * @returns {string|null} texto para o usuário, ou null (sem transcript, abaixo do
 *          limite, ou degrau já avisado). Compactar derruba o contexto, o que
 *          rearma o aviso.
 */
function check({ root, sessionId, transcriptPath }) {
  try {
    if (!root || !sessionId || !transcriptPath) return null;
    const usage = lastUsage(transcriptPath);
    if (!usage) return null;
    const now = bucket(usage.tokens);
    const file = stateFile(root, sessionId);
    const warned = readBucket(file);
    if (now !== warned) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ bucket: now }), 'utf8');
      } catch { /* sem estado = reavisa; melhor que calar */ }
    }
    return now > warned ? message(usage.tokens, usage.model, pricesFor(root)) : null;
  } catch { return null; }
}

module.exports = { check, lastUsage, bucket, usdPerTurn, FIRST_WARN, STEP };
