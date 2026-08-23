'use strict';
/**
 * contract.cjs — carrega o contrato de saída e decide o que injetar em cada turno.
 *
 * O contrato é dividido em seções por gatilho: `sempre` vale para toda tarefa,
 * `quando: X` entra quando a sessão prova ser do tipo X, `subagente` nunca entra
 * na sessão principal.
 *
 * Duas invariantes vêm do mecanismo de injeção, não de gosto:
 *
 *  - Cada seção é injetada NO MÁXIMO UMA VEZ por sessão. O texto injetado fica no
 *    transcript e é reproduzido no --continue sem o hook rodar de novo; reinjetar
 *    seria pagar o mesmo texto a cada turno.
 *  - O gatilho é evidência acumulada, nunca classificação da frase do usuário.
 *    Evidência só cresce, então nenhuma seção precisa ser retirada depois.
 *
 * Sem dependências. Só Node stdlib.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTRACT_NAME = 'contract.md';
const DEFAULT_FILE = path.join(__dirname, '..', 'contract.default.md');

/** Seção que descreve o contrato de quem roda em contexto descartável. */
const SUBAGENT = 'subagente';

/** Extensões tratadas como fonte quando o chamador não informa a lista. */
const SOURCE_EXT = [
  '.java', '.kt', '.scala', '.groovy', '.py', '.rb', '.php', '.go', '.rs',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.m', '.mm', '.sql', '.sh', '.ps1',
];

const DOC_EXT = ['.md', '.mdx', '.rst', '.adoc'];

/** Caminho de teste: pasta dedicada ou sufixo .test/.spec antes da extensão. */
const TEST_PATH = /(^|[\\/])(tests?|spec|__tests__)[\\/]|[.\-_](test|spec)\.[a-z0-9]+$|(^|[\\/])(selftest|conftest)\.[a-z0-9]+$/i;

/* ---------------- leitura ---------------- */

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * Extrai as regras de uma seção. Item começa em "- " e continua nas linhas
 * indentadas seguintes; linha em branco encerra o item.
 */
function extractRules(lines) {
  const rules = [];
  let current = null;

  for (const raw of lines) {
    const line = String(raw).replace(/\s+$/, '');
    if (/^\s*-\s+/.test(line)) {
      if (current) rules.push(current);
      current = line.replace(/^\s*-\s+/, '');
      continue;
    }
    if (current && /^\s+\S/.test(line)) {
      current += ' ' + line.trim();
      continue;
    }
    if (current && !line.trim()) {
      rules.push(current);
      current = null;
    }
  }
  if (current) rules.push(current);

  return rules.map((r) => r.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/**
 * @returns {{rules:Object<string,string[]>, order:string[]}}
 */
function parse(md) {
  const rules = {};
  const order = [];

  for (const block of String(md || '').split(/^##\s+/m).slice(1)) {
    const lines = block.split('\n');
    const head = lines[0].trim().toLowerCase();

    let trigger = null;
    if (head === 'sempre' || head === SUBAGENT) trigger = head;
    else if (head.startsWith('quando:')) trigger = head.slice('quando:'.length).trim();
    if (!trigger) continue;

    const found = extractRules(lines.slice(1));
    if (!found.length) continue;

    if (!(trigger in rules)) order.push(trigger);
    rules[trigger] = found;
  }

  return { rules, order };
}

function findContractFile(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 30; i += 1) {
    const candidate = path.join(dir, CONTRACT_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * O contrato do projeto substitui seção por seção; seção que ele não menciona
 * continua valendo pelo padrão.
 */
function load(startDir) {
  const env = String(process.env.TOKEN_GUARD || '').toLowerCase();
  if (env === 'off' || env === '0' || env === 'false') {
    return { rules: {}, order: [], _source: 'env:TOKEN_GUARD=off' };
  }

  const base = parse(readSafe(DEFAULT_FILE));
  const file = findContractFile(startDir);
  if (!file) return { ...base, _source: DEFAULT_FILE };

  const user = parse(readSafe(file));
  if (!user.order.length) return { ...base, _source: `${DEFAULT_FILE} (contract.md sem seções)` };

  return {
    rules: { ...base.rules, ...user.rules },
    order: [...base.order, ...user.order.filter((t) => !base.order.includes(t))],
    _source: file,
  };
}

/* ---------------- evidência ---------------- */

/**
 * Traduz arquivos tocados na sessão em gatilhos. Um arquivo de teste também é
 * fonte: as duas seções valem.
 */
function triggersFor(touched, { sourceExt = SOURCE_EXT, docExt = DOC_EXT } = {}) {
  const found = new Set();

  for (const raw of touched || []) {
    const p = String(raw || '');
    if (!p) continue;
    const ext = path.extname(p).toLowerCase();

    if (TEST_PATH.test(p)) found.add('teste');
    if (sourceExt.includes(ext)) found.add('codigo');
    if (docExt.includes(ext)) found.add('docs');
  }

  return [...found];
}

/* ---------------- estado por sessão ---------------- */

const STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function stateFile(root, sessionId) {
  const raw = String(sessionId || 'sem-sessao');
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  // Sanitização pode colidir ("sess/1" e "sess:1" viram ambos "sess_1"):
  // um sufixo de hash do id ORIGINAL desambigua sem abrir mão da segurança.
  const name = safe === raw ? safe
    : `${safe}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
  return path.join(root, '.token-guard', 'sessions', `${name}.json`);
}

function readState(root, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(root, sessionId), 'utf8'));
    return Array.isArray(parsed.injected) ? parsed : { injected: [] };
  } catch { return { injected: [] }; }
}

function writeState(root, sessionId, state) {
  const file = stateFile(root, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ injected: (state && state.injected) || [] }), 'utf8');
    pruneState(path.dirname(file));
    return true;
  } catch { return false; }
}

/** Estado de sessão é cache: sessão encerrada há mais de uma semana não volta. */
function pruneState(dir, now = Date.now()) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > STATE_TTL_MS) fs.unlinkSync(p);
      } catch { /* arquivo sumiu no caminho: nada a fazer */ }
    }
  } catch { /* diretório ausente: nada a podar */ }
}

/* ---------------- evidência acumulada (arquivos tocados) ---------------- */

const TOUCHED_CAP = 50;

/** Mesma higienização do stateFile, com sufixo -touched. */
function touchFile(root, sessionId) {
  const raw = String(sessionId || 'sem-sessao');
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const name = safe === raw ? safe
    : `${safe}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
  return path.join(root, '.token-guard', 'sessions', `${name}-touched.json`);
}

/**
 * Registra caminhos tocados na sessão (evidência dos gatilhos quando:há).
 * Deduplica, limita a TOUCHED_CAP e falha aberta (retorna false).
 */
function recordTouched(root, sessionId, paths) {
  try {
    const file = touchFile(root, sessionId);
    let current = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed.touched)) current = parsed.touched;
    } catch { /* primeira escrita ou arquivo corrompido: começa vazio */ }

    const seen = new Set(current);
    for (const p of paths || []) {
      if (!p) continue;
      if (seen.has(p)) continue;
      current.push(p);
      seen.add(p);
    }
    while (current.length > TOUCHED_CAP) current.shift();

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ touched: current }), 'utf8');
    return true;
  } catch {
    return false; // evidência é otimização: falha não pode custar nada
  }
}

function readTouched(root, sessionId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(touchFile(root, sessionId), 'utf8'));
    return Array.isArray(parsed.touched) ? parsed.touched : [];
  } catch {
    return [];
  }
}

/* ---------------- decisão ---------------- */

function render(contract, triggers) {
  const picked = contract.order.filter((t) => triggers.includes(t));
  if (!picked.length) return '';

  const out = ['Convenções de saída em vigor neste repositório:'];
  for (const trigger of picked) {
    for (const rule of contract.rules[trigger] || []) out.push(`- ${rule}`);
  }
  return out.join('\n');
}

/**
 * Decide o que injetar agora.
 * @param {{contract:object, touched?:string[], injected?:string[], sourceExt?:string[]}} input
 * @returns {{triggers:string[], text:string}}
 */
function decide({ contract, touched = [], injected = [], sourceExt, docExt } = {}) {
  if (!contract || !contract.order || !contract.order.length) return { triggers: [], text: '' };

  const wanted = new Set(['sempre', ...triggersFor(touched, { sourceExt, docExt })]);
  const triggers = contract.order.filter(
    (t) => t !== SUBAGENT && wanted.has(t) && !injected.includes(t),
  );

  return { triggers, text: render(contract, triggers) };
}

/** Contrato de quem roda em contexto descartável, para o prompt do subagente. */
function subagentText(contract) {
  return render(contract, [SUBAGENT]);
}

module.exports = {
  load, parse, decide, render, triggersFor, subagentText,
  readState, writeState, pruneState, recordTouched, readTouched,
  CONTRACT_NAME, SUBAGENT, SOURCE_EXT, DOC_EXT, TOUCHED_CAP,
};
