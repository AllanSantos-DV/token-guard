#!/usr/bin/env node
'use strict';
/**
 * install.test.cjs — o instalador contra o sistema de arquivos real.
 *
 * Três garantias que só um teste de integração prova:
 *   1. Idempotência: rodar de novo não duplica registro.
 *   2. Reparo: registro apontando para script morto é reinstalado, nunca
 *      mascarado como "já registrado" (o guard ficaria desligado em silêncio).
 *   3. Preservação: agente/skill personalizados pelo usuário sobrevivem à
 *      reinstalação; e a config global escrita no home do alvo É lida depois.
 *
 * Node puro, sem framework. O instalador roda como processo filho com
 * HOME/USERPROFILE redirecionados para um home falso — nada toca a máquina real.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const ROOT = path.join(HERE, '..');
const INSTALL = path.join(ROOT, 'install.cjs');

let pass = 0;
let fail = 0;

function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function mkrepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tg-inst-${name}-`));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, private: true }), 'utf8');
  return dir;
}

function runInstall(args, envExtra) {
  return spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...(envExtra || {}) },
    timeout: 60000,
  });
}

console.log('\n  [repo] idempotência e reparo');
{
  const repo = mkrepo('repo');

  const first = runInstall(['--target', 'repo', repo]);
  check('primeira instalação sai 0', first.status === 0, first.stderr);
  const hooksFile = path.join(repo, '.github', 'hooks', 'hooks.json');
  check('hooks.json criado com o shim', fs.existsSync(hooksFile) &&
    /token-guard\.cjs/.test(fs.readFileSync(hooksFile, 'utf8')));

  const second = runInstall(['--target', 'repo', repo]);
  check('segunda instalação é idempotente',
    second.status === 0 && second.stdout.includes('ja registrado'), second.stdout);

  // Registro obsoleto: comando aponta para script que não existe mais.
  const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const entry = hooks.hooks.PreToolUse.find((h) => String(h.command).includes('token-guard'));
  entry.command = 'node .github/token-guard/token-guard-GONE.cjs';
  fs.rmSync(path.join(repo, '.github', 'token-guard'), { recursive: true, force: true });
  fs.writeFileSync(hooksFile, JSON.stringify(hooks, null, 2));

  const third = runInstall(['--target', 'repo', repo]);
  const repaired = third.status === 0 && /obsoleto reparado/i.test(third.stdout);
  const hooksAfter = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  const cmds = hooksAfter.hooks.PreToolUse.map((h) => h.command).filter((c) => c.includes('token-guard'));
  check('registro obsoleto é reparado, não mascarado', repaired && cmds.length >= 1,
    third.stdout);
  check('shim reparado existe no disco',
    fs.existsSync(path.join(repo, '.github', 'token-guard', 'token-guard.cjs')) &&
    cmds.every((c) => !c.includes('GONE')), cmds.join(' | '));

  fs.rmSync(repo, { recursive: true, force: true });
}

console.log('\n  [máquina] preservação de assets do usuário');
{
  const repo = mkrepo('host');   // cwd irrelevante para alvo de máquina
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-'));
  const FAKE_ENV = { HOME: home, USERPROFILE: home };

  // Personalização prévia do usuário num home já "instalado".
  const agentPath = path.join(home, '.claude', 'token-guard', 'agents', 'scout.agent.md');
  fs.mkdirSync(path.dirname(agentPath), { recursive: true });
  fs.writeFileSync(agentPath, '# minha versão personalizada do scout\n', 'utf8');

  // Registros obsoletos dos TRÊS eventos (layout antigo, script morto) +
  // uma entrada FORASTEIRA (sem "token-guard" no comando), que deve ser
  // preservada intacta — o instalador só mexe no que é dele.
  const settingsPath = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'node "C:/tg-v1/dead/token-guard-hook.cjs"' }] },
        { hooks: [{ type: 'command', command: 'node "C:/outro-projeto/meu-guardiao.cjs"' }] },
      ],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'node "C:/tg-v1/dead/token-guard-post.cjs"' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "C:/tg-v1/dead/token-guard-prompt.cjs"' }] }],
    },
  }), 'utf8');

  const r = runInstall(['--target', 'claude', '--mode', 'warn', repo], FAKE_ENV);
  check('instalação claude em home falso sai 0', r.status === 0, r.stderr);
  check('agente personalizado é PRESERVADO na reinstalação',
    fs.readFileSync(agentPath, 'utf8').includes('personalizada'),
    fs.readFileSync(agentPath, 'utf8'));

  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const countTg = (entries) => (entries || [])
    .filter((e) => JSON.stringify(e).includes('token-guard')).length;
  check('PreToolUse: obsoleto reparado, exatamente 1 entrada viva',
    countTg(after.hooks.PreToolUse) === 1 &&
    !JSON.stringify(after.hooks.PreToolUse).includes('dead'),
    JSON.stringify(after.hooks.PreToolUse));
  check('PostToolUse: obsoleto reparado, exatamente 1 entrada viva',
    countTg(after.hooks.PostToolUse) === 1 &&
    !JSON.stringify(after.hooks.PostToolUse).includes('dead'),
    JSON.stringify(after.hooks.PostToolUse));
  check('UserPromptSubmit: obsoleto reparado, exatamente 1 entrada viva',
    countTg(after.hooks.UserPromptSubmit) === 1 &&
    !JSON.stringify(after.hooks.UserPromptSubmit).includes('dead'),
    JSON.stringify(after.hooks.UserPromptSubmit));
  check('entrada forasteira (sem token-guard) é preservada',
    JSON.stringify(after.hooks.PreToolUse).includes('meu-guardiao.cjs'));

  /* liveOther: registro VIVO em layout antigo não pode coexistir com o novo
     (dois guards disparando por evento, para sempre). */
  const liveOld = path.join(home, 'legacy', 'token-guard', 'hook-cmd.cjs');
  fs.mkdirSync(path.dirname(liveOld), { recursive: true });
  fs.writeFileSync(liveOld, '// v1 ainda vivo\n');
  const s2 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  s2.hooks.PreToolUse.push({ matcher: 'Read|Grep|Bash',
    hooks: [{ type: 'command', command: `node "${liveOld.replace(/\\/g, '/')}"`, timeout: 10 }] });
  // dedup hooks[1]: canônico vivo escondido depois de um hook forasteiro
  s2.hooks.PostToolUse = [{ hooks: [
    { type: 'command', command: 'node "C:/outro/pacote.cjs"' },
    { type: 'command', command: `node "${path.join(home, '.claude', 'token-guard', 'adapters', 'post-hook.cjs').replace(/\\/g, '/')}"` },
  ] }];
  fs.writeFileSync(settingsPath, JSON.stringify(s2));

  runInstall(['--target', 'claude', '--mode', 'warn', repo], FAKE_ENV);
  const s3 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const tgPre3 = s3.hooks.PreToolUse.filter((e) => JSON.stringify(e).includes('token-guard'));
  check('liveOther: layout antigo vivo é SUBSTITUÍDO, não duplicado',
    tgPre3.length === 1 && !JSON.stringify(tgPre3).includes('legacy'),
    JSON.stringify(tgPre3));
  check('matcher drift é atualizado para a cobertura atual',
    tgPre3[0]?.matcher === 'Read|Grep|Glob|Bash|LS|NotebookRead|Search',
    tgPre3[0]?.matcher);
  const tgPost3 = s3.hooks.PostToolUse.filter((e) => JSON.stringify(e).includes('token-guard'));
  check('dedup enxerga TODOS os hooks da entrada (não só hooks[0])',
    tgPost3.length === 1,
    JSON.stringify(s3.hooks.PostToolUse));

  // A config global gravada no home do ALVO tem que ser lida pelo loader.
  const cfgWritten = path.join(home, '.claude', 'token-guard.config.json');
  check('--mode warn grava config no home do alvo',
    fs.existsSync(cfgWritten) && JSON.parse(fs.readFileSync(cfgWritten, 'utf8')).mode === 'warn');

  const emptyRepo = mkrepo('empty');
  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete require.cache[require.resolve(path.join(ROOT, 'lib', 'config.cjs'))];
  const CFG = require(path.join(ROOT, 'lib', 'config.cjs'));
  const loaded = CFG.load(emptyRepo);
  process.env.HOME = prevHome;
  process.env.USERPROFILE = prevProfile;
  check('loader lê a config global do home do alvo (~/.claude)',
    loaded.mode === 'warn' && /\.claude/.test(loaded._source),
    `mode=${loaded.mode} source=${loaded._source}`);

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(emptyRepo, { recursive: true, force: true });
}

console.log('');
console.log(`  ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
