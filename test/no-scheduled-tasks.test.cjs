#!/usr/bin/env node
'use strict';
/**
 * no-scheduled-tasks.test.cjs — o token-guard nunca cria tarefa agendada nem processo oculto sem pedido explícito.
 *
 * O instalador roda como processo filho com um preload que intercepta o child_process: nenhum comando do
 * sistema (schtasks, setx, systemctl, launchctl) executa de verdade; as chamadas ficam registradas.
 */

const { ISOLATED_HOME } = require('./bootstrap.cjs');

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'install.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); } else {
    fail += 1;
    console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

const WORK = fs.mkdtempSync(path.join(ISOLATED_HOME, 'tg-notasks-'));
const PRELOAD = path.join(__dirname, 'spy-system.cjs');
function runInstall({ platform, args = [], tasksExist = false }) {
  const logFile = path.join(WORK, `spy-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(logFile, '');
  const env = { ...process.env };
  delete env.TOKEN_GUARD_NO_AUTOSTART;
  env.TOKEN_GUARD_FORCE_PLATFORM = platform;
  env.SPY_LOG = logFile;
  env.SPY_TASKS_EXIST = tasksExist ? '1' : '0';
  env.NODE_OPTIONS = `--require ${PRELOAD.replace(/\\/g, '/')}`;
  const r = spawnSync(process.execPath, [INSTALL, '--target', 'claude', ...args], { encoding: 'utf8', env, timeout: 60000, windowsHide: true });
  const calls = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { r, calls };
}

const line = (c) => `${c.file} ${c.args.join(' ')}`;
const creates = (calls) => calls.filter((c) => /schtasks/i.test(c.file) && c.args.some((a) => /^\/create$/i.test(a)));

console.log('\n  [Windows, instalação padrão]');
{
  const { r, calls } = runInstall({ platform: 'win32' });
  check('instalador sai 0', r.status === 0, r.stderr || r.stdout);
  check('nenhuma tarefa agendada é criada', creates(calls).length === 0, calls.map(line).join(' | '));
  check('nenhum setx nem conhost --headless', !calls.some((c) => /setx|conhost/i.test(c.file) || c.args.some((a) => /headless/i.test(a))), calls.map(line).join(' | '));
}

console.log('\n  [Windows, tarefas deixadas por versões antigas]');
{
  const { calls } = runInstall({ platform: 'win32', tasksExist: true });
  const deletes = calls.filter((c) => /schtasks/i.test(c.file) && c.args.includes('/delete')).map((c) => c.args[c.args.indexOf('/tn') + 1]);
  check('o vigia e a tarefa de logon antigos são removidos', deletes.includes('TokenGuardDaemonWatch') && deletes.includes('TokenGuardDaemon'), deletes.join(','));
  check('remover não cria nada', creates(calls).length === 0);
}

console.log('\n  [Windows, --autostart explícito]');
{
  const { r, calls } = runInstall({ platform: 'win32', args: ['--autostart'] });
  const made = creates(calls);
  check('instalador sai 0', r.status === 0, r.stderr || r.stdout);
  check('só a tarefa de logon é criada', made.length === 1 && made[0].args.includes('TokenGuardDaemon'), made.map(line).join(' | '));
  check('nenhuma tarefa repetitiva (sem vigia)', !calls.some((c) => c.args.some((a) => /^minute$/i.test(a) || /Watch/.test(a))), calls.map(line).join(' | '));
}

console.log('\n  [macOS e Linux, instalação padrão]');
for (const platform of ['darwin', 'linux']) {
  const { r, calls } = runInstall({ platform });
  check(`${platform}: sai 0 sem chamar systemctl nem launchctl`, r.status === 0 && calls.length === 0, calls.map(line).join(' | ') || r.stderr);
  const plist = path.join(ISOLATED_HOME, 'Library', 'LaunchAgents', 'com.token-guard.daemon.plist');
  const unit = path.join(ISOLATED_HOME, '.config', 'systemd', 'user', 'token-guard-daemon.service');
  check(`${platform}: nenhuma unidade de autostart escrita`, !fs.existsSync(plist) && !fs.existsSync(unit));
}

console.log('\n  [macOS, --autostart não repete por intervalo]');
{
  runInstall({ platform: 'darwin', args: ['--autostart'] });
  const plist = path.join(ISOLATED_HOME, 'Library', 'LaunchAgents', 'com.token-guard.daemon.plist');
  check('o plist existe e não tem StartInterval', fs.existsSync(plist) && !/StartInterval/.test(fs.readFileSync(plist, 'utf8')));
}

console.log('\n  [código distribuído]');
{
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.git', 'test', 'tmp', 'bench', 'docs'].includes(e.name)) walk(p); } else if (/\.(cjs|mjs|js|cmd|ps1)$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
  const withSchtasks = files.filter((f) => /schtasks/i.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  check('só o instalador e o desinstalador falam com schtasks', withSchtasks.every((f) => ['install.cjs', 'lib/uninstall.cjs'].includes(f)), withSchtasks.join(','));
  const bad = files.map(rel).filter((f) => /(['"]minute['"]|StartInterval|DAEMON_WATCH_TASK_NAME)/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  check('nenhum agendamento repetitivo no código distribuído', bad.length === 0, bad.join(','));
  const headless = files.map(rel).filter((f) => /--headless/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  const TRAY = ['lib/tray.cjs', 'adapters/tray.ps1'];
  check('conhost --headless só no instalador (--autostart) e no ícone da bandeja que o usuário liga', headless.every((f) => f === 'install.cjs' || TRAY.includes(f)), headless.join(','));
  const inst = fs.readFileSync(INSTALL, 'utf8');
  check('o autostart só é chamado depois do portão --autostart', /if \(!AUTOSTART\) \{[\s\S]*?return;\s*\}\s*if \(plat === 'win32'\)/.test(inst));
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n  ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
