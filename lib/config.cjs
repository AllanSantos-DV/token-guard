'use strict';
/**
 * config.js — carrega token-guard.config.json subindo a árvore a partir do cwd.
 * Sem arquivo, usa os defaults abaixo. Zero dependências.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  version: 1,

  /** "block" nega e injeta a correção · "warn" só injeta a correção · "off" desliga tudo */
  mode: 'block',

  /** Razão caracteres->tokens. 4 é a média para código/texto latino. */
  charsPerToken: 4,

  /** Janela de contexto de referência, usada nos relatórios. */
  contextWindow: 200000,

  /** Diretórios que nunca deveriam entrar no contexto. */
  noiseDirs: [
    'node_modules', 'target', 'dist', 'build', 'out', '.git', '.svn', '.hg',
    'venv', '.venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache',
    '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache',
    'vendor', 'coverage', '.gradle', '.mvn', '.idea', '.vs', '.vscode-test',
    'bin', 'obj', 'Pods', 'DerivedData', 'bower_components', 'jspm_packages',
    'instantclient', '.terraform', 'site-packages', '.tox', '.nyc_output',
    // dados gerados por ferramentas de IA / índices locais
    '.mcp-memory', '.token-guard', '.playwright-mcp', '.ruff_cache',
    'logs', 'tmp', 'temp', '.tmp',
  ],

  /** Extensões tratadas como código-fonte no relatório de auditoria. */
  sourceExt: [
    '.java', '.kt', '.scala', '.groovy', '.py', '.rb', '.php', '.go', '.rs',
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte',
    '.c', '.h', '.cpp', '.hpp', '.cs', '.swift', '.m', '.mm',
    '.sql', '.xml', '.json', '.yml', '.yaml', '.toml', '.ini', '.properties',
    '.md', '.mdx', '.rst', '.txt', '.sh', '.ps1', '.bat', '.tf', '.gradle',
    '.html', '.css', '.scss', '.less', '.graphql', '.proto',
  ],

  limits: {
    /** Acima disto, ler sem faixa de linhas é bloqueado. */
    readBytesWithoutRange: 51200,
    /** Repos abaixo disto não sofrem guarda de varredura (o custo é irrelevante). */
    minRepoFilesForScanGuard: 400,
    /** Resultado de ferramenta acima disso (chars) é truncado pós-execução. */
    resultCharsWithoutTrim: 25000,
    /** Quantos caracteres sobrevivem no stub (cabeça+cauda). */
    resultTrimKeepChars: 8000,
  },

  rules: {
    broadScan: true,
    blindRead: true,
    noisePath: true,
    shellDump: true,
  },

  /** Caminhos (substring) sempre liberados. */
  allowlist: [],
};

const CONFIG_NAME = 'token-guard.config.json';

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('$')) continue; // $comment: convenção de comentário em JSON
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function dedupe(arr) {
  return [...new Set(arr.filter((x) => typeof x === 'string' && x))];
}

/** Homes onde o instalador (install.cjs) grava config global. O fallback lê
 *  TODOS eles, na ordem — escrever em ~/.claude e nunca ler era config morta. */
const GLOBAL_DIRS = [['.copilot'], ['.claude'], ['.cursor'], ['.token-guard']];

function findConfigFile(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 12; i++) {
    const direct = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(direct)) return direct;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Fallback do escopo GLOBAL: mescla as configs de todos os homes conhecidos,
 * na ordem fixa acima. A config do repositório sempre vence por vir depois.
 * @returns {object|null} config global acumulada ou null se não houver nenhuma
 */
function loadGlobalConfig() {
  let acc = null;
  for (const seg of GLOBAL_DIRS) {
    const file = path.join(os.homedir(), ...seg, CONFIG_NAME);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      acc = acc ? deepMerge(acc, parsed) : parsed;
    } catch { /* um home corrompido não derruba os outros */ }
  }
  return acc;
}

/** Tipos inválidos não podem desligar regras nem matar a config inteira:
 *  cada chave volta ao default individualmente (fail-open por chave). */
function sanitize(c) {
  c.mode = ['block', 'warn', 'off'].includes(c.mode) ? c.mode : 'block';
  c.noiseDirs = Array.isArray(c.noiseDirs) ? dedupe(c.noiseDirs) : [...DEFAULTS.noiseDirs];
  c.sourceExt = Array.isArray(c.sourceExt) ? dedupe(c.sourceExt) : [...DEFAULTS.sourceExt];
  c.allowlist = Array.isArray(c.allowlist) ? c.allowlist.filter((x) => typeof x === 'string') : [];
  c.rules = (c.rules && typeof c.rules === 'object' && !Array.isArray(c.rules))
    ? c.rules : { ...DEFAULTS.rules };
  c.limits = (c.limits && typeof c.limits === 'object' && !Array.isArray(c.limits))
    ? c.limits : {};
  for (const k of Object.keys(DEFAULTS.limits)) {
    if (!Number.isFinite(Number(c.limits[k]))) c.limits[k] = DEFAULTS.limits[k];
    else c.limits[k] = Number(c.limits[k]);
  }
  if (!Number.isFinite(Number(c.charsPerToken)) || Number(c.charsPerToken) <= 0) c.charsPerToken = DEFAULTS.charsPerToken;
  else c.charsPerToken = Number(c.charsPerToken);
  if (!Number.isFinite(Number(c.contextWindow)) || Number(c.contextWindow) <= 0) c.contextWindow = DEFAULTS.contextWindow;
  else c.contextWindow = Number(c.contextWindow);
  return c;
}

/**
 * Memoização curta: no modo plugin in-process, load() dispara a cada evento
 * (pre e post tool use) e o walk até a config custa mais que as regras.
 * Hooks de comando nascem por processo — para eles o cache é sempre frio.
 * TTL curto + env na chave: edição de arquivo e TOKEN_GUARD valem rápido.
 */
const MEMO_TTL_MS = 2000;
const _memo = new Map();

function load(startDir) {
  const key = `${path.resolve(startDir || process.cwd())}|${process.env.TOKEN_GUARD || ''}`;
  const hit = _memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.cfg;
  const cfg = loadUncached(startDir);
  _memo.set(key, { cfg, at: Date.now() });
  return cfg;
}

/** Invalidação manual para testes e chamadores que sabem que algo mudou. */
function clearMemo() {
  _memo.clear();
}

function loadUncached(startDir) {
  // Escape hatch de emergência: TOKEN_GUARD=off desliga sem editar arquivo.
  const env = String(process.env.TOKEN_GUARD || '').toLowerCase();
  if (env === 'off' || env === '0' || env === 'false') {
    return { ...DEFAULTS, mode: 'off', _source: 'env:TOKEN_GUARD=off' };
  }

  const repoFile = findConfigFile(startDir);
  const globals = loadGlobalConfig();
  const globalSources = [];

  if (!repoFile && !globals) {
    const c = sanitize({ ...DEFAULTS });
    if (env === 'warn') c.mode = 'warn';
    c._source = 'defaults';
    return c;
  }

  let merged = { ...DEFAULTS };
  if (globals) {
    merged = deepMerge(merged, globals);
    globalSources.push('globals (~/.copilot|.claude|.cursor|.token-guard)');
  }
  let source = globalSources.join(' + ') || 'defaults';

  if (repoFile) {
    try {
      const user = JSON.parse(fs.readFileSync(repoFile, 'utf8'));
      merged = deepMerge(merged, user);
      source = repoFile;
    } catch {
      source += ' (config do repo invalido, ignorado)';
    }
  }

  const c = sanitize(merged);

  // Semântica aditiva: *Extra acrescenta aos defaults em vez de substituí-los.
  // (arrays em JSON substituem por natureza; este é o caminho para "só somar")
  c.noiseDirs = dedupe([...c.noiseDirs, ...(merged.noiseDirsExtra || [])]);
  c.sourceExt = dedupe([...c.sourceExt, ...(merged.sourceExtExtra || [])]);

  if (env === 'warn') c.mode = 'warn';
  c._source = source;
  return c;
}

/** Cache de estatísticas gravado por token-audit.mjs; usado para relaxar em repos pequenos. */
function repoStats(root) {
  try {
    const p = path.join(root, '.token-guard', 'repo-stats.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

module.exports = { load, loadUncached, clearMemo, repoStats, DEFAULTS, GLOBAL_DIRS, CONFIG_NAME };
