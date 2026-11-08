'use strict';
/**
 * uninstall.cjs — desfaz o que `init` gravou na máquina: hooks e MCP dos harnesses, runtimes copiados,
 * autostart e daemon. Com `--dry-run` só lista, sem mexer em nada.
 *
 * Só sai o que é reconhecidamente do token-guard (URL do hook http, comando dentro do runtime ou com a
 * origem assinada, tabela do MCP, hook mcp_tool do servidor token-guard); o que for de terceiro fica.
 * Antes de reescrever um arquivo de configuração, a cópia vai para `<arquivo>.token-guard-uninstall.bak`.
 * Preserva o que é do usuário: configuração, histórico de eventos e cache em ~/.token-guard.
 *
 * O alvo `repo` (.github/ do repositório) viaja no git e não é tocado aqui.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BACKUP_SUFFIX = '.token-guard-uninstall.bak';
const HOOK_ORIGIN = '--hook-origin=token-guard';
const SCOUT_TITLE = '# Scout — reconhecimento com contexto descartável';
const MCP_TABLE = 'mcp_servers.token-guard';
const TASKS = ['TokenGuardDaemon', 'TokenGuardDaemonWatch'];
const SERVICE = 'token-guard-daemon';
const LAUNCHD_LABEL = 'com.token-guard.daemon';
const CLAUDE_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'SubagentStart'];
const CURSOR_EVENTS = ['preToolUse', 'beforeReadFile', 'beforeShellExecution', 'beforeMCPExecution'];
const STATE_FILES = ['install-state.json', 'daemon-http.json', 'daemon-http.token'];

const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();

function platform() {
  return process.env.TOKEN_GUARD_FORCE_PLATFORM || process.platform;
}

function quiet(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function readJson(file) {
  if (!fs.existsSync(file)) return { absent: true };
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch (e) {
    return { error: `${file} não é JSON legível (${e.message}); não foi tocado` };
  }
}

/** Grava `text` em `file` por rename, depois de guardar a cópia do conteúdo anterior ao lado. */
function rewrite(file, text) {
  fs.copyFileSync(file, file + BACKUP_SUFFIX);
  const tmp = `${file}.tg-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function writeJsonKeepingEol(file, obj) {
  const crlf = fs.readFileSync(file, 'utf8').includes('\r\n');
  const text = JSON.stringify(obj, null, 2) + '\n';
  rewrite(file, crlf ? text.replace(/\n/g, '\r\n') : text);
}

/** Tira os hooks que casam `pred` de cada entrada; entrada que fica vazia sai. Devolve quantos saíram. */
function stripHooks(entries, pred) {
  let removed = 0;
  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (Array.isArray(e && e.hooks)) {
      const kept = e.hooks.filter((h) => !pred(h));
      removed += e.hooks.length - kept.length;
      if (kept.length) out.push({ ...e, hooks: kept });
    } else if (pred(e)) {
      removed += 1;
    } else {
      out.push(e);
    }
  }
  return { entries: out, removed };
}

/** Remove de um config.toml a tabela `[table]` e suas subtabelas; o resto do arquivo fica como está. */
function removeTomlTable(text, table) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${table}]`);
  if (start === -1) return { text, removed: false };
  const isHeader = (l) => /^\s*\[/.test(l);
  const ours = (l) => l.trim() === `[${table}]` || l.trim().startsWith(`[${table}.`);
  let end = start + 1;
  for (;;) {
    while (end < lines.length && !isHeader(lines[end])) end++;
    if (end < lines.length && ours(lines[end])) { end++; continue; }
    break;
  }
  let blockEnd = end;
  while (blockEnd > start + 1 && /^\s*(#.*)?$/.test(lines[blockEnd - 1])) blockEnd--;
  const next = [...lines.slice(0, start), ...lines.slice(blockEnd)];
  while (next.length > 1 && next[next.length - 1] === '' && next[next.length - 2] === '') next.pop();
  while (start > 0 && start === next.length && next.length && next[next.length - 1] === '') next.pop();
  return { text: next.join(eol), removed: true };
}

/**
 * Monta os passos do que há para remover nesta máquina. Cada passo só entra se o rastro existe.
 * @returns {{id:string, label:string, run:()=>Promise<string>|string}[]}
 */
function plan() {
  const HOME = os.homedir();
  const tg = path.join(HOME, '.token-guard');
  const claude = path.join(HOME, '.claude');
  const codex = process.env.CODEX_HOME || path.join(HOME, '.codex');
  const cursor = path.join(HOME, '.cursor');
  const copilot = path.join(HOME, '.copilot');
  const steps = [];
  const errors = [];

  const autostart = process.env.TOKEN_GUARD_NO_AUTOSTART === '1' && !process.env.TOKEN_GUARD_FORCE_PLATFORM ? [] : autostartSteps(HOME);
  steps.push(...autostart);

  const claudeRuntime = norm(path.join(claude, 'token-guard'));
  const cursorRuntime = norm(path.join(cursor, 'token-guard'));
  const commandIsOurs = (runtime) => (h) => typeof (h && h.command) === 'string'
    && (norm(h.command).includes(`${runtime}/`) || norm(h.command).includes('/token-guard/adapters/') || h.command.includes(HOOK_ORIGIN));
  const claudeHook = (h) => (h && h.type === 'http' && /^http:\/\/127\.0\.0\.1:\d+\/token-guard\//.test(String(h.url || '')))
    || commandIsOurs(claudeRuntime)(h);

  const settingsFile = path.join(claude, 'settings.json');
  const settings = readJson(settingsFile);
  if (settings.error) errors.push(settings.error);
  else if (settings.value && settings.value.hooks) {
    const count = CLAUDE_EVENTS.reduce((n, ev) => n + stripHooks(settings.value.hooks[ev], claudeHook).removed, 0);
    if (count) {
      steps.push({
        id: 'claude-settings',
        label: `${settingsFile}: ${count} hook(s) do token-guard (${CLAUDE_EVENTS.join(', ')}); os demais ficam`,
        run: () => {
          const cur = readJson(settingsFile).value;
          for (const ev of CLAUDE_EVENTS) {
            const r = stripHooks(cur.hooks[ev], claudeHook);
            if (r.entries.length) cur.hooks[ev] = r.entries; else delete cur.hooks[ev];
          }
          if (!Object.keys(cur.hooks).length) delete cur.hooks;
          writeJsonKeepingEol(settingsFile, cur);
          return `${count} hook(s) removido(s); cópia em ${settingsFile + BACKUP_SUFFIX}`;
        },
      });
    }
  }

  const scout = path.join(claude, 'agents', 'scout.agent.md');
  if (fs.existsSync(scout) && fs.readFileSync(scout, 'utf8').includes(SCOUT_TITLE)) {
    steps.push({ id: 'claude-scout', label: `${scout} (agente do token-guard)`, run: () => { fs.rmSync(scout, { force: true }); return 'removido'; } });
  }

  const cursorFile = path.join(cursor, 'hooks.json');
  const cursorCfg = readJson(cursorFile);
  if (cursorCfg.error) errors.push(cursorCfg.error);
  else if (cursorCfg.value && cursorCfg.value.hooks) {
    const ours = commandIsOurs(cursorRuntime);
    const count = CURSOR_EVENTS.reduce((n, ev) => n + (cursorCfg.value.hooks[ev] || []).filter(ours).length, 0);
    if (count) {
      steps.push({
        id: 'cursor-hooks',
        label: `${cursorFile}: ${count} hook(s) do token-guard (${CURSOR_EVENTS.join(', ')}); os demais ficam`,
        run: () => {
          const cur = readJson(cursorFile).value;
          for (const ev of CURSOR_EVENTS) {
            if (!Array.isArray(cur.hooks[ev])) continue;
            cur.hooks[ev] = cur.hooks[ev].filter((h) => !ours(h));
            if (!cur.hooks[ev].length) delete cur.hooks[ev];
          }
          writeJsonKeepingEol(cursorFile, cur);
          return `${count} hook(s) removido(s); cópia em ${cursorFile + BACKUP_SUFFIX}`;
        },
      });
    }
  }

  const codexHooks = path.join(codex, 'hooks.json');
  const codexCfg = readJson(codexHooks);
  const codexOurs = (h) => h && h.type === 'mcp_tool' && h.server === 'token-guard';
  if (codexCfg.error) errors.push(codexCfg.error);
  else if (codexCfg.value && codexCfg.value.hooks) {
    const count = stripHooks(codexCfg.value.hooks.PreToolUse, codexOurs).removed;
    if (count) {
      steps.push({
        id: 'codex-hooks',
        label: `${codexHooks}: ${count} hook(s) mcp_tool do token-guard em PreToolUse; os demais ficam`,
        run: () => {
          const cur = readJson(codexHooks).value;
          const r = stripHooks(cur.hooks.PreToolUse, codexOurs);
          if (r.entries.length) cur.hooks.PreToolUse = r.entries; else delete cur.hooks.PreToolUse;
          writeJsonKeepingEol(codexHooks, cur);
          return `${count} hook(s) removido(s); cópia em ${codexHooks + BACKUP_SUFFIX}`;
        },
      });
    }
  }

  const toml = path.join(codex, 'config.toml');
  if (fs.existsSync(toml) && removeTomlTable(fs.readFileSync(toml, 'utf8'), MCP_TABLE).removed) {
    steps.push({
      id: 'codex-toml',
      label: `${toml}: tabela [${MCP_TABLE}]; o resto do arquivo fica`,
      run: () => {
        rewrite(toml, removeTomlTable(fs.readFileSync(toml, 'utf8'), MCP_TABLE).text);
        return `tabela removida; cópia em ${toml + BACKUP_SUFFIX}`;
      },
    });
  }

  // Depois dos hooks e do autostart: nenhuma sessão nova o sobe de volta a partir do runtime que sai em seguida.
  if (process.env.TOKEN_GUARD_NO_DAEMON_SWAP !== '1') {
    steps.push({
      id: 'daemon',
      label: 'encerrar o daemon, se estiver no ar',
      run: async () => {
        const r = await require('./daemon-client.cjs').shutdownDaemon();
        return r && r.ok ? 'daemon encerrado' : 'nenhum daemon no ar';
      },
    });
  }

  for (const dir of [
    path.join(claude, 'token-guard'), path.join(codex, 'token-guard'), path.join(cursor, 'token-guard'),
    path.join(copilot, 'extensions', 'token-guard'), path.join(tg, 'runtime'),
  ]) {
    if (fs.existsSync(dir)) steps.push({ id: `dir:${dir}`, label: `${dir} (runtime copiado pelo init)`, run: () => { fs.rmSync(dir, { recursive: true, force: true }); return 'removido'; } });
  }

  for (const f of ['mcp.json', ...STATE_FILES].map((n) => path.join(tg, n))) {
    if (fs.existsSync(f)) steps.push({ id: `file:${f}`, label: `${f}`, run: () => { fs.rmSync(f, { force: true }); return 'removido'; } });
  }

  return { steps, errors };
}

/** Configs globais por harness que o init grava e o uninstall deixa (o usuário pode ter editado). */
function preservedConfigs() {
  const HOME = os.homedir();
  return ['.claude', '.copilot', '.cursor']
    .map((d) => path.join(HOME, d, 'token-guard.config.json'))
    .filter((f) => fs.existsSync(f));
}

/** Autostart do daemon (tarefas do Windows, unit do systemd, plist do launchd) e a variável TOKEN_GUARD_SID. */
function autostartSteps(HOME) {
  const plat = platform();
  const steps = [];
  if (plat === 'win32') {
    for (const name of TASKS) {
      if (quiet('schtasks', ['/query', '/tn', name])) {
        steps.push({ id: `task:${name}`, label: `tarefa agendada "${name}"`, run: () => (quiet('schtasks', ['/delete', '/tn', name, '/f']) ? 'removida' : failed(`schtasks /delete ${name}`)) });
      }
    }
    if (quiet('reg', ['query', 'HKCU\\Environment', '/v', 'TOKEN_GUARD_SID'])) {
      steps.push({ id: 'env:TOKEN_GUARD_SID', label: 'variável de usuário TOKEN_GUARD_SID', run: () => (quiet('reg', ['delete', 'HKCU\\Environment', '/v', 'TOKEN_GUARD_SID', '/f']) ? 'removida' : failed('reg delete TOKEN_GUARD_SID')) });
    }
  } else if (plat === 'darwin') {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    if (fs.existsSync(plist)) steps.push({ id: 'launchd', label: plist, run: () => { quiet('launchctl', ['unload', plist]); fs.rmSync(plist, { force: true }); return 'descarregado e removido'; } });
  } else {
    const unit = path.join(HOME, '.config', 'systemd', 'user', `${SERVICE}.service`);
    if (fs.existsSync(unit)) {
      steps.push({
        id: 'systemd', label: unit,
        run: () => {
          quiet('systemctl', ['--user', 'disable', '--now', `${SERVICE}.service`]);
          fs.rmSync(unit, { force: true });
          quiet('systemctl', ['--user', 'daemon-reload']);
          return 'desabilitado e removido';
        },
      });
    }
  }
  return steps;
}

function failed(what) {
  throw new Error(`${what} falhou`);
}

/**
 * @param {{dryRun?:boolean, out?:(line:string)=>void}} [opts]
 * @returns {Promise<{ok:boolean, dryRun:boolean, steps:{id:string,label:string,result:string,ok:boolean}[], errors:string[]}>}
 */
async function run(opts = {}) {
  const out = opts.out || ((l) => console.log(l));
  const dryRun = Boolean(opts.dryRun);
  const { steps, errors } = plan();
  const results = [];
  out('');
  out(`  token-guard · desinstalação${dryRun ? ' [SIMULAÇÃO: nada será removido]' : ''}`);
  out('  ' + '─'.repeat(66));
  if (!steps.length && !errors.length) out('  nada do token-guard encontrado nesta máquina.');
  for (const s of steps) {
    if (dryRun) {
      out(`  removeria  ${s.label}`);
      results.push({ id: s.id, label: s.label, result: 'não executado (dry-run)', ok: true });
      continue;
    }
    try {
      const result = await s.run();
      out(`  removido   ${s.label} — ${result}`);
      results.push({ id: s.id, label: s.label, result, ok: true });
    } catch (e) {
      out(`  FALHOU     ${s.label} — ${e.message}`);
      results.push({ id: s.id, label: s.label, result: e.message, ok: false });
    }
  }
  for (const e of errors) out(`  FALHOU     ${e}`);
  out('');
  const kept = preservedConfigs();
  out(`  preservado: ${[path.join(os.homedir(), '.token-guard') + ' (configuração, histórico de eventos e cache)', ...kept].join('; ')}; alvo repo (.github/) não é tocado.`);
  if (!dryRun && steps.some((s) => /token-guard[\\/]runtime$|mcp\.json$/.test(s.id))) {
    out('  se você colou o bloco do MCP na config de uma IDE (.vscode/mcp.json, ~/.cursor/mcp.json, Claude Desktop), remova o bloco "token-guard" de lá: o servidor que ele aponta saiu.');
  }
  if (!dryRun && steps.some((s) => s.id === 'claude-settings')) out(`  a cópia do settings.json guarda o token antigo do hook; ele já não vale (o daemon-http.token foi removido). Apague a cópia quando conferir.`);
  if (!dryRun && steps.length) out('  reinicie as sessões abertas dos agentes para soltar os hooks já carregados.');
  out('');
  const ok = !errors.length && results.every((r) => r.ok);
  return { ok, dryRun, steps: results, errors };
}

/** Entrada do CLI: `token-guard uninstall [--dry-run]`. */
async function main(args) {
  const known = ['--dry-run'];
  const bad = args.filter((a) => !known.includes(a));
  if (bad.length) {
    console.error(`uninstall: opção desconhecida: ${bad.join(' ')}. Use: token-guard uninstall [--dry-run]`);
    return 1;
  }
  const r = await run({ dryRun: args.includes('--dry-run') });
  return r.ok ? 0 : 1;
}

module.exports = { plan, run, main, stripHooks, removeTomlTable, BACKUP_SUFFIX };
