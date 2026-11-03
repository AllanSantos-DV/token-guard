#!/usr/bin/env node
'use strict';
/**
 * hook-origin.test.cjs — todo hook de COMANDO que o token-guard instala declara
 * `--hook-origin=token-guard` no fim da linha; entrada antiga (sem assinatura) é
 * assinada no lugar, sem duplicar, e reinstalar não muda mais nada.
 *
 * Home falso + FORCE_PLATFORM=linux: nada toca a máquina real (sem setx/schtasks).
 */

require('./bootstrap.cjs');

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALL = path.join(__dirname, '..', 'install.cjs');
const SIGN = ' --hook-origin=token-guard';
const SIGNED_END = /^node ".+\.cjs" --hook-origin=token-guard$/;

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ok    ${label}`);
  else { fail += 1; console.log(`  FALHA ${label}${detail !== undefined ? `\n        ${detail}` : ''}`); }
}

function mkhome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-origin-home-')); }
function mkrepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-origin-repo-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true }), 'utf8');
  return dir;
}
function run(home, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(home|userprofile)$/i.test(k)));
  return spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...env, HOME: home, USERPROFILE: home, TOKEN_GUARD_FORCE_PLATFORM: 'linux' },
  });
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const cmdsOf = (entries) => (entries || []).flatMap((e) => (Array.isArray(e.hooks) ? e.hooks : [e]))
  .map((h) => h.command).filter((c) => typeof c === 'string' && c.includes('token-guard'));
const countOrigin = (c) => (c.match(/--hook-origin=/g) || []).length;

console.log('\n  [claude · http] SessionStart e SubagentStart assinados');
{
  const home = mkhome(); const repo = mkrepo();
  const r = run(home, ['--target', 'claude', repo]);
  check('instalação sai 0', r.status === 0, r.stderr);
  const s = readJson(path.join(home, '.claude', 'settings.json'));
  for (const ev of ['SessionStart', 'SubagentStart']) {
    const c = cmdsOf(s.hooks[ev]);
    check(`${ev}: exatamente 1 comando, assinado no fim`, c.length === 1 && SIGNED_END.test(c[0]), JSON.stringify(c));
  }
  const again = run(home, ['--target', 'claude', repo]);
  check('reinstalar não altera nada (idempotente)', again.status === 0 && !/update|create/.test(again.stdout.split('\n').filter((l) => /settings\.json/.test(l)).join('')), again.stdout);
  const s2 = readJson(path.join(home, '.claude', 'settings.json'));
  check('settings idêntico após a segunda instalação', JSON.stringify(s2) === JSON.stringify(s));
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
}

console.log('\n  [claude · comando] novo assinado, antigo migrado sem duplicar');
{
  const home = mkhome(); const repo = mkrepo();
  const adapters = path.join(home, '.claude', 'token-guard', 'adapters').replace(/\\/g, '/');
  // 1ª instalação para o runtime existir (entradas "vivas"); depois volta ao formato antigo, sem assinatura.
  run(home, ['--target', 'claude', '--command-hooks', repo]);
  const file = path.join(home, '.claude', 'settings.json');
  const s = readJson(file);
  const events = { PreToolUse: 'hook-cmd', PostToolUse: 'post-hook', UserPromptSubmit: 'prompt-hook' };
  for (const [ev, script] of Object.entries(events)) {
    const c = cmdsOf(s.hooks[ev]);
    check(`${ev}: novo comando assinado (1 só)`, c.length === 1 && SIGNED_END.test(c[0]) && c[0].includes(`${script}.cjs`), JSON.stringify(c));
  }
  // Rebaixa para o layout antigo: mesma entrada viva, sem a assinatura; mais um forasteiro.
  s.hooks.PreToolUse.push({ hooks: [{ type: 'command', command: 'node "C:/outro/guardiao.cjs"' }] });
  for (const ev of Object.keys(events)) {
    for (const e of s.hooks[ev]) for (const h of e.hooks || []) if (h.command.includes('token-guard')) h.command = h.command.replace(SIGN, '');
  }
  fs.writeFileSync(file, JSON.stringify(s), 'utf8');
  check('pré-condição: entradas sem assinatura', Object.keys(events).every((ev) => cmdsOf(readJson(file).hooks[ev]).every((c) => !c.includes('hook-origin'))));

  const r = run(home, ['--target', 'claude', '--command-hooks', repo]);
  check('migração sai 0 e anuncia a assinatura', r.status === 0 && /origem assinada/.test(r.stdout), r.stdout + r.stderr);
  const m = readJson(file);
  for (const ev of Object.keys(events)) {
    const c = cmdsOf(m.hooks[ev]);
    check(`${ev}: migrado, ainda 1 entrada do token-guard e 1 assinatura`, c.length === 1 && SIGNED_END.test(c[0]) && countOrigin(c[0]) === 1, JSON.stringify(c));
  }
  check('forasteiro preservado e sem assinatura', JSON.stringify(m.hooks.PreToolUse).includes('guardiao.cjs') &&
    !JSON.stringify(m.hooks.PreToolUse).includes('guardiao.cjs" --hook-origin'));
  const before = JSON.stringify(m);
  run(home, ['--target', 'claude', '--command-hooks', repo]);
  check('terceira instalação não muda nada', JSON.stringify(readJson(file)) === before);
  check('adapters existem onde o comando aponta', fs.existsSync(path.join(adapters, 'hook-cmd.cjs')));
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
}

console.log('\n  [cursor] assinado e migrado');
{
  const home = mkhome(); const repo = mkrepo();
  run(home, ['--target', 'cursor', repo]);
  const file = path.join(home, '.cursor', 'hooks.json');
  const h = readJson(file);
  const evs = Object.keys(h.hooks);
  check('4 eventos, todos assinados', evs.length === 4 && evs.every((e) => cmdsOf(h.hooks[e]).length === 1 && SIGNED_END.test(cmdsOf(h.hooks[e])[0])), JSON.stringify(h));
  for (const e of evs) h.hooks[e][0].command = h.hooks[e][0].command.replace(SIGN, '');
  fs.writeFileSync(file, JSON.stringify(h), 'utf8');
  run(home, ['--target', 'cursor', repo]);
  const m = readJson(file);
  check('migrado sem duplicar', evs.every((e) => m.hooks[e].length === 1 && SIGNED_END.test(m.hooks[e][0].command)), JSON.stringify(m));
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
}

console.log('\n  [repo] assinado e migrado');
{
  const home = mkhome(); const repo = mkrepo();
  run(home, ['--target', 'repo', repo]);
  const file = path.join(repo, '.github', 'hooks', 'hooks.json');
  const h = readJson(file);
  check('shim assinado', h.hooks.PreToolUse.length === 1 && h.hooks.PreToolUse[0].command === `node .github/token-guard/token-guard.cjs${SIGN}`, JSON.stringify(h));
  h.hooks.PreToolUse[0].command = 'node .github/token-guard/token-guard.cjs';
  fs.writeFileSync(file, JSON.stringify(h), 'utf8');
  run(home, ['--target', 'repo', repo]);
  const m = readJson(file);
  check('migrado sem duplicar', m.hooks.PreToolUse.length === 1 && m.hooks.PreToolUse[0].command === `node .github/token-guard/token-guard.cjs${SIGN}`, JSON.stringify(m));
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
}

console.log('\n  [hooks.json do pacote] template assinado e igual ao shim do instalador');
{
  const shipped = readJson(path.join(__dirname, '..', 'hooks.json')).hooks.PreToolUse;
  check('hooks.json do pacote: 1 comando, assinado',
    shipped.length === 1 && shipped[0].command === `node .github/token-guard/token-guard.cjs${SIGN}`, JSON.stringify(shipped));
}

console.log('\n  [autostart] o teste nunca grava setx/tarefa agendada da máquina');
{
  const home = mkhome(); const repo = mkrepo();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(home|userprofile|token_guard_force_platform)$/i.test(k)));
  const r = spawnSync(process.execPath, [INSTALL, '--target', 'claude', repo], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...env, HOME: home, USERPROFILE: home },
  });
  check('com TOKEN_GUARD_NO_AUTOSTART=1 o autostart é pulado e anunciado',
    r.status === 0 && process.env.TOKEN_GUARD_NO_AUTOSTART === '1' && /autostart do daemon \(TOKEN_GUARD_NO_AUTOSTART=1\)/.test(r.stdout) && !/TokenGuardDaemon|setx/.test(r.stdout), r.stdout + r.stderr);
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true });
}

console.log('');
console.log(fail ? `  ${fail} falharam` : '  hook-origin: tudo ok');
process.exit(fail ? 1 : 0);
