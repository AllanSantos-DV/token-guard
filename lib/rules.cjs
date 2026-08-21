'use strict';
/**
 * rules.js — regras de economia de contexto.
 *
 * Contrato de cada regra:
 *   (ctx) => null            → libera
 *   (ctx) => { id, reason }  → barra e INJETA a correção (nunca um deny cego)
 *
 * ctx = { name, input, root, cfg, stats }
 *
 * Princípio: só barramos o que custa TOKEN de verdade (payload que entra na janela),
 * não o que custa apenas CPU. Um grep repo-wide que devolve 3 linhas é barato;
 * um glob "**​/*" que devolve 200 mil caminhos é o problema real.
 */

const fs = require('fs');
const path = require('path');

/* ---------- famílias de ferramenta (agnóstico ao harness) ---------- */
const FAM = {
  read:  /^(view|read|read_file|readfile|cat_file|open_file|get_file_contents|str_replace_editor)$/,
  grep:  /(^|_)(grep|ripgrep|search_text|text_search|grep_search|search_in_files)($|_)/,
  glob:  /(^|_)(glob|file_search|find_files|list_dir|list_files|list_directory|listdirectory)($|_)/,
  shell: /(^|_)(bash|sh|shell|zsh|powershell|pwsh|run_in_terminal|run_command|execute_command|terminal|run_shell)($|_)/,
};

function family(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  for (const [fam, re] of Object.entries(FAM)) if (re.test(n)) return fam;
  return null;
}

/* ---------- utilidades ---------- */

function fmt(n) {
  return Number(n).toLocaleString('pt-BR');
}

function normalize(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** true se o caminho passa por algum diretório de ruído. */
function hitsNoise(p, noiseDirs) {
  const segs = normalize(p).split('/').filter(Boolean);
  return noiseDirs.find((d) => segs.includes(d)) || null;
}

function isAllowlisted(p, allowlist) {
  if (!allowlist || !allowlist.length) return false;
  const n = normalize(p).toLowerCase();
  return allowlist.some((a) => n.includes(normalize(a).toLowerCase()));
}

/** O padrão restringe por extensão? Cobre "*.java" e "*.{ts,tsx}". */
function hasExtensionFilter(pattern) {
  return /\.[a-z0-9]{1,10}(\}|,|$)/i.test(String(pattern || ''));
}

/** O padrão está ancorado num diretório concreto (não começa por * ou **)? */
function isAnchored(pattern) {
  const p = normalize(pattern).replace(/^\.\//, '');
  return Boolean(p) && !/^[*{]/.test(p);
}

/** Há um escopo de diretório real (não a raiz)? */
function hasRealPathScope(paths) {
  return paths.some((p) => {
    const n = normalize(p).replace(/^\.\/?/, '').replace(/\/+$/, '');
    return n && n !== '.' && n !== '/' && !/^[a-z]:$/i.test(n);
  });
}

function bytesHuman(b) {
  if (b >= 1048576) return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  if (b >= 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}

/* ================================================================
   REGRA 1 — noisePath
   Ler dentro de node_modules / target / dist / .git é 100% desperdício.
   ================================================================ */
function ruleNoisePath(ctx) {
  const { input, cfg, P } = ctx;
  const targets = [P.inputPath(input), ...P.inputPaths(input)].filter(Boolean);
  for (const t of targets) {
    if (isAllowlisted(t, cfg.allowlist)) continue;
    const dir = hitsNoise(t, cfg.noiseDirs);
    if (!dir) continue;
    return {
      id: 'noisePath',
      reason:
        `token-guard/noisePath: the path crosses "${dir}", a build/dependency directory. ` +
        `Its contents are generated or vendored and never belong in context.\n` +
        `DO THIS INSTEAD: (1) read the source that produces it, not the artifact; ` +
        `(2) if you need the dependency's API, read its type/interface declaration only, with a line range; ` +
        `(3) if this file is genuinely required, add its path to "allowlist" in token-guard.config.json.\n` +
        `(PT-BR) O caminho passa por "${dir}" (build/dependência). ` +
        `Leia a fonte que gera o artefato, não o artefato. ` +
        `Se precisa mesmo deste arquivo, inclua o caminho em "allowlist" no token-guard.config.json.`,
    };
  }
  return null;
}

/* ================================================================
   REGRA 2 — blindRead
   Ler um arquivo grande inteiro para usar 20 linhas.
   ================================================================ */
function ruleBlindRead(ctx) {
  const { name, input, cfg, P } = ctx;
  if (family(name) !== 'read') return null;
  if (P.hasReadRange(input)) return null;

  const target = P.inputPath(input);
  if (!target || isAllowlisted(target, cfg.allowlist)) return null;

  let st;
  try { st = fs.statSync(target); } catch { return null; }
  if (!st.isFile()) return null;

  const limit = cfg.limits.readBytesWithoutRange;
  if (st.size <= limit) return null;

  const tokens = Math.round(st.size / cfg.charsPerToken);
  const pctWindow = ((tokens / cfg.contextWindow) * 100).toFixed(1).replace('.', ',');
  const base = path.basename(target);

  return {
    id: 'blindRead',
    reason:
      `token-guard/blindRead: "${base}" is ${bytesHuman(st.size)} (~${fmt(tokens)} tokens, ` +
      `${pctWindow}% of a ${fmt(cfg.contextWindow)}-token window) and you requested it with no line range.\n` +
      `DO THIS INSTEAD: (1) locate the region first with a scoped search (grep restricted to this file), ` +
      `then (2) re-read using a line range around the hit — most tasks need 40-80 lines, not the whole file. ` +
      `If you truly need a full pass over a file this size, delegate it to a sub-agent so the bulk never ` +
      `enters this window; import only its conclusion.\n` +
      `(PT-BR) "${base}" tem ${bytesHuman(st.size)} (~${fmt(tokens)} tokens, ${pctWindow}% da janela) ` +
      `e foi pedido sem faixa de linhas. Localize o trecho com uma busca restrita a este arquivo e releia ` +
      `só a faixa relevante. Se precisa varrer tudo, delegue a um sub-agente e traga só a conclusão.`,
  };
}

/* ================================================================
   REGRA 3 — broadScan
   Duas formas distintas de estourar contexto:
     glob  → devolve a LISTA de caminhos (o problema dos 26 M caracteres)
     grep  → devolve CONTEÚDO sem teto
   ================================================================ */
function ruleBroadScan(ctx) {
  const { name, input, cfg, stats, P } = ctx;
  const fam = family(name);
  if (fam !== 'glob' && fam !== 'grep') return null;

  // Repositório pequeno: o custo é irrelevante, não atrapalhe.
  const repoFiles = stats && Number.isFinite(stats.totalFiles) ? stats.totalFiles : null;
  if (repoFiles !== null && repoFiles < cfg.limits.minRepoFilesForScanGuard) return null;

  const pattern = P.inputPattern(input);
  const paths = P.inputPaths(input);
  const scoped = hasRealPathScope(paths);

  /* --- glob: lista de caminhos sem teto --- */
  if (fam === 'glob') {
    if (scoped || isAnchored(pattern) || hasExtensionFilter(pattern)) return null;
    const scale = repoFiles ? `about ${fmt(repoFiles)} files` : 'every file in the repository';
    return {
      id: 'broadScan',
      reason:
        `token-guard/broadScan: the pattern "${pattern || '(empty)'}" is unbounded in both breadth and type, ` +
        `so it returns the path of ${scale}. A bare file listing is pure overhead: it answers ` +
        `"what exists", never "where is the thing I need".\n` +
        `DO THIS INSTEAD: bound it on at least one axis — ` +
        `(a) by type: "**/*.java", "**/*.{ts,tsx}"; ` +
        `(b) by directory: pass paths=["src/main/java"]; ` +
        `(c) by name: "**/*Service*.java". ` +
        `To find code by meaning rather than by filename, search content instead of listing paths.\n` +
        `(PT-BR) O padrão "${pattern || '(vazio)'}" não limita nem escopo nem tipo: devolve o caminho de ` +
        `${repoFiles ? fmt(repoFiles) + ' arquivos' : 'todo o repositório'}. ` +
        `Limite por extensão ("**/*.java"), por diretório (paths=["src/..."]) ou por nome ("**/*Service*").`,
    };
  }

  /* --- grep: conteúdo sem teto --- */
  const mode = String(input.output_mode || input.outputMode || '').toLowerCase();
  const wantsContent = mode === 'content' || Boolean(input.includeContent);
  if (!wantsContent) return null; // files_with_matches / count são baratos: libera

  const capped = [input.head_limit, input.headLimit, input.maxResults, input.limit, input.max_results]
    .some((n) => typeof n === 'number' && n > 0);
  if (capped) return null;

  const scopeFilter = P.inputScopeFilter(input);
  if (scopeFilter || scoped) return null;

  return {
    id: 'broadScan',
    reason:
      `token-guard/broadScan: content-mode search across the whole repository with no result cap ` +
      `and no file filter. The scan itself is cheap; the OUTPUT is what enters the context window, ` +
      `and here it is unbounded.\n` +
      `DO THIS INSTEAD: (1) run the same query with output_mode="files_with_matches" first to see where ` +
      `it lives — that answer is a handful of lines; then (2) re-run in content mode narrowed to those files. ` +
      `Or cap it now with head_limit and a file filter (glob/type).\n` +
      `(PT-BR) Busca por conteúdo em todo o repositório, sem teto de resultado e sem filtro de arquivo. ` +
      `O custo não é a varredura, é a SAÍDA que entra na janela. ` +
      `Rode antes com output_mode="files_with_matches" para descobrir onde está, depois volte em modo ` +
      `conteúdo só nesses arquivos — ou aplique head_limit + filtro (glob/type) agora.`,
  };
}

/* ================================================================
   REGRA 4 — shellDump
   O shell é a porta dos fundos: um comando devolve a árvore inteira.
   ================================================================ */
const DUMP_PATTERNS = [
  { re: /get-childitem[^|;]*-recurse/i,               what: 'Get-ChildItem -Recurse' },
  { re: /\bgci\b[^|;]*-recurse/i,                     what: 'gci -Recurse' },
  { re: /\bls\s+(-[a-z]*r[a-z]*)\b/i,                 what: 'ls -R' },
  { re: /\bdir\s+\/s\b/i,                             what: 'dir /s' },
  { re: /\bfind\s+[.\/][^|;]*(?<!-name)(?<!-path)$/i, what: 'find .' },
  { re: /\btree\b(?![^|;]*(-l|\/l|--level|-L))/i,     what: 'tree' },
  { re: /\bgrep\s+-[a-z]*r/i,                         what: 'grep -r' },
  { re: /\bfindstr\s+\/s/i,                           what: 'findstr /s' },
  { re: /\bgit\s+ls-files\b(?![^|;]*\|)/i,            what: 'git ls-files' },
];

const CAP_HINTS = /(\|\s*(select-object|head|tail|measure-object|select|sort-object)|-first\s+\d|-totalcount\s+\d|\bhead\s+-n|\|\s*wc\b|-name\s|-path\s|--include|-include)/i;

function ruleShellDump(ctx) {
  const { name, input, cfg, stats, P } = ctx;
  if (family(name) !== 'shell') return null;

  const cmd = P.inputCommand(input);
  if (!cmd) return null;

  const repoFiles = stats && Number.isFinite(stats.totalFiles) ? stats.totalFiles : null;
  if (repoFiles !== null && repoFiles < cfg.limits.minRepoFilesForScanGuard) return null;

  const hit = DUMP_PATTERNS.find((p) => p.re.test(cmd));
  if (!hit) return null;

  // Já limitado (| Select -First, head, -Name, --include...): libera.
  if (CAP_HINTS.test(cmd)) return null;

  const scale = repoFiles
    ? `This repository has ${fmt(repoFiles)} files; the raw listing alone is roughly ` +
      `${fmt(Math.round((stats.pathChars || 0) / cfg.charsPerToken))} tokens.`
    : 'On a large repository this alone can exceed the entire context window.';

  return {
    id: 'shellDump',
    reason:
      `token-guard/shellDump: "${hit.what}" walks the tree with no filter and no cap, and every line ` +
      `it prints is billed as context. ${scale}\n` +
      `DO THIS INSTEAD: (1) use the harness search tool instead of the shell — it respects ignore rules ` +
      `and returns structured, bounded results; (2) if the shell is genuinely required, cap and filter it: ` +
      `add a name/extension filter and pipe through a limit ` +
      `(PowerShell: \`| Select-Object -First 50\`; POSIX: \`| head -50\`); ` +
      `(3) for a whole-tree survey, run the audit — \`node .github/token-guard/token-audit.cjs\` — ` +
      `which reports aggregates instead of dumping paths.\n` +
      `(PT-BR) "${hit.what}" percorre a árvore sem filtro e sem teto, e cada linha impressa vira contexto. ` +
      `Prefira a ferramenta de busca do harness; se precisar do shell, filtre por nome/extensão e limite ` +
      `a saída (\`| Select-Object -First 50\` ou \`| head -50\`). ` +
      `Para um panorama do repositório inteiro, rode \`node .github/token-guard/token-audit.cjs\`.`,
  };
}

/* ---------- registro ---------- */
const REGISTRY = [
  { key: 'noisePath', fn: ruleNoisePath },
  { key: 'blindRead', fn: ruleBlindRead },
  { key: 'broadScan', fn: ruleBroadScan },
  { key: 'shellDump', fn: ruleShellDump },
];

/** Roda as regras habilitadas. Devolve o primeiro achado ou null. */
function evaluate(ctx) {
  for (const { key, fn } of REGISTRY) {
    if (ctx.cfg.rules && ctx.cfg.rules[key] === false) continue;
    let hit = null;
    try { hit = fn(ctx); } catch { hit = null; } // uma regra quebrada nunca trava a sessão
    if (hit) return hit;
  }
  return null;
}

module.exports = { evaluate, family, REGISTRY, hitsNoise, hasExtensionFilter, isAnchored };
