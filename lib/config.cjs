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

function findConfigFile(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  for (let i = 0; i < 12; i++) {
    const direct = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(direct)) return direct;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback do escopo GLOBAL: uma config em ~/.copilot vale para todos os repos
  // desta máquina. A config do repositório sempre vence, por estar acima na busca.
  try {
    const global = path.join(os.homedir(), '.copilot', CONFIG_NAME);
    if (fs.existsSync(global)) return global;
  } catch { /* homedir indisponível: segue com os defaults */ }
  return null;
}

function load(startDir) {
  // Escape hatch de emergência: TOKEN_GUARD=off desliga sem editar arquivo.
  const env = String(process.env.TOKEN_GUARD || '').toLowerCase();
  if (env === 'off' || env === '0' || env === 'false') {
    return { ...DEFAULTS, mode: 'off', _source: 'env:TOKEN_GUARD=off' };
  }

  const file = findConfigFile(startDir);
  if (!file) {
    const c = { ...DEFAULTS, _source: 'defaults' };
    if (env === 'warn') c.mode = 'warn';
    return c;
  }
  try {
    const user = JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = deepMerge(DEFAULTS, user);

    // Semântica aditiva: *Extra acrescenta aos defaults em vez de substituí-los.
    // (arrays em JSON substituem por natureza; este é o caminho para "só somar")
    merged.noiseDirs = dedupe([...(merged.noiseDirs || []), ...(user.noiseDirsExtra || [])]);
    merged.sourceExt = dedupe([...(merged.sourceExt || []), ...(user.sourceExtExtra || [])]);

    merged._source = file;
    if (env === 'warn') merged.mode = 'warn';
    return merged;
  } catch {
    return { ...DEFAULTS, _source: 'defaults (config invalido, ignorado)' };
  }
}

/** Cache de estatísticas gravado por token-audit.mjs; usado para relaxar em repos pequenos. */
function repoStats(root) {
  try {
    const p = path.join(root, '.token-guard', 'repo-stats.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

module.exports = { load, repoStats, DEFAULTS, CONFIG_NAME };
