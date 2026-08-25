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

/** Windows e macOS não distinguem caixa em caminhos: ali "Node_Modules" É
 *  node_modules. Em Linux são diretórios distintos de verdade. */
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';

function fmt(n) {
  return Number(n).toLocaleString('pt-BR');
}

function normalize(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** true se o caminho passa por algum diretório de ruído. */
function hitsNoise(p, noiseDirs) {
  const segs = normalize(p).split('/').filter(Boolean);
  const cmp = segs.map((s) => (FOLD_CASE ? s.toLowerCase() : s));
  return noiseDirs.find((d) => {
    const dd = FOLD_CASE ? String(d).toLowerCase() : String(d);
    return cmp.includes(dd);
  }) || null;
}

function isAllowlisted(p, allowlist) {
  if (!allowlist || !allowlist.length) return false;
  const n = normalize(p).toLowerCase();
  return allowlist.some((a) => n.includes(normalize(a).toLowerCase()));
}

/** O padrão restringe por extensão? Cobre "*.java", "*.{ts,tsx}" e "{java,kt}".
 *  O grupo de chaves é o ponto cego do regex simples: dentro dele a alternativa
 *  pode ser a extensão pura ("ts"), sem ponto. */
function hasExtensionFilter(pattern) {
  const p = String(pattern || '');
  if (/\.[a-z0-9]{1,10}(?:\}|,|$)/i.test(p)) return true;
  return (p.match(/\{[^}]*\}/g) || [])
    .some((g) => g.slice(1, -1).split(',')
      .some((alt) => /^\*?[a-z0-9]{1,10}$/i.test(alt.trim())));
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
  const { input, root, cfg, P } = ctx;
  const targets = [P.inputPath(input), ...P.inputPaths(input)].filter(Boolean);
  for (const t of targets) {
    if (isAllowlisted(t, cfg.allowlist)) continue;
    // Julga o ruído RELATIVO à raiz do workspace: o que importa é ler para
    // dentro de build/dependência DO PROJETO. Caminho fora da raiz não é
    // ruído — é contexto escolhido (PDF na Desktop, scratchpad do próprio
    // harness em %TEMP%). Barrar ancestral virou a classe de FP nº 1 do
    // replay real (2026-08): 60+ denies injustos numa máquina só.
    let probe = t;
    if (root) {
      try {
        const rel = path.relative(root, path.isAbsolute(t) ? t : path.resolve(root, t));
        if (!rel || rel.startsWith('..')) continue; // fora do workspace: libera
        probe = rel;
      } catch { /* caminho incomparável: usa como veio */ }
    }
    const dir = hitsNoise(probe, cfg.noiseDirs);
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
  const { name, input, root, cfg, P } = ctx;
  if (family(name) !== 'read') return null;
  if (P.hasReadRange(input)) return null;

  const target = P.inputPath(input);
  if (!target || isAllowlisted(target, cfg.allowlist)) return null;

  // Resolve caminho relativo contra o cwd DECLARADO no payload (o workspace),
  // não contra o cwd do processo do hook — que pode ser qualquer diretório.
  const abs = path.isAbsolute(target) ? path.normalize(target)
    : path.resolve(root || process.cwd(), target);

  let st;
  try { st = fs.statSync(abs); } catch { return null; }
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

  // Sem campo de padrão não há busca julgável: fail-open. Cobre envelopes
  // malformados (toolInput virou {}) e ferramentas de listagem de diretório
  // único, cujo escopo é o próprio caminho informado.
  if (!pattern) return null;

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
    .some((n) => Number.isFinite(Number(n)) && Number(n) > 0);
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

   Lição do gate adversarial (2026-08): deny-list de comandos apodrece —
   o agente moderno despeja árvore com `rg --files`, `fd`, `gci -r`,
   não com `ls -R`. E regex de palavra solta ("tree") bloqueia
   `git commit -m "fix tree view"`. Duas defesas:
     · padrões ancorados na posição de comando (início ou pós-pipe);
     · busca de conteúdo (grep/rg) julgada por ESCOPO, igual à regra
       broadScan: alvo explícito fora da raiz é barato.
   ================================================================ */

/** O comando começa aqui ou vem depois de um pipe/;/& — "tree" no meio de
 *  uma frase de commit não é um comando tree. Prefixos de atribuição de
 *  ambiente ("FOO=1 tree") não escondem o comando. */
const ENV_PREFIX = '(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\'[^\']*\'|\\S+)\\s+){0,6})';
const CMD_POS = '(?:^|[|;&]\\s*)' + ENV_PREFIX;

const DUMP_PATTERNS = [
  { re: new RegExp(CMD_POS + '(?:get-childitem|gci|dir)\\s[^|;&]*-recurse', 'i'), what: 'Get-ChildItem -Recurse' },
  // flag curta do PowerShell (-r), exigindo fronteira para não casar "-r" dentro de nome
  { re: new RegExp(CMD_POS + '(?:gci|dir)\\s[^|;&]*-r(?=[\\s|;&]|$)', 'i'), what: 'gci -r' },
  { re: /\bls\s+-[a-z]*r[a-z]*\b/i,                     what: 'ls -R' },
  { re: /\bdir\s+\/s\b/i,                               what: 'dir /s' },
  // Unix find: primeiro argumento é caminho — mas não switch do find.exe
  // (/c, /i…: 1-2 letras seguidas de espaço/fim) nem string citada.
  { re: new RegExp(CMD_POS + 'find\\s+(?!"|\'|-)(?!\\/[a-z]{1,2}(?:$|[\\s"]))[^\\s|;&]+', 'i'), what: 'find <path>' },
  { re: new RegExp(CMD_POS + 'tree\\b(?![^|;&]*(?:-[lL][\\s\\/]\\d*|-l\\b|\\/l|--level))', 'i'), what: 'tree' },
  { re: /\bfindstr\s+\/s/i,                             what: 'findstr /s' },
  { re: /\brg\s+[^|;&]*--files\b(?![^|;&]*\|)/i,        what: 'rg --files' },
  { re: new RegExp(CMD_POS + '(?:fd|fdfind)\\b(?![^|;&]*(?:-e\\s|--extension|-t\\s|--type|-g\\s|--glob))', 'i'), what: 'fd' },
];

/** Busca de conteúdo via shell — julgada por escopo, não por proibição.
 *  Aceita prefixos de env ("FOO=1 rg …"), como os dumps. */
const GREPISH = new RegExp('(?:^|[|;&]\\s*)' + ENV_PREFIX + '(?:[\\w.-]+[\\\\/])?(?:grep|egrep|fgrep|rg)\\b', 'i');

/**
 * true se a busca a partir de `seg` é um dump não-delimitado.
 * rg é recursivo por natureza; grep só com -r/-R. Alvo ausente ou "." é o repo inteiro.
 * Tolerante a prefixos de env e separadores antes do comando.
 */
function grepUnbounded(seg) {
  const toks = seg.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length &&
         (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || /^[|;&]$/.test(toks[i]))) i += 1;
  const cmd0 = toks[i];
  if (!cmd0 || !/^(?:[\w.-]+[\\/])?(?:grep|egrep|fgrep|rg)$/i.test(cmd0)) return false;
  const isRg = /(?:^|[\\/])rg$/i.test(cmd0);
  const rest = toks.slice(i + 1);
  const flags = rest.filter((t) => t.startsWith('-'));
  const args = rest.filter((t) => !t.startsWith('-'));
  const recursive = isRg || flags.some((f) => /^-{1,2}(r|R)(e)?$|^--recursive$/.test(f));
  if (!recursive) return false; // grep sem -r sobre stdin/arquivos apontados é barato
  const target = args[args.length - 1];
  if (!target || /^\.{1,2}\/?$/.test(target)) return true;
  return false;
}

const CAP_HINTS = new RegExp(
  '(>\\s*[^\\s|;&>]' +                        // redirect: a saída vai para arquivo, não p/ janela
  '|\\|\\s*(?:select-object|select-string|measure-object|sort-object' +
  '|head|tail|wc|less|more|awk|sed|grep|findstr|rg)\\b' +
  '|-first\\s+\\d|-totalcount\\s+\\d|\\bhead\\s+-n' +
  '|maxdepth[=\\s]+\\d|-L\\s*\\d|--level|\\/l\\b' +
  '|-m\\s+\\d|--max-count' +
  '|(?:^|\\s)-name\\s|(?:^|\\s)-iname\\s|(?:^|\\s)-path\\s|(?:^|\\s)-regex\\s' +
  '|--include|-include\\b)',
  'i'
);

function ruleShellDump(ctx) {
  const { name, input, cfg, stats, P } = ctx;
  if (family(name) !== 'shell') return null;

  const cmd = P.inputCommand(input);
  if (!cmd) return null;

  const repoFiles = stats && Number.isFinite(stats.totalFiles) ? stats.totalFiles : null;
  if (repoFiles !== null && repoFiles < cfg.limits.minRepoFilesForScanGuard) return null;

  // Busca de conteúdo no shell: mesma filosofia do broadScan — o custo é a
  // saída; escopo explícito fora da raiz ou qualquer teto tornam-na aceitável.
  const gm = GREPISH.exec(cmd);
  if (gm && !/\brg\s+[^|;&]*--files\b/i.test(cmd)) {
    if (!CAP_HINTS.test(cmd) && grepUnbounded(cmd.slice(gm.index))) {
      return {
        id: 'shellDump',
        reason:
          `token-guard/shellDump: content search from the repository root with no result cap. ` +
          `The scan itself is cheap; the OUTPUT is what enters the context window.\n` +
          `DO THIS INSTEAD: (1) list matching files first (${gm[0].trim()} with --files / files mode), ` +
          `then re-run scoped to those paths; or (2) cap it now with a path argument and a pipe limit ` +
          `(\`| head -50\`, \`| Select-Object -First 50\`).\n` +
          `(PT-BR) Busca por conteúdo a partir da raiz, sem teto de saída. Liste primeiro os arquivos ` +
          `que casam e refaça restrito a eles, ou limite já com caminho-alvo e pipe (\`| head -50\`).`,
      };
    }
    return null;
  }

  const hit = DUMP_PATTERNS.find((p) => p.re.test(cmd));

  // git ls-files: sem argumento de caminho é a árvore inteira; com caminho
  // explícito é escopado — mesma regra da busca por conteúdo.
  if (/\bgit\s+ls-files\b/i.test(cmd)) {
    const after = cmd.slice(cmd.search(/\bgit\s+ls-files\b/i)).replace(/^git\s+ls-files/, '');
    const hasPath = after.split(/\s+/).filter(Boolean)
      .some((t) => !t.startsWith('-') && !/^\.{1,2}\/?$/.test(t));
    if (!hasPath) {
      return {
        id: 'shellDump',
        reason:
          'token-guard/shellDump: "git ls-files" with no path argument lists the whole tree.\n' +
          'DO THIS INSTEAD: scope it to what you actually need ("git ls-files src/") or pipe it ("| head -50").\n' +
          '(PT-BR) "git ls-files" sem caminho lista a árvore inteira. Escopoie ("git ls-files src/") ou limite ("| head -50").',
      };
    }
    return null;
  }

  if (!hit) return null;

  // Já limitado (| Select -First, head, -Name, --include, redirect...): libera.
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
      `(3) for a whole-tree survey, run the audit — \`npx @allansantos-dev/token-guard audit\` (repo installs: ` +
      `\`node .github/token-guard/token-audit.cjs\`) — which reports aggregates instead of dumping paths.\n` +
      `(PT-BR) "${hit.what}" percorre a árvore sem filtro e sem teto, e cada linha impressa vira contexto. ` +
      `Prefira a ferramenta de busca do harness; se precisar do shell, filtre por nome/extensão e limite ` +
      `a saída (\`| Select-Object -First 50\` ou \`| head -50\`). ` +
      `Para um panorama do repositório inteiro, rode \`npx @allansantos-dev/token-guard audit\`.`,
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
