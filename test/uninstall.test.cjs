#!/usr/bin/env node
'use strict';
/**
 * uninstall.test.cjs — `token-guard uninstall` contra um home falso.
 *
 * Garantias: --dry-run lista sem mexer em nada; a remoção real tira só o que é do token-guard
 * (hooks de terceiros, tabelas TOML alheias, configuração e eventos do usuário ficam); cada arquivo
 * de configuração reescrito deixa a cópia ao lado; rodar de novo não acha nada; o autostart POSIX
 * é desfeito pelo mesmo nome que o init gravou.
 */

require('./bootstrap.cjs');

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'cli.cjs');
const { removeTomlTable, stripHooks } = require(path.join(ROOT, 'lib', 'uninstall.cjs'));

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); } else { fail += 1; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}

function fakeHome(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `tg-unin-${name}-`));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"x","private":true}', 'utf8');
  return { home, repo };
}

function tg(home, cwd, args, extra) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', timeout: 90000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), ...extra },
  });
}

const read = (f) => fs.readFileSync(f, 'utf8');
const readJson = (f) => JSON.parse(read(f));

console.log('\n  funções puras');
{
  const toml = '[model]\nname = "x"\n\n[mcp_servers.token-guard]\ncommand = "node"\n\n[mcp_servers.token-guard.env]\nA = "1"\n\n[mcp_servers.outro]\ncommand = "y"\n';
  const r = removeTomlTable(toml, 'mcp_servers.token-guard');
  check('toml: tira a tabela e a subtabela', r.removed && !r.text.includes('token-guard') && !r.text.includes('A = "1"'));
  check('toml: preserva as vizinhas', r.text.includes('[model]') && r.text.includes('[mcp_servers.outro]') && r.text.includes('command = "y"'));
  check('toml: sem a tabela devolve igual', removeTomlTable('[a]\nb=1\n', 'mcp_servers.token-guard').removed === false);
  const crlf = removeTomlTable(toml.replace(/\n/g, '\r\n'), 'mcp_servers.token-guard');
  check('toml: mantém CRLF', !/[^\r]\n/.test(crlf.text));
  const s = stripHooks([{ matcher: '*', hooks: [{ type: 'http', url: 'a' }, { type: 'command', command: 'z' }] }, { hooks: [{ type: 'http', url: 'a' }] }], (h) => h.url === 'a');
  check('stripHooks: entrada que esvazia sai; a que sobra fica', s.removed === 2 && s.entries.length === 1 && s.entries[0].hooks[0].command === 'z');
}

console.log('\n  dry-run e remoção real (todos os alvos)');
{
  const { home, repo } = fakeHome('all');
  const init = tg(home, repo, ['init', '--target', 'all']);
  check('init --target all no home falso', init.status === 0, init.stderr || init.stdout);

  const settings = path.join(home, '.claude', 'settings.json');
  const cfg = readJson(settings);
  cfg.hooks.PreToolUse = [...(cfg.hooks.PreToolUse || []), { matcher: 'Bash', hooks: [{ type: 'command', command: 'node C:/outro/token-guard-parecido/hook.js' }] }];
  cfg.theme = 'dark';
  fs.writeFileSync(settings, JSON.stringify(cfg, null, 2), 'utf8');
  const toml = path.join(home, '.codex', 'config.toml');
  if (fs.existsSync(toml)) fs.appendFileSync(toml, '\n[mcp_servers.alheio]\ncommand = "keep"\n', 'utf8');
  const tgDir = path.join(home, '.token-guard');
  fs.mkdirSync(tgDir, { recursive: true });
  fs.writeFileSync(path.join(tgDir, 'events.jsonl'), '{"t":1,"kind":"deny"}\n', 'utf8');
  fs.writeFileSync(path.join(tgDir, 'token-guard.config.json'), '{"mode":"warn"}', 'utf8');
  const claudeRuntime = path.join(home, '.claude', 'token-guard');
  fs.writeFileSync(path.join(home, '.claude', 'token-guard.config.json'), '{"mode":"warn"}', 'utf8');
  const legacy = readJson(settings);
  legacy.hooks.PostToolUse = [...(legacy.hooks.PostToolUse || []), { hooks: [{ type: 'command', command: 'node C:/Users/x/AppData/Roaming/token-guard/adapters/post-hook.cjs' }] }];
  fs.writeFileSync(settings, JSON.stringify(legacy, null, 2), 'utf8');

  const snap = () => ({ settings: read(settings), toml: fs.existsSync(toml) ? read(toml) : '', rt: fs.existsSync(claudeRuntime) });
  const before = snap();
  const dry = tg(home, repo, ['uninstall', '--dry-run']);
  check('dry-run sai 0 e anuncia a simulação', dry.status === 0 && /SIMULAÇÃO/.test(dry.stdout), dry.stdout + dry.stderr);
  check('dry-run lista settings e runtime', /removeria\s+.*settings\.json/.test(dry.stdout) && /removeria\s+.*\.claude[\\/]token-guard/.test(dry.stdout), dry.stdout);
  check('com a troca do daemon desligada (seam) o passo do daemon não aparece', !/encerrar o daemon/.test(dry.stdout));
  const dryDaemon = tg(home, repo, ['uninstall', '--dry-run'], { TOKEN_GUARD_NO_DAEMON_SWAP: '' });
  check('sem o seam, o dry-run anuncia que encerraria o daemon', /removeria\s+encerrar o daemon/.test(dryDaemon.stdout), dryDaemon.stdout);
  const after = snap();
  check('dry-run não altera nada', JSON.stringify(before) === JSON.stringify(after) && !fs.existsSync(settings + '.token-guard-uninstall.bak'));
  check('dry-run recusa opção desconhecida', tg(home, repo, ['uninstall', '--dryrun']).status === 1);

  const real = tg(home, repo, ['uninstall']);
  check('uninstall real sai 0', real.status === 0, real.stdout + real.stderr);
  const out = readJson(settings);
  const left = JSON.stringify(out);
  check('settings: hooks do token-guard saíram', !/127\.0\.0\.1:\d+\/token-guard|hook-origin=token-guard|\.claude\/token-guard\//.test(left.replace(/\\\\/g, '/')), left);
  check('settings: hook de terceiro e outras chaves ficam', left.includes('token-guard-parecido') && out.theme === 'dark');
  check('settings: cópia ao lado com o conteúdo anterior', read(settings + '.token-guard-uninstall.bak') === before.settings);
  check('hook de layout antigo (pasta token-guard/adapters fora do runtime atual) também sai', !JSON.stringify(out).includes('Roaming'), left);
  check('o aviso lista a config por harness que fica e a cópia com o token antigo', /preservado:.*\.claude[\\/]token-guard\.config\.json/.test(real.stdout) && /token antigo/.test(real.stdout), real.stdout);
  check('runtime do Claude removido', !fs.existsSync(claudeRuntime));
  check('runtimes dos outros harnesses removidos', !fs.existsSync(path.join(home, '.codex', 'token-guard')) && !fs.existsSync(path.join(home, '.cursor', 'token-guard')) && !fs.existsSync(path.join(home, '.copilot', 'extensions', 'token-guard')));
  if (fs.existsSync(toml)) {
    const t = read(toml);
    check('codex toml: tabela do token-guard saiu, a alheia ficou', !t.includes('mcp_servers.token-guard') && t.includes('[mcp_servers.alheio]'), t);
  }
  const cursorHooks = path.join(home, '.cursor', 'hooks.json');
  if (fs.existsSync(cursorHooks)) check('cursor hooks sem entradas do token-guard', !/token-guard/.test(read(cursorHooks)), read(cursorHooks));
  check('dados do usuário preservados', read(path.join(tgDir, 'events.jsonl')).includes('deny') && fs.existsSync(path.join(tgDir, 'token-guard.config.json')));
  check('estado do instalador removido', !fs.existsSync(path.join(tgDir, 'install-state.json')));

  const again = tg(home, repo, ['uninstall']);
  check('segunda rodada não acha nada', again.status === 0 && /nada do token-guard/.test(again.stdout), again.stdout);
}

console.log('\n  arquivo de configuração ilegível');
{
  const { home, repo } = fakeHome('bad');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, '{ quebrado', 'utf8');
  const r = tg(home, repo, ['uninstall']);
  check('JSON ilegível: falha alto (exit 1) e não toca o arquivo', r.status === 1 && /FALHOU/.test(r.stdout) && read(settings) === '{ quebrado', r.stdout);
}

console.log('\n  autostart POSIX (systemd) em home falso');
{
  const { home, repo } = fakeHome('sd');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(unitDir, { recursive: true });
  const unit = path.join(unitDir, 'token-guard-daemon.service');
  fs.writeFileSync(unit, '[Service]\nExecStart=node x\n', 'utf8');
  const env = { TOKEN_GUARD_FORCE_PLATFORM: 'linux' };
  const dry = tg(home, repo, ['uninstall', '--dry-run'], env);
  check('dry-run lista a unit e a mantém', /removeria\s+.*token-guard-daemon\.service/.test(dry.stdout) && fs.existsSync(unit), dry.stdout);
  const real = tg(home, repo, ['uninstall'], env);
  check('uninstall remove a unit', real.status === 0 && !fs.existsSync(unit), real.stdout + real.stderr);
}

console.log(`\n  ${pass} passaram, ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
