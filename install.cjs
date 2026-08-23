#!/usr/bin/env node
'use strict';
/**
 * install.cjs — instala o token-guard no(s) harness(es) que você usa.
 *
 *   node install.cjs --target copilot|claude|cursor|mcp|repo|all [caminho] [opções]
 *
 * ALVOS
 *
 *   copilot   ~/.copilot/extensions/token-guard/
 *             Extensão in-process do Copilot CLI / Copilot App. Bloqueio real,
 *             latência ~0,15 ms, e ainda expõe token_audit e token_guard_status.
 *
 *   claude    ~/.claude/token-guard/ + merge em ~/.claude/settings.json
 *             Hook PreToolUse do Claude Code. Bloqueio real. Paga cold start
 *             do Node (~200-300 ms) apenas nas ferramentas casadas pelo matcher.
 *
 *   cursor    ~/.cursor/token-guard/ + merge em ~/.cursor/hooks.json
 *             Hooks beforeReadFile / beforeShellExecution / beforeMCPExecution.
 *             Bloqueio real, mas COBERTURA PARCIAL: o Cursor não expõe evento
 *             para grep/glob, então a regra broadScan não dispara. Veja docs/IDES.md.
 *
 *   mcp       ~/.token-guard/ + snippet de configuração MCP
 *             Fallback universal (VS Code, Windsurf, Zed, JetBrains). NÃO bloqueia:
 *             entrega as ferramentas ao agente. Economia por orientação.
 *
 *   repo      .github/token-guard/ + merge em .github/hooks/hooks.json
 *             Modo repositório: viaja no git, o time inteiro herda ao clonar.
 *
 *   all       copilot + claude + cursor + mcp (tudo que é de máquina)
 *
 * OPÇÕES
 *   --mode block|warn|off   grava a config global com esse modo
 *   --dry-run               mostra tudo que faria, sem escrever um byte
 *   --force                 sobrescreve config/agente/skill já existentes
 *
 * GARANTIAS
 *   · NUNCA sobrescreve hooks.json / settings.json — faz merge e preserva o que há.
 *   · NUNCA sobrescreve config, agente ou skill já presentes (a menos de --force).
 *   · Idempotente: rodar de novo não duplica a entrada de hook.
 *   · Os alvos coexistem: a decisão, em lib/decide.cjs, é a mesma para todos.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = __dirname;
const HOME = os.homedir();

/* ------------------------------------------------------------------ */
/* Argumentos                                                          */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const FORCE = argv.includes('--force');

function optValue(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

const MODE = optValue('--mode');
if (MODE && !['block', 'warn', 'off'].includes(MODE)) {
  console.error(`install: --mode inválido: "${MODE}". Use block, warn ou off.`);
  process.exit(1);
}

/** Compatibilidade com a 1.x: --plugin/--global equivaliam a "copilot". */
const LEGACY_PLUGIN = argv.includes('--plugin') || argv.includes('--global');

let targets = (optValue('--target') || (LEGACY_PLUGIN ? 'copilot' : 'repo'))
  .toLowerCase()
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean);

if (targets.includes('all')) targets = ['copilot', 'claude', 'cursor', 'mcp'];

const VALID = ['copilot', 'claude', 'cursor', 'mcp', 'repo'];
const invalid = targets.filter((t) => !VALID.includes(t));
if (invalid.length) {
  console.error(`install: alvo inválido: ${invalid.join(', ')}. Use ${VALID.join('|')}|all.`);
  process.exit(1);
}

const positional = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return prev !== '--mode' && prev !== '--target';
});

const REPO_ROOT = path.resolve(positional[0] || process.cwd());

/* ------------------------------------------------------------------ */
/* Relatório                                                           */
/* ------------------------------------------------------------------ */

const actions = [];
const skipped = [];
const notes = [];
const log = (kind, msg) => actions.push({ kind, msg });

function rel(base, p) {
  const r = path.relative(base, p);
  return (r || '.').replace(/\\/g, '/');
}

/* ------------------------------------------------------------------ */
/* Sistema de arquivos                                                 */
/* ------------------------------------------------------------------ */

function ensureDir(p) {
  if (fs.existsSync(p)) return;
  if (!DRY) fs.mkdirSync(p, { recursive: true });
}

function copyFile(from, to, base, { overwrite = true } = {}) {
  if (!fs.existsSync(from)) return;
  if (fs.existsSync(to) && !overwrite && !FORCE) {
    skipped.push(`${rel(base, to)} (já existe — preservado)`);
    return;
  }
  const existed = fs.existsSync(to);
  ensureDir(path.dirname(to));
  if (!DRY) fs.copyFileSync(from, to);
  log(existed ? 'update' : 'create', rel(base, to));
}

function copyTree(from, to, base, { overwrite = true } = {}) {
  if (!fs.existsSync(from)) return;
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const f = path.join(from, ent.name);
    const t = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(f, t, base, { overwrite });
    else if (ent.isFile()) copyFile(f, t, base, { overwrite });
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.error(
      `install: ${file} existe mas nao e JSON valido.\n` +
      '         Corrija ou remova o arquivo antes de instalar — nao vou sobrescreve-lo.'
    );
    process.exit(1);
  }
}

function writeJson(file, obj, base, label) {
  ensureDir(path.dirname(file));
  const existed = fs.existsSync(file);
  if (!DRY) fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  log(existed ? 'merge' : 'create', label || rel(base, file));
}

/* ------------------------------------------------------------------ */
/* Runtime compartilhado                                               */
/* ------------------------------------------------------------------ */

/** Arquivos que todo alvo precisa para rodar a decisão e os CLIs que o
 *  runtime instala junto (cli.cjs roteia para mcp-cost/contract — se não
 *  forem copiados, os comandos quebram na cópia instalada). */
const RUNTIME_FILES = [
  'package.json', 'cli.cjs', 'token-guard.cjs', 'token-audit.cjs',
  'mcp-cost.cjs', 'contract.cjs', 'contract.default.md',
  'selftest.cjs', 'config.default.json', 'README.md',
];
const RUNTIME_DIRS = ['lib', 'adapters'];

function installRuntime(destDir, { extras = [], base } = {}) {
  ensureDir(destDir);
  for (const f of [...RUNTIME_FILES, ...extras]) {
    copyFile(path.join(SRC, f), path.join(destDir, f), base);
  }
  for (const d of RUNTIME_DIRS) {
    copyTree(path.join(SRC, d), path.join(destDir, d), base);
  }
}

/** Agente e skill são DO usuário depois da primeira instalação: preserva.
 *  Só --force atualiza. (Antes, reinstalar clobberava personalizações.) */
function installUserAssets(destDir, base) {
  copyTree(path.join(SRC, 'agents'), path.join(destDir, 'agents'), base, { overwrite: false });
  copyTree(path.join(SRC, 'skills'), path.join(destDir, 'skills'), base, { overwrite: false });
}

/**
 * Estado de um registro de hook que menciona token-guard.
 * live: aponta para script existente · stale: script morto (upgrade mudou layout)
 * Um registro obsoleto NÃO pode mascarar a instalação nova: o guard ficaria
 * silenciosamente desligado (fail-open transforma isso em invisível).
 */
function registrationState(commands, canonicalScript, resolveBase) {
  let stale = false;
  let liveSame = false;
  let liveOther = false;
  for (const cmd of commands) {
    if (typeof cmd !== 'string' || !cmd.includes('token-guard')) continue;
    const m = /"?([^"\s]+\.(?:cjs|mjs|js))"?/.exec(cmd);
    let p = m ? m[1] : null;
    if (!p) { liveSame = true; continue; }
    if (!path.isAbsolute(p) && resolveBase) p = path.resolve(resolveBase, p);
    if (!fs.existsSync(p)) { stale = true; continue; }
    const norm = (x) => x.replace(/\\/g, '/').toLowerCase();
    norm(p) === norm(canonicalScript) ? liveSame = true : liveOther = true;
  }
  return { stale, liveSame, liveOther };
}

/** Config global opcional: vale para todos os repos; a do repositório vence. */
function writeGlobalConfig(dir, base) {
  const cfgPath = path.join(dir, 'token-guard.config.json');
  if (fs.existsSync(cfgPath) && !FORCE) {
    skipped.push(`${rel(base, cfgPath)} (ja existe — preservado)`);
    return;
  }
  if (!MODE) return; // sem --mode, os defaults ja bastam
  const tpl = JSON.parse(fs.readFileSync(path.join(SRC, 'config.default.json'), 'utf8'));
  tpl.mode = MODE;
  writeJson(cfgPath, tpl, base, `${rel(base, cfgPath)}  (mode: ${MODE})`);
}

/** Node quoteado: caminhos com espaco sao a regra em Windows, nao a excecao. */
function nodeCmd(scriptPath) {
  return `node "${scriptPath.replace(/\\/g, '/')}"`;
}

/* ------------------------------------------------------------------ */
/* Matchers por harness                                                */
/* ------------------------------------------------------------------ */

const MATCHER_COPILOT =
  '(?:view|read|grep|glob|search|list_dir|list_files|list_directory|bash|shell|' +
  'powershell|pwsh|terminal|run_command|execute_command|find_files|cat_file|open_file|ripgrep)';

/** O Claude Code usa nomes proprios e capitalizados; o matcher e regex sobre eles. */
const MATCHER_CLAUDE = 'Read|Grep|Glob|Bash|LS|NotebookRead|Search';

/* ------------------------------------------------------------------ */
/* Alvo: copilot                                                       */
/* ------------------------------------------------------------------ */

function installCopilot() {
  const base = path.join(HOME, '.copilot');
  const dir = path.join(base, 'extensions', 'token-guard');
  installRuntime(dir, { extras: ['extension.mjs', 'plugin.json'], base });
  installUserAssets(dir, base);
  writeGlobalConfig(base, base);
  notes.push('copilot  · recarregue as extensoes (ou reinicie o agente) para ativar.');
}

/* ------------------------------------------------------------------ */
/* Alvo: claude                                                        */
/* ------------------------------------------------------------------ */

/**
 * Remove entradas cujo comando token-guard aponta para script inexistente —
 * em TODOS os eventos (PreToolUse, PostToolUse, UserPromptSubmit). Um registro
 * morto não pode sobreviver junto do novo: o Claude Code spawna o caminho
 * morto a cada chamada e o reparo precisa ser simétrico.
 */
function pruneDeadTokenGuard(entries, canonicalScript) {
  let removed = false;
  const kept = (entries || []).filter((entry) => {
    const cmds = Array.isArray(entry?.hooks)
      ? entry.hooks.map((h) => h?.command)
      : [entry?.command];
    if (!cmds.some((c) => typeof c === 'string' && c.includes('token-guard'))) return true;
    const state = registrationState(cmds.filter(Boolean), canonicalScript, null);
    if (state.liveSame || state.liveOther) return true;
    removed = true;
    return false;
  });
  return { entries: kept, removed };
}

function installClaude() {
  const base = path.join(HOME, '.claude');
  const dir = path.join(base, 'token-guard');
  installRuntime(dir, { base });
  installUserAssets(dir, base);

  const settingsPath = path.join(base, 'settings.json');
  const settings = readJson(settingsPath) || {};
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];

  const command = nodeCmd(path.join(dir, 'adapters', 'hook-cmd.cjs'));
  const canonicalScript = path.join(dir, 'adapters', 'hook-cmd.cjs');

  /**
   * Ciclo de registro de UM evento: (1) remove registro morto; (2) SUBSTITUI
   * registro vivo em layout antigo — coexistir significaria dois guards
   * disparando por evento para sempre; (3) dedupe olhando TODOS os hooks da
   * entrada, não só o primeiro; (4) atualiza matcher drifted no PreToolUse.
   */
  function reconcile(entries, canonicalScript, { withMatcher } = {}) {
    let repairedDead = false;
    let replacedOldLayout = false;
    let matcherUpdated = false;
    let alreadyLive = false;

    // 1. mortos fora
    const pruned = pruneDeadTokenGuard(entries, canonicalScript);
    entries = pruned.entries;
    repairedDead = pruned.removed;

    // 2. vivos em layout antigo (token-guard-named, script existe, path difere)
    entries = entries.filter((entry) => {
      const cmds = Array.isArray(entry?.hooks)
        ? entry.hooks.map((h) => h?.command)
        : [entry?.command];
      if (!cmds.some((c) => typeof c === 'string' && c.includes('token-guard'))) return true;
      const st = registrationState(cmds.filter(Boolean), canonicalScript, null);
      if (!st.liveOther) return true;
      replacedOldLayout = true;
      return false; // substituído pela entrada canônica abaixo
    });

    // 3. já registrado? olhando todos os hooks de todas as entradas
    const allCmds = entries
      .flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : [entry]))
      .map((h) => h?.command)
      .filter(Boolean);
    alreadyLive = registrationState(allCmds, canonicalScript, null).liveSame;

    // 4. matcher drift: cobertura nova nunca chega a quem foi instalado antes
    if (withMatcher && alreadyLive) {
      for (const entry of entries) {
        if (Array.isArray(entry?.hooks) &&
            entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('token-guard')) &&
            entry.matcher !== MATCHER_CLAUDE) {
          entry.matcher = MATCHER_CLAUDE;
          matcherUpdated = true;
        }
      }
    }

    return { entries, repairedDead, replacedOldLayout, matcherUpdated, alreadyLive };
  }

  /* PreToolUse — as quatro regras (com matcher: evita spawn nas chamadas que
     nunca seriam barradas). */
  {
    const r = reconcile(settings.hooks.PreToolUse, canonicalScript, { withMatcher: true });
    settings.hooks.PreToolUse = r.entries;
    const bits = [
      r.repairedDead ? 'registro obsoleto reparado' : null,
      r.replacedOldLayout ? 'layout antigo substituído' : null,
      r.matcherUpdated ? 'matcher atualizado' : null,
    ].filter(Boolean);

    if (r.alreadyLive) {
      if (!bits.length) {
        skipped.push('~/.claude/settings.json (token-guard ja registrado)');
      } else {
        writeJson(settingsPath, settings, base,
          `settings.json  (PreToolUse${bits.length ? ': ' + bits.join(' · ') : ''})`);
      }
    } else {
      settings.hooks.PreToolUse.push({
        matcher: MATCHER_CLAUDE,
        hooks: [{ type: 'command', command, timeout: 10 }],
      });
      writeJson(settingsPath, settings, base,
        `settings.json  (PreToolUse${bits.length ? ': ' + bits.join(' · ') : ' + token-guard'})`);
    }
  }

  /* PostToolUse — regra bigResult: orienta pós-execução (sem matcher: roda
     para qualquer ferramenta; o custo é um spawn só quando HÁ resultado). */
  if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = [];
  {
    const postCommand = nodeCmd(path.join(dir, 'adapters', 'post-hook.cjs'));
    const postCanonical = path.join(dir, 'adapters', 'post-hook.cjs');
    const r = reconcile(settings.hooks.PostToolUse, postCanonical);
    settings.hooks.PostToolUse = r.entries;
    const bits = [
      r.repairedDead ? 'registro obsoleto reparado' : null,
      r.replacedOldLayout ? 'layout antigo substituído' : null,
    ].filter(Boolean);

    if (r.alreadyLive) {
      if (!bits.length) skipped.push('~/.claude/settings.json (PostToolUse ja registrado)');
      else writeJson(settingsPath, settings, base,
        `settings.json  (PostToolUse: bigResult · ${bits.join(' · ')})`);
    } else {
      settings.hooks.PostToolUse.push({
        hooks: [{ type: 'command', command: postCommand, timeout: 10 }],
      });
      writeJson(settingsPath, settings, base,
        `settings.json  (PostToolUse: bigResult${bits.length ? ' · ' + bits.join(' · ') : ''})`);
    }
  }

  /* UserPromptSubmit — injeção do contrato de saída ("sempre", 1×/sessão). */
  if (!Array.isArray(settings.hooks.UserPromptSubmit)) settings.hooks.UserPromptSubmit = [];
  {
    const promptCommand = nodeCmd(path.join(dir, 'adapters', 'prompt-hook.cjs'));
    const promptCanonical = path.join(dir, 'adapters', 'prompt-hook.cjs');
    const r = reconcile(settings.hooks.UserPromptSubmit, promptCanonical);
    settings.hooks.UserPromptSubmit = r.entries;
    const bits = [
      r.repairedDead ? 'registro obsoleto reparado' : null,
      r.replacedOldLayout ? 'layout antigo substituído' : null,
    ].filter(Boolean);

    if (r.alreadyLive) {
      if (!bits.length) skipped.push('~/.claude/settings.json (UserPromptSubmit ja registrado)');
      else writeJson(settingsPath, settings, base,
        `settings.json  (UserPromptSubmit: contrato "sempre" · ${bits.join(' · ')})`);
    } else {
      settings.hooks.UserPromptSubmit.push({
        hooks: [{ type: 'command', command: promptCommand, timeout: 10 }],
      });
      writeJson(settingsPath, settings, base,
        `settings.json  (UserPromptSubmit: contrato "sempre"${bits.length ? ' · ' + bits.join(' · ') : ''})`);
    }
  }

  writeGlobalConfig(base, base);
  notes.push('claude   · reinicie a sessao do Claude Code para carregar o hook.');
}

/* ------------------------------------------------------------------ */
/* Alvo: cursor                                                        */
/* ------------------------------------------------------------------ */

function installCursor() {
  let staleCursor = false;
  const base = path.join(HOME, '.cursor');
  const dir = path.join(base, 'token-guard');
  installRuntime(dir, { base });
  installUserAssets(dir, base);

  const hooksPath = path.join(base, 'hooks.json');
  const hooks = readJson(hooksPath) || { version: 1, hooks: {} };
  if (typeof hooks.version !== 'number') hooks.version = 1;
  if (!hooks.hooks || typeof hooks.hooks !== 'object') hooks.hooks = {};

  const command = nodeCmd(path.join(dir, 'adapters', 'cursor-hook.cjs'));
  const canonicalScript = path.join(dir, 'adapters', 'cursor-hook.cjs');
  const EVENTS = ['beforeReadFile', 'beforeShellExecution', 'beforeMCPExecution'];

  let added = 0;
  for (const evt of EVENTS) {
    if (!Array.isArray(hooks.hooks[evt])) hooks.hooks[evt] = [];
    // Repara registro obsoleto (script morto de layout antigo) em vez de
    // mascará-lo como "já registrado".
    hooks.hooks[evt] = hooks.hooks[evt].filter((h) => {
      if (typeof h?.command !== 'string' || !h.command.includes('token-guard')) return true;
      const state = registrationState([h.command], canonicalScript, null);
      if (state.stale && !state.liveSame && !state.liveOther) {
        staleCursor = true;
        return false;
      }
      return true;
    });
    const has = hooks.hooks[evt].some(
      (h) => typeof h?.command === 'string' && h.command.includes('token-guard')
    );
    if (has) {
      skipped.push(`~/.cursor/hooks.json > ${evt} (token-guard ja registrado)`);
      continue;
    }
    hooks.hooks[evt].push({ command });
    added += 1;
  }

  if (added || staleCursor) {
    writeJson(hooksPath, hooks, base,
      `hooks.json  (${staleCursor ? 'registro obsoleto reparado · ' : ''}+${added} evento(s), demais preservados)`);
  }
  writeGlobalConfig(base, base);
  notes.push('cursor   · cobertura PARCIAL: sem evento de grep/glob, broadScan nao dispara.');
  notes.push('cursor   · no CLI (cursor-agent) so beforeShellExecution e entregue hoje.');
}

/* ------------------------------------------------------------------ */
/* Alvo: mcp                                                           */
/* ------------------------------------------------------------------ */

function installMcp() {
  const base = path.join(HOME, '.token-guard');
  const dir = path.join(base, 'runtime');
  installRuntime(dir, { base });
  installUserAssets(dir, base);

  const server = path.join(dir, 'adapters', 'mcp-server.cjs');
  const snippet = {
    mcpServers: {
      'token-guard': {
        command: 'node',
        args: [server],
      },
    },
  };
  writeJson(path.join(base, 'mcp.json'), snippet, base, 'mcp.json  (snippet pronto para colar)');

  notes.push('mcp      · ADVISORY: entrega as ferramentas ao agente, nao bloqueia a chamada.');
  notes.push('mcp      · cole o conteudo de ~/.token-guard/mcp.json na config MCP do seu IDE:');
  notes.push('mcp        VS Code  .vscode/mcp.json  ·  Cursor  ~/.cursor/mcp.json');
  notes.push('mcp        Claude Desktop  claude_desktop_config.json  ·  Windsurf/Zed  ver docs/IDES.md');
}

/* ------------------------------------------------------------------ */
/* Alvo: repo (viaja no git)                                           */
/* ------------------------------------------------------------------ */

function installRepo() {
  const DEST = REPO_ROOT;
  if (path.resolve(DEST) === path.resolve(SRC)) {
    console.error('install: origem e destino sao o mesmo diretorio. Informe o alvo.');
    process.exit(1);
  }
  if (!fs.existsSync(DEST)) {
    console.error(`install: destino invalido: ${DEST}`);
    process.exit(1);
  }

  const BASE = path.join(DEST, '.github');
  const guardDir = path.join(BASE, 'token-guard');
  ensureDir(guardDir);

  for (const f of ['token-guard.cjs', 'token-audit.cjs', 'selftest.cjs', 'cli.cjs',
                   'config.default.json', 'package.json']) {
    copyFile(path.join(SRC, f), path.join(guardDir, f), DEST);
  }
  copyTree(path.join(SRC, 'lib'), path.join(guardDir, 'lib'), DEST);
  copyTree(path.join(SRC, 'adapters'), path.join(guardDir, 'adapters'), DEST);

  copyFile(path.join(SRC, 'agents', 'scout.agent.md'),
           path.join(BASE, 'agents', 'scout.agent.md'), DEST, { overwrite: false });
  copyFile(path.join(SRC, 'skills', 'token-economy', 'SKILL.md'),
           path.join(BASE, 'skills', 'token-economy', 'SKILL.md'), DEST, { overwrite: false });

  const cfgPath = path.join(DEST, 'token-guard.config.json');
  if (fs.existsSync(cfgPath) && !FORCE) {
    skipped.push('token-guard.config.json (ja existe — preservado)');
  } else {
    const tpl = JSON.parse(fs.readFileSync(path.join(SRC, 'config.default.json'), 'utf8'));
    if (MODE) tpl.mode = MODE;
    writeJson(cfgPath, tpl, DEST, 'token-guard.config.json' + (MODE ? `  (mode: ${MODE})` : ''));
  }

  /* hooks.json — MERGE, nunca sobrescrita; registro obsoleto é reparado */
  const hooksPath = path.join(BASE, 'hooks', 'hooks.json');
  const hooks = readJson(hooksPath) || { version: 1, hooks: {} };
  if (typeof hooks.version !== 'number') hooks.version = 1;
  if (!hooks.hooks || typeof hooks.hooks !== 'object') hooks.hooks = {};
  if (!Array.isArray(hooks.hooks.PreToolUse)) hooks.hooks.PreToolUse = [];

  const canonicalScript = path.join(guardDir, 'token-guard.cjs');
  let staleRepo = false;
  const liveCmds = [];
  hooks.hooks.PreToolUse = hooks.hooks.PreToolUse.filter((h) => {
    const cmd = h?.command;
    if (typeof cmd !== 'string' || !cmd.includes('token-guard')) return true;
    const state = registrationState([cmd], canonicalScript, DEST);
    if (state.stale && !state.liveSame && !state.liveOther) {
      staleRepo = true;
      return false; // aponta para script que não existe mais: remove p/ reinstalar
    }
    liveCmds.push(cmd);
    return true;
  });

  const already = registrationState(liveCmds, canonicalScript, DEST).liveSame;

  if (already && !staleRepo) {
    skipped.push('.github/hooks/hooks.json (token-guard ja registrado)');
  } else {
    const before = hooks.hooks.PreToolUse.length;
    hooks.hooks.PreToolUse.push({
      matcher: MATCHER_COPILOT,
      type: 'command',
      command: 'node .github/token-guard/token-guard.cjs',
      timeout: 10,
    });
    writeJson(hooksPath, hooks, DEST,
      `.github/hooks/hooks.json  (${staleRepo ? 'registro obsoleto reparado · ' : ''}` +
      `PreToolUse: ${before} entrada(s) preservada(s) + token-guard)`);
  }

  /* .gitignore do cache */
  const giPath = path.join(DEST, '.gitignore');
  const IGNORE = '.token-guard/';
  if (fs.existsSync(giPath)) {
    const gi = fs.readFileSync(giPath, 'utf8');
    if (!gi.split(/\r?\n/).some((l) => l.trim() === IGNORE)) {
      if (!DRY) {
        fs.appendFileSync(giPath, (gi.endsWith('\n') ? '' : '\n') +
          '\n# token-guard: cache de estatisticas (regeneravel)\n' + IGNORE + '\n', 'utf8');
      }
      log('append', `.gitignore  (+ ${IGNORE})`);
    } else {
      skipped.push('.gitignore (ja ignora o cache)');
    }
  } else {
    if (!DRY) fs.writeFileSync(giPath, '# token-guard: cache de estatisticas (regeneravel)\n' + IGNORE + '\n', 'utf8');
    log('create', '.gitignore');
  }

  notes.push('repo     · commite o que foi criado: quem clonar herda a economia.');
  notes.push('repo     · calibre os limites: node .github/token-guard/token-audit.cjs');
}

/* ------------------------------------------------------------------ */
/* Execucao                                                            */
/* ------------------------------------------------------------------ */

const RUNNERS = {
  copilot: installCopilot,
  claude: installClaude,
  cursor: installCursor,
  mcp: installMcp,
  repo: installRepo,
};

const W = 72;
console.log('');
console.log(`  token-guard · instalacao${DRY ? ' [SIMULACAO]' : ''}`);
console.log('  ' + '─'.repeat(W));
console.log(`  alvos: ${targets.join(', ')}`);
console.log('');

for (const t of targets) {
  const mark = actions.length;
  RUNNERS[t]();
  const done = actions.slice(mark);
  console.log(`  [${t}]`);
  if (!done.length) console.log('    (nada a fazer — ja estava instalado)');
  for (const a of done) console.log(`    ${a.kind.padEnd(7)} ${a.msg}`);
  console.log('');
}

if (skipped.length) {
  console.log('  PRESERVADO');
  for (const s of skipped) console.log(`    ${s}`);
  console.log('');
}

console.log('  ' + '─'.repeat(W));
console.log('');
console.log('  PROXIMOS PASSOS');
console.log('');
for (const n of notes) console.log(`    ${n}`);
console.log('');
console.log('    Confirme que os guards respondem aqui:  node selftest.cjs');
console.log('    Meca o custo do repositorio:            node token-audit.cjs');
console.log('');
console.log('  Adocao sem atrito: comece com --mode warn e vire para block depois.');
console.log('  Emergencia: TOKEN_GUARD=off desliga sem editar arquivo.');
console.log('');
