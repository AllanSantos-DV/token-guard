'use strict';
/**
 * events.cjs — o que o guard barrou e poupou, para a tela de setup mostrar.
 *
 * O daemon registra um evento por bloqueio (deny) e por poupança medida (bigResult, dupRead) ou
 * sugestão (scout) em ~/.token-guard/events.jsonl, uma linha por evento, e avisa quem escuta
 * (`bus`) na hora: a tela e o ícone da bandeja são empurrados, não consultam em laço.
 *
 * Tokens só aparecem onde são MEDIDOS: o corte do bigResult e o stub do dupRead sabem quantos
 * caracteres deixaram de entrar. Um deny não mede o que evitou (a chamada não rodou), então fica
 * com `tokens: null` e entra só na contagem. Nada aqui inventa economia.
 *
 * Fail-open: gravar evento nunca derruba nem atrasa a decisão (todo erro é engolido).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(50);

/** Passou disto, o arquivo é aparado para as últimas KEEP_LINES linhas, sem passar de metade do teto (folga: não aparar de novo já no registro seguinte). */
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_LINES = 8000;
const DETAIL_MAX = 120;
const RECENT = 30;

const KINDS = ['deny', 'trim', 'dup', 'scout'];

/** A cada tantos registros o processo confere o teto do arquivo (o daemon não reinicia para aparar). */
const TRIM_EVERY = 200;
let sinceTrim = 0;

function eventsPath() {
  return path.join(os.homedir(), '.token-guard', 'events.jsonl');
}

function clean(e) {
  const kind = KINDS.includes(e && e.kind) ? e.kind : 'deny';
  const tokens = Number.isFinite(e && e.tokens) && e.tokens > 0 ? Math.round(e.tokens) : (kind === 'deny' || kind === 'scout' ? null : 0);
  return {
    t: Date.now(),
    kind,
    rule: String((e && e.rule) || ''),
    target: String((e && e.target) || ''),
    tool: String((e && e.tool) || '').slice(0, 60),
    detail: String((e && e.detail) || '').replace(/\s+/g, ' ').slice(0, DETAIL_MAX),
    tokens,
  };
}

/** @returns {object|null} o evento gravado (e emitido), ou null se não deu para gravar */
function record(e) {
  try {
    const evt = clean(e);
    const file = eventsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(evt) + '\n', 'utf8');
    bus.emit('event', evt);
    if (++sinceTrim >= TRIM_EVERY) { sinceTrim = 0; trim(); }
    return evt;
  } catch { return null; }
}

/** Um bloqueio vira evento (cada chamada barrada conta, também a que veio do cache do daemon). */
function recordDeny(verdict, target, payload) {
  if (!verdict) return null;
  const P = require('./payload.cjs');
  const input = P.toolInput(payload || {});
  return record({
    kind: 'deny', rule: verdict.rule, target, tool: P.toolName(payload || {}),
    detail: P.inputCommand(input) || P.inputPath(input) || P.inputPattern(input),
  });
}

/** Releitura só quando o arquivo mudou (tamanho ou mtime): a tela empurra a cada evento. */
let cache = { key: '', events: [] };

/** Eventos gravados, do mais antigo ao mais novo. Linha ilegível é pulada. */
function readAll() {
  let raw;
  let key;
  try {
    const st = fs.statSync(eventsPath());
    key = `${eventsPath()}|${st.size}|${st.mtimeMs}`;
    if (cache.key === key) return cache.events;
    raw = fs.readFileSync(eventsPath(), 'utf8');
  } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.t === 'number' && KINDS.includes(e.kind)) out.push(e);
    } catch { /* linha truncada por crash: ignora */ }
  }
  cache = { key, events: out };
  return out;
}

/** Apara o arquivo que passou do teto, mantendo o fim. Chamado na subida do daemon. */
function trim() {
  try {
    const file = eventsPath();
    if (fs.statSync(file).size <= MAX_BYTES) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const keep = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0 && keep.length < KEEP_LINES && bytes + lines[i].length + 1 <= MAX_BYTES / 2; i--) {
      keep.unshift(lines[i]);
      bytes += lines[i].length + 1;
    }
    const tmp = `${file}.tg-tmp-${process.pid}`;
    fs.writeFileSync(tmp, keep.join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function startOfToday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function empty() {
  return { blocks: 0, trims: 0, dups: 0, scouts: 0, tokensSaved: 0 };
}

function add(acc, e) {
  if (e.kind === 'deny') acc.blocks += 1;
  else if (e.kind === 'trim') acc.trims += 1;
  else if (e.kind === 'dup') acc.dups += 1;
  else acc.scouts += 1;
  acc.tokensSaved += Number(e.tokens) > 0 ? Number(e.tokens) : 0;
}

/**
 * Totais para a tela.
 * @returns {{since:number|null, total:object, today:object, byRule:object, byTarget:object, recent:object[]}}
 */
function summary(now = Date.now()) {
  const all = readAll();
  const midnight = startOfToday(now);
  const total = empty();
  const today = empty();
  const byRule = {};
  const byTarget = {};
  for (const e of all) {
    add(total, e);
    if (e.t >= midnight) add(today, e);
    const r = byRule[e.rule] || (byRule[e.rule] = { count: 0, tokens: 0 });
    r.count += 1;
    r.tokens += Number(e.tokens) > 0 ? Number(e.tokens) : 0;
    byTarget[e.target || '?'] = (byTarget[e.target || '?'] || 0) + 1;
  }
  return { since: all.length ? all[0].t : null, total, today, byRule, byTarget, recent: all.slice(-RECENT).reverse() };
}

module.exports = { record, recordDeny, readAll, trim, summary, eventsPath, bus, KINDS, MAX_BYTES, KEEP_LINES };
