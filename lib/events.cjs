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
const ROOT_MAX = 400;
const RECENT = 30;

const KINDS = ['deny', 'trim', 'dup', 'scout'];

/** Repositórios mostrados na tela; a lista inteira sai de `byRepo`. */
const TOP_REPOS = 10;

/** A cada tantos registros o processo confere o teto do arquivo (o daemon não reinicia para aparar). */
const TRIM_EVERY = 200;
let sinceTrim = 0;

function eventsPath() {
  return path.join(os.homedir(), '.token-guard', 'events.jsonl');
}

const rootCache = new Map();

/** Raiz do repositório que contém `cwd` (a mesma regra do relatório de custo); '' sem cwd. */
function repoOf(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  let r = rootCache.get(cwd);
  if (r === undefined) {
    if (rootCache.size > 500) rootCache.clear();
    r = require('./cost.cjs').repoRoot(cwd);
    rootCache.set(cwd, r);
  }
  return r;
}

const repoKey = (root) => (process.platform === 'win32' ? root.toLowerCase() : root);

function clean(e) {
  const kind = KINDS.includes(e && e.kind) ? e.kind : 'deny';
  const tokens = Number.isFinite(e && e.tokens) && e.tokens > 0 ? Math.round(e.tokens) : (kind === 'deny' || kind === 'scout' ? null : 0);
  const evt = {
    t: Date.now(),
    kind,
    rule: String((e && e.rule) || ''),
    target: String((e && e.target) || ''),
    tool: String((e && e.tool) || '').slice(0, 60),
    detail: String((e && e.detail) || '').replace(/\s+/g, ' ').slice(0, DETAIL_MAX),
    tokens,
  };
  const root = repoOf(e && e.root);
  if (root) evt.root = root.slice(0, ROOT_MAX);
  return evt;
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

/**
 * Um bloqueio vira evento (cada chamada barrada conta, também a que veio do cache do daemon).
 * `root`: pasta da sessão; sem ela, vale o cwd que o próprio payload traz (nunca o do processo, que seria o do daemon).
 */
function recordDeny(verdict, target, payload, root) {
  if (!verdict) return null;
  const P = require('./payload.cjs');
  const p = payload || {};
  const input = P.toolInput(p);
  return record({
    root: root || p.cwd || p.workingDirectory || p.workspaceRoot || p.workspace_root,
    kind: 'deny', rule: verdict.rule, target, tool: P.toolName(p),
    detail: P.inputCommand(input) || P.inputPath(input) || P.inputPattern(input),
  });
}

/**
 * Poupança medida (trim, dup) ou sugestão (scout) de um resultado de ferramenta, no mesmo formato em qualquer caminho
 * (daemon, hook sem daemon, plugin do Copilot). `chars` são os caracteres que deixaram de entrar; 0 não conta tokens.
 */
function recordSaving({ root, target, name, input, charsPerToken }, kind, rule, chars) {
  const P = require('./payload.cjs');
  const i = input || {};
  return record({
    root, kind, rule, target, tool: name, detail: P.inputPath(i) || P.inputCommand(i) || P.inputPattern(i),
    tokens: chars > 0 ? chars / charsPerToken : 0,
  });
}

/** O corte do bigResult como evento: só conta como poupado o que o harness aplica de fato (`replaced`); o resto só ganhou uma cópia em disco. */
function recordTrim(ctx, trimmed) {
  const m = trimmed.modifiedResult;
  const kept = typeof m === 'string' ? m.length : JSON.stringify(m || '').length;
  return recordSaving(ctx, 'trim', 'bigResult', trimmed.replaced ? trimmed.originalChars - kept : 0);
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
  // O trim devolve as linhas mantidas depois das que chegaram durante a poda: a ordem por tempo vale aqui.
  out.sort((a, b) => a.t - b.t);
  cache = { key, events: out };
  return out;
}

/**
 * Apara o arquivo que passou do teto, mantendo o fim. Chamado na subida do daemon e a cada TRIM_EVERY registros.
 * O arquivo sai do caminho por rename ANTES de ser lido: o registro que chegar durante a poda cria o arquivo
 * novo (appendFileSync) em vez de cair num arquivo que está sendo substituído, então nenhuma linha se perde.
 * As linhas mantidas voltam por append depois das novas; readAll ordena por tempo.
 */
function trim() {
  const file = eventsPath();
  const work = `${file}.tg-trim-${process.pid}`;
  try {
    if (fs.statSync(file).size <= MAX_BYTES) return false;
    fs.renameSync(file, work);
  } catch { return false; }
  try {
    const lines = fs.readFileSync(work, 'utf8').split('\n').filter(Boolean);
    const keep = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0 && keep.length < KEEP_LINES && bytes + lines[i].length + 1 <= MAX_BYTES / 2; i--) {
      keep.unshift(lines[i]);
      bytes += lines[i].length + 1;
    }
    fs.appendFileSync(file, keep.join('\n') + '\n', 'utf8');
    fs.rmSync(work, { force: true });
    return true;
  } catch { return false; /* o original segue em `work`: nada é apagado antes de as linhas voltarem */ }
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
  const { repos, noRepo } = byRepo(all);
  return {
    since: all.length ? all[0].t : null, total, today, byRule, byTarget, recent: all.slice(-RECENT).reverse(),
    repos: repos.slice(0, TOP_REPOS), reposTotal: repos.length, noRepo,
  };
}

/**
 * Poupança por repositório. Só entram os eventos gravados com `root` (a partir desta versão): o histórico anterior
 * não é redistribuído e soma em `noRepo`.
 * @returns {{repos:{root:string, name:string, blocks:number, trims:number, dups:number, scouts:number, tokensSaved:number}[], noRepo:object}}
 *          repos do que mais poupou ao que menos poupou
 */
function byRepo(events) {
  const map = new Map();
  const noRepo = empty();
  for (const e of events || readAll()) {
    if (!e.root) { add(noRepo, e); continue; }
    const key = repoKey(e.root);
    let r = map.get(key);
    if (!r) map.set(key, r = { root: e.root, name: path.basename(e.root) || e.root, ...empty() });
    add(r, e);
  }
  const repos = [...map.values()].sort((a, b) => b.tokensSaved - a.tokensSaved || b.blocks - a.blocks);
  return { repos, noRepo };
}

/** O que o guard poupou no repositório que contém `cwd`, hoje e no total, só de eventos com repositório gravado. */
function forRepo(cwd, now = Date.now()) {
  const root = repoOf(cwd);
  const key = repoKey(root);
  const midnight = startOfToday(now);
  const total = empty();
  const today = empty();
  for (const e of readAll()) {
    if (!e.root || repoKey(e.root) !== key) continue;
    add(total, e);
    if (e.t >= midnight) add(today, e);
  }
  return { root, name: path.basename(root) || root, total, today };
}

/** Contagens e tokens poupados a partir de `since` (epoch ms): a mesma janela do relatório de custo. */
function savedSince(since) {
  const acc = empty();
  for (const e of readAll()) if (e.t >= since) add(acc, e);
  return acc;
}

module.exports = { byRepo, forRepo, repoOf, TOP_REPOS, savedSince, record, recordDeny, recordSaving, recordTrim, readAll, trim, summary, eventsPath, bus, KINDS, MAX_BYTES, KEEP_LINES };
