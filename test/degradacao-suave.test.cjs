#!/usr/bin/env node
'use strict';
/**
 * degradacao-suave.test.cjs — o token-guard diz quando está inativo e por quê, e nenhum hook depende de porta fixa.
 *
 * Invariantes:
 *   · `inspectCodex` acusa o hook mcp_tool do Codex sem o servidor MCP token-guard no config.toml;
 *   · `activity` resume daemon, hook http e Codex em `active` + motivo legível;
 *   · `status` (texto e --json) traz a linha "ativo" e `active`/`inactiveReason`, com daemon fora do ar;
 *   · o aviso de início de sessão cita o Codex quando o servidor MCP sumiu;
 *   · nenhum arquivo que vai no pacote grava porta literal de loopback nem `PORT || <número>`.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const DS = require('../lib/daemon-status.cjs');
const CLI = path.join(ROOT, 'cli.cjs');

const HOOKS_WITH_TG = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'mcp_tool', server: 'token-guard', tool: 'token_guard_hook' }] }] } };
const TOML_WITH_TG = '[mcp_servers.token-guard]\nurl = "http://127.0.0.1:45001/token-guard/mcp"\nhttp_headers = { "X-Token-Guard" = "t" }\n';

/** config.toml com o servidor MCP e a aprovação do Codex (hooks.state) para o hook na posição `slot` do hooks.json de `dir`. */
function trustedToml(dir, slot) {
  return `${TOML_WITH_TG}\n[hooks.state.'${path.join(dir, 'hooks.json')}:pre_tool_use:${slot}']\ntrusted_hash = "sha256:abc"\n`;
}

function codexHome(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-codex-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

console.log('\n  [inspectCodex]');
{
  const missing = DS.inspectCodex({ codexHome: codexHome({ 'hooks.json': JSON.stringify(HOOKS_WITH_TG), 'config.toml': '[mcp_servers.outro]\nurl = "http://127.0.0.1:1/x"\n' }), installed: true });
  check('hook sem servidor no config.toml: não está ok e o veredito nomeia o servidor', missing.ok === false && missing.hook === true && missing.server === false && /servidor MCP token-guard/.test(missing.verdict), missing);
  check('o veredito diz como corrigir', /init --target codex/.test(missing.verdict), missing.verdict);

  const healthyDir = codexHome({ 'hooks.json': JSON.stringify(HOOKS_WITH_TG) });
  fs.writeFileSync(path.join(healthyDir, 'config.toml'), trustedToml(healthyDir, '0:0'));
  const healthy = DS.inspectCodex({ codexHome: healthyDir, installed: true });
  check('hook, servidor e aprovação presentes: ok, com a porta registrada', healthy.ok === true && healthy.server === true && healthy.trusted === true && healthy.port === 45001, healthy);

  const shifted = { hooks: { PreToolUse: [{ matcher: 'x', hooks: [{ type: 'command', command: 'a' }] }, ...HOOKS_WITH_TG.hooks.PreToolUse] } };
  const shiftedDir = codexHome({ 'hooks.json': JSON.stringify(shifted) });
  fs.writeFileSync(path.join(shiftedDir, 'config.toml'), trustedToml(shiftedDir, '0:0'));
  const moved = DS.inspectCodex({ codexHome: shiftedDir, installed: true });
  check('outro hook inserido antes: a aprovação ficou na posição antiga, o hook não está aprovado', moved.ok === false && moved.trusted === false && moved.hook === true && moved.server === true, moved);
  check('o veredito explica a posição e manda aprovar em /hooks', /posição 1:0/.test(moved.verdict) && /\/hooks/.test(moved.verdict), moved.verdict);

  const noState = DS.inspectCodex({ codexHome: codexHome({ 'hooks.json': JSON.stringify(HOOKS_WITH_TG), 'config.toml': TOML_WITH_TG }), installed: true });
  check('servidor registrado mas sem hooks.state: não aprovado', noState.ok === false && noState.trusted === false && /não aprovou/.test(noState.verdict), noState);

  const noHook = DS.inspectCodex({ codexHome: codexHome({ 'hooks.json': '{}', 'config.toml': TOML_WITH_TG }), installed: true });
  check('Codex instalado sem o hook: não está ok e o veredito cita hooks.json', noHook.ok === false && /hooks\.json/.test(noHook.verdict), noHook);

  const absent = DS.inspectCodex({ codexHome: codexHome({}), installed: false });
  check('Codex não instalado: nada a reclamar', absent.ok === true && absent.installed === false, absent);

  const broken = DS.inspectCodex({ codexHome: codexHome({ 'hooks.json': '{ quebrado', 'config.toml': TOML_WITH_TG }), installed: true });
  check('hooks.json ilegível: não lança e não está ok', broken.ok === false && /hooks\.json/.test(broken.verdict), broken);
}

console.log('\n  [activity]');
{
  const up = { ipc: { ok: true }, http: { state: 'ok' }, verdict: 'hook http registrado e respondendo', settings: { ports: [1] } };
  const down = { ipc: { ok: false }, http: { state: 'down', detail: 'ECONNREFUSED' }, verdict: 'hook http registrado na 1, mas o daemon não atende (down)', settings: { ports: [1] } };
  const codexOk = { ok: true, installed: true, verdict: 'ok' };
  const codexUntrusted = { ok: false, installed: true, trusted: false, verdict: 'o Codex não aprovou o hook do token-guard' };
  const codexBad = { ok: false, installed: true, verdict: 'o hook do Codex chama o servidor MCP token-guard, que não está no config.toml' };

  const a1 = DS.activity({ daemon: up, codex: codexOk, targets: ['claude', 'codex'] });
  check('tudo de pé: ativo, sem motivo', a1.active === true && a1.reason === null, a1);
  const a2 = DS.activity({ daemon: down, codex: codexOk, targets: ['claude'] });
  check('daemon fora do ar: inativo, o motivo nomeia o daemon', a2.active === false && /daemon/.test(a2.reason), a2);
  const a3 = DS.activity({ daemon: up, codex: codexBad, targets: ['claude', 'codex'] });
  check('Codex sem servidor: inativo, o motivo é o do Codex', a3.active === false && /servidor MCP token-guard/.test(a3.reason), a3);
  const a3b = DS.activity({ daemon: up, codex: codexUntrusted, targets: ['codex'] });
  check('Codex sem aprovação: inativo, o motivo é a aprovação', a3b.active === false && /não aprovou/.test(a3b.reason), a3b);
  const a4 = DS.activity({ daemon: up, codex: codexBad, targets: ['claude'] });
  check('Codex fora dos alvos instalados: o problema dele não derruba o resumo', a4.active === true, a4);
  const a5 = DS.activity({ daemon: { ...up, verdict: 'settings aponta para 2 mas o daemon usa 1: reabra a sessão ou rode init' }, codex: codexOk, targets: ['claude'] });
  check('settings apontando para outra porta: inativo com o veredito do hook http', a5.active === false && /settings aponta/.test(a5.reason), a5);
}

console.log('\n  [status com o daemon fora do ar]');
function statusIn(home, extra) {
  return spawnSync(process.execPath, [CLI, 'status', home, ...extra], {
    cwd: home, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), TOKEN_GUARD_UPDATE_CHECK: 'off' },
  });
}
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-soft-home-'));
  fs.mkdirSync(path.join(home, '.token-guard'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.token-guard', 'install-state.json'), JSON.stringify({ targets: ['claude', 'codex'], commandHooks: false }));
  fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify(HOOKS_WITH_TG));
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.outro]\nurl = "http://127.0.0.1:1/x"\n');

  const text = statusIn(home, []);
  check('texto: linha "ativo: não" com o motivo', text.status === 0 && /ativo:\s+não — /.test(text.stdout), text.stdout + text.stderr);
  check('texto: linha do Codex diz que o servidor MCP sumiu', /codex \(mcp\):.*servidor MCP token-guard/.test(text.stdout), text.stdout);

  const j = statusIn(home, ['--json']);
  let o = null;
  try { o = JSON.parse(j.stdout); } catch { /* checado abaixo */ }
  check('--json: active false e inactiveReason em texto', o && o.active === false && typeof o.inactiveReason === 'string' && o.inactiveReason.length > 10, o && { active: o.active, reason: o.inactiveReason });
  check('--json: bloco codex com server false', o && o.codex && o.codex.server === false && o.codex.hook === true, o && o.codex);
  check('--json: as chaves de antes seguem (daemon, scout, installedTargets)', o && o.daemon && o.scout && Array.isArray(o.installedTargets), o && Object.keys(o));
}

console.log('\n  [aviso de início de sessão]');
{
  const SS = require('../adapters/session-start.cjs');
  const home = codexHome({ 'hooks.json': JSON.stringify(HOOKS_WITH_TG), 'config.toml': '' });
  const msg = SS.codexNotice({ codexHome: home, installed: true });
  check('Codex sem servidor MCP: o aviso nomeia o Codex e a correção', typeof msg === 'string' && /Codex/.test(msg) && /init --target codex/.test(msg), msg);
  const quietDir = codexHome({ 'hooks.json': JSON.stringify(HOOKS_WITH_TG) });
  fs.writeFileSync(path.join(quietDir, 'config.toml'), trustedToml(quietDir, '0:0'));
  const quiet = SS.codexNotice({ codexHome: quietDir, installed: true });
  check('Codex em ordem: nenhum aviso', quiet === null, quiet);
  const notInstalled = SS.codexNotice({ codexHome: codexHome({}), installed: false });
  check('Codex não instalado: nenhum aviso', notInstalled === null, notInstalled);
}

console.log('\n  [perfil limpo: o instalador não grava porta de daemon que não existe]');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-clean-home-'));
  const run = spawnSync(process.execPath, [path.join(ROOT, 'install.cjs'), '--target', 'claude,codex'], {
    cwd: home, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), TOKEN_GUARD_NO_AUTOSTART: '1', TOKEN_GUARD_NO_DAEMON_SWAP: '1', TOKEN_GUARD_UPDATE_CHECK: 'off' },
  });
  let urls = [];
  try {
    const s = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    urls = Object.values(s.hooks).flat().flatMap((e) => e.hooks).filter((h) => h.type === 'http').map((h) => h.url);
  } catch { /* checado abaixo */ }
  check('perfil limpo: instalou sem erro', run.status === 0, run.stdout.slice(-300) + run.stderr.slice(-300));
  check('perfil limpo: os hooks http declaram a origem e o arquivo de porta, na porta 0 até o daemon subir',
    urls.length === 3 && urls.every((u) => /:0\/token-guard\/(pre|post|prompt)\?hook-origin=token-guard&port-file=~\/\.token-guard\/daemon-http\.json$/.test(u)), urls);
  const toml = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  check('perfil limpo: o servidor MCP do Codex também nasce na porta 0, reapontada pelo daemon', /\[mcp_servers\.token-guard\][^[]*url = "http:\/\/127\.0\.0\.1:0\/token-guard\/mcp"/.test(toml), toml.slice(0, 300));
  const st = statusIn(home, ['--json']);
  let o = null;
  try { o = JSON.parse(st.stdout); } catch { /* checado abaixo */ }
  check('perfil limpo sem daemon: status diz inativo, não falha', st.status === 0 && o && o.active === false && /daemon/.test(o.inactiveReason), o && { a: o.active, r: o.inactiveReason });
  check('perfil limpo: o Codex tem hook e servidor, e a aprovação do dono é a única coisa que falta', o && o.codex && o.codex.hook === true && o.codex.server === true && o.codex.trusted === false && o.codex.ok === false, o && o.codex);
}

console.log('\n  [nenhuma porta fixa no que vai no pacote]');
{
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files
    .filter((f) => !f.startsWith('!') && !/^(test|docs|bench)\/?$/.test(f) && !/\.md$/.test(f));
  const hits = [];
  const scan = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      if (/(?:127\.0\.0\.1|localhost|\[::1\]):\d{2,5}\b/.test(line) || /\bPORT\b[^\n]*\|\|\s*['"]?\d{3,5}\b/.test(line) || /\?\?\s*['"]?\d{4,5}\b[^\n]*port/i.test(line)) {
        hits.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  };
  const walk = (p) => {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) return;
    if (fs.statSync(full).isDirectory()) fs.readdirSync(full).forEach((n) => walk(path.join(p, n)));
    else if (/\.(cjs|mjs|js|json|ps1|sh)$/.test(full)) scan(full);
  };
  shipped.forEach(walk);
  check('lib, adapters, entradas e manifestos: nenhuma porta literal de loopback nem PORT || número', hits.length === 0, hits.slice(0, 5));
}

console.log('');
console.log(`  degradacao-suave: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
