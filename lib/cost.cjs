'use strict';
/**
 * cost.cjs — custo por sessão a partir dos transcripts do Claude Code (A26).
 *
 * Fecha o ciclo de medição: sem custo por sessão não há como provar a economia
 * do ctxwatch/bigResult (comparar antes e depois). Só lê; zero dependência.
 *
 * O transcript grava a mesma resposta da API em várias linhas (streaming), com
 * `usage` cumulativo: a chave `message.id`+`requestId` deduplica e vale a última
 * linha. Versões recentes do Claude Code não gravam `requestId` (nem no transcript
 * principal nem no de subagente): aí a chave é só o `message.id`.
 * Subagentes ficam em `<sessão>/subagents/*.jsonl` com o `sessionId` do pai e
 * somam na sessão dele. Preço por modelo é PREMISSA de configuração (US$ por milhão de tokens),
 * não leitura de fatura: modelo sem preço entra como "sem preço", nunca chutado.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

/**
 * US$/Mtok da página oficial (https://platform.claude.com/docs/en/about-claude/pricing).
 * `cacheRead`: fator de leitura de cache sobre `in` (padrão 0,1×). `long`: faixa aplicada à chamada inteira
 * quando o prompt passa de `from` tokens. A chave mais específica vem antes: a primeira que casa vence.
 */
const DEFAULT_PRICES = {
  'opus-5-5': { in: 4, out: 20, cacheRead: 0.05 },
  'sonnet-5-5': { in: 2, out: 10, cacheRead: 0.05 },
  'haiku-5-5': { in: 0.1, out: 0.5, long: { from: 100000, in: 0.5, out: 2.5 } },
  'fable-5-1': { in: 10, out: 50, cacheRead: 0.025 },
  opus: { in: 5, out: 25 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
};
const CACHE_FACTOR = { read: 0.1, write5m: 1.25, write1h: 2 };
const HEAVY_CONTEXT = 200000;

/** Preço do modelo pela primeira chave contida no nome (opus-5-5, opus…); null = sem preço. */
function priceOf(model, prices) {
  const m = String(model || '').toLowerCase();
  for (const [key, p] of Object.entries(prices)) {
    if (m.includes(key.toLowerCase())) return p;
  }
  return null;
}

function callCost(u, price) {
  const w5 = u.cacheWrite5m;
  const w1 = u.cacheWrite1h;
  const prompt = u.input + u.cacheRead + w5 + w1;
  const p = price.long && prompt > price.long.from ? { ...price, ...price.long } : price;
  return (u.input * p.in +
    u.output * p.out +
    u.cacheRead * p.in * (p.cacheRead ?? CACHE_FACTOR.read) +
    w5 * p.in * CACHE_FACTOR.write5m +
    w1 * p.in * CACHE_FACTOR.write1h) / 1e6;
}

/** Extrai o uso de uma linha de transcript; null se não for resposta do assistente com usage. */
function usageOf(rec) {
  const msg = rec && rec.message;
  const u = msg && msg.usage;
  // <synthetic>: mensagem que o próprio Claude Code fabrica (erro, interrupção) — não é chamada cobrada.
  if (!u || rec.type !== 'assistant' || msg.model === '<synthetic>') return null;
  const cc = u.cache_creation || {};
  const total = Number(u.cache_creation_input_tokens) || 0;
  const w5 = Number(cc.ephemeral_5m_input_tokens);
  const w1 = Number(cc.ephemeral_1h_input_tokens);
  // Sem a quebra por TTL, a escrita inteira conta como 5 min (mais barata): subestima, não inventa.
  const known = (Number.isFinite(w5) ? w5 : 0) + (Number.isFinite(w1) ? w1 : 0);
  return {
    id: msg.id ? (rec.requestId ? `${msg.id}:${rec.requestId}` : msg.id) : null,
    model: msg.model || 'desconhecido',
    ts: rec.timestamp ? Date.parse(rec.timestamp) : NaN,
    input: Number(u.input_tokens) || 0,
    output: Number(u.output_tokens) || 0,
    cacheRead: Number(u.cache_read_input_tokens) || 0,
    cacheWrite5m: known ? (Number.isFinite(w5) ? w5 : 0) : total,
    cacheWrite1h: known ? (Number.isFinite(w1) ? w1 : 0) : 0,
  };
}

/** Lê um transcript; devolve as chamadas deduplicadas (a última linha de cada id vence). */
async function readTranscript(file, { since = 0 } = {}) {
  const byId = new Map();
  const anon = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let sessionId = path.basename(file, '.jsonl');
  let cwd = null;
  let bad = 0;
  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { bad += 1; continue; }
    if (rec.sessionId) sessionId = rec.sessionId;
    if (rec.cwd) cwd = rec.cwd;
    const u = usageOf(rec);
    if (!u || (since && !(u.ts >= since))) continue;
    if (u.id) byId.set(u.id, u); else anon.push(u);
  }
  return { sessionId, cwd, calls: [...byId.values(), ...anon], bad };
}

function emptyAgg() {
  return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, maxContext: 0, usd: 0, usdHeavy: 0, unpricedCalls: 0 };
}

function addCall(agg, u, price) {
  const ctx = u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
  agg.calls += 1;
  agg.input += u.input; agg.output += u.output; agg.cacheRead += u.cacheRead;
  agg.cacheWrite5m += u.cacheWrite5m; agg.cacheWrite1h += u.cacheWrite1h;
  agg.maxContext = Math.max(agg.maxContext, ctx);
  if (!price) { agg.unpricedCalls += 1; return; }
  const usd = callCost(u, price);
  agg.usd += usd;
  if (ctx > HEAVY_CONTEXT) agg.usdHeavy += usd;
}

/** Soma por sessão e por modelo. */
function summarize(sessions, prices = DEFAULT_PRICES) {
  const out = { sessions: [], models: {}, total: emptyAgg(), unpricedModels: new Set() };
  for (const s of sessions) {
    const agg = emptyAgg();
    const models = {};
    for (const u of s.calls) {
      const price = priceOf(u.model, prices);
      if (!price) out.unpricedModels.add(u.model);
      addCall(agg, u, price);
      addCall(out.total, u, price);
      addCall(out.models[u.model] = out.models[u.model] || emptyAgg(), u, price);
      models[u.model] = (models[u.model] || 0) + 1;
    }
    if (agg.calls) out.sessions.push({ sessionId: s.sessionId, cwd: s.cwd, agg, models });
  }
  out.sessions.sort((a, b) => b.agg.usd - a.agg.usd);
  out.unpricedModels = [...out.unpricedModels];
  return out;
}

/** Acrescenta a `files` os `.jsonl` de `dir` modificados desde `sinceMs`; pasta ausente não conta. */
function jsonlIn(dir, sinceMs, files) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    const full = path.join(dir, e.name);
    // mtime anterior ao corte: nenhuma linha do arquivo pode ser mais nova.
    if (sinceMs && fs.statSync(full).mtimeMs < sinceMs) continue;
    files.push(full);
  }
}

/** Transcripts das sessões (`<projeto>/*.jsonl`) e dos subagentes (`<projeto>/<sessão>/subagents/*.jsonl`). */
function listTranscripts(dir, sinceMs) {
  const files = [];
  let projects = [];
  try { projects = fs.readdirSync(dir, { withFileTypes: true }); } catch { return files; }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const proj = path.join(dir, p.name);
    jsonlIn(proj, sinceMs, files);
    for (const s of fs.readdirSync(proj, { withFileTypes: true })) {
      if (s.isDirectory()) jsonlIn(path.join(proj, s.name, 'subagents'), sinceMs, files);
    }
  }
  return files;
}

/** Raiz do repositório que contém `start` (primeira pasta acima com `.git`); sem repositório, o próprio `start`. */
function repoRoot(start) {
  const from = path.resolve(start);
  for (let dir = from; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return from;
  }
}

/** `p` é `root` ou fica abaixo dele (no Windows, `path.relative` já ignora maiúsculas). */
function isWithin(p, root) {
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

/** "7d", "12h" ou data ISO → epoch ms; lança em formato inválido (fail loud). */
function parseSince(spec, now = Date.now()) {
  if (!spec) return 0;
  const m = /^(\d+)([dh])$/.exec(spec);
  if (m) return now - Number(m[1]) * (m[2] === 'd' ? 86400000 : 3600000);
  const t = Date.parse(spec);
  if (!Number.isFinite(t)) throw new Error(`--since inválido: "${spec}" (use 7d, 12h ou AAAA-MM-DD)`);
  return t;
}

/**
 * Custo dos transcripts em `dir`.
 * @param {{dir?:string, since?:number, prices?:object, within?:string}} [opts] `within`: só as sessões cujo `cwd` fica nesta pasta
 */
async function analyze({ dir = path.join(os.homedir(), '.claude', 'projects'), since = 0, prices = DEFAULT_PRICES, within = null } = {}) {
  const bySession = new Map();
  const files = listTranscripts(dir, since);
  let bad = 0;
  for (const f of files) {
    const t = await readTranscript(f, { since });
    bad += t.bad;
    const s = bySession.get(t.sessionId);
    if (!s) bySession.set(t.sessionId, t);
    else { s.calls.push(...t.calls); s.cwd = s.cwd || t.cwd; }
  }
  const sessions = [...bySession.values()].filter((s) => !within || (s.cwd && isWithin(s.cwd, within)));
  return { ...summarize(sessions, prices), badLines: bad, transcripts: files.length, within };
}

const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n));
const usd = (n) => `US$ ${n.toFixed(2)}`;

/**
 * Relatório de texto do `token-guard cost`.
 * @param {object} r resultado de `analyze`
 * @param {{top?:number, prices?:object}} [opts] sessões listadas e tabela de preços exibida
 * @returns {string}
 */
function renderText(r, { top = 10, prices = DEFAULT_PRICES } = {}) {
  const lines = [''];
  const t = r.total;
  lines.push(`  token-guard cost · ${r.transcripts} transcripts · ${r.sessions.length} sessões · ${t.calls} chamadas`);
  lines.push('  ' + '─'.repeat(78));
  if (r.within) lines.push(`  só as sessões em ${r.within} e abaixo (--here)`);
  lines.push(`  total estimado: ${usd(t.usd)}  (acima de 200k de contexto: ${t.usd ? Math.round((t.usdHeavy / t.usd) * 100) : 0}%)`);
  lines.push(`  tokens: entrada ${k(t.input)} · saída ${k(t.output)} · cache lido ${k(t.cacheRead)} · cache escrito 5min ${k(t.cacheWrite5m)} / 1h ${k(t.cacheWrite1h)}`);
  lines.push('');
  lines.push('  por modelo');
  for (const [m, a] of Object.entries(r.models).sort((x, y) => y[1].usd - x[1].usd)) {
    lines.push(`    ${m.padEnd(30)} ${String(a.calls).padStart(6)} chamadas  ${usd(a.usd).padStart(12)}  contexto máx ${k(a.maxContext)}`);
  }
  lines.push('');
  lines.push(`  ${top} sessões mais caras`);
  for (const s of r.sessions.slice(0, top)) {
    const a = s.agg;
    const proj = s.cwd ? path.basename(s.cwd) : '?';
    lines.push(`    ${s.sessionId.slice(0, 8)}  ${proj.slice(0, 22).padEnd(22)} ${String(a.calls).padStart(5)} ch  ${usd(a.usd).padStart(12)}  ctx máx ${k(a.maxContext).padStart(5)}  >200k: ${a.usd ? Math.round((a.usdHeavy / a.usd) * 100) : 0}%`);
  }
  lines.push('');
  const fmt = (n) => String(n).replace('.', ',');
  const priceText = ([n, p]) => `${n} ${p.in}/${p.out}${p.cacheRead !== undefined ? ` (cache ${fmt(p.cacheRead)}×)` : ''}${p.long ? ` (acima de ${k(p.long.from)}: ${p.long.in}/${p.long.out})` : ''}`;
  lines.push(`  preços (US$/Mtok, premissa de configuração): ${Object.entries(prices).map(priceText).join(' · ')}; cache lido 0,1× salvo indicação · escrita 1,25× (5min) / 2× (1h)`);
  if (r.unpricedModels.length) {
    lines.push(`  ATENÇÃO: sem preço configurado (custo NÃO contado): ${r.unpricedModels.join(', ')} — adicione em cost.prices no token-guard.config.json`);
  }
  if (r.badLines) lines.push(`  ATENÇÃO: ${r.badLines} linhas de transcript ilegíveis foram ignoradas`);
  lines.push('');
  return lines.join('\n');
}

module.exports = { analyze, summarize, readTranscript, parseSince, repoRoot, isWithin, priceOf, callCost, usageOf, renderText, DEFAULT_PRICES, HEAVY_CONTEXT };
