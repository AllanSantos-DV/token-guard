#!/usr/bin/env node
'use strict';
/**
 * tray.test.cjs — o ícone da bandeja, sem abrir nenhum ícone nem janela.
 *
 * Garantias:
 *   · só sobe no Windows, com `ui.tray` ligado e sem TOKEN_GUARD_TRAY=off;
 *   · sobe oculto (conhost --headless, windowsHide) e desanexado do daemon;
 *   · o script parseia no PowerShell 5.1 e desenha um ícone DIFERENTE por estado (pixels reais, em arquivo);
 *   · o script lê o estado por fluxo (SSE), não por consulta em laço.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const TRAY = require('../lib/tray.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
}

console.log('\n  [quando o ícone sobe]');
{
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  const saved = process.env.TOKEN_GUARD_TRAY;

  check('o teste roda com a bandeja desligada por ambiente (bootstrap)', TRAY.disabledByEnv());
  check('TOKEN_GUARD_TRAY=off: não sobe', TRAY.ensure({ platform: 'win32', spawnFn, cfg: { ui: { tray: true } } }).skipped === 'TOKEN_GUARD_TRAY=off' && !calls.length);

  delete process.env.TOKEN_GUARD_TRAY;
  check('fora do Windows: não sobe', /só existe no Windows/.test(TRAY.ensure({ platform: 'linux', spawnFn, cfg: { ui: { tray: true } } }).skipped) && !calls.length);
  check('ui.tray desligado na config: não sobe', /ui\.tray/.test(TRAY.ensure({ platform: 'win32', spawnFn, cfg: { ui: { tray: false } } }).skipped) && !calls.length);
  const r = TRAY.ensure({ platform: 'win32', spawnFn, cfg: { ui: { tray: true } } });
  check('Windows + ligado: sobe', r.started === true && calls.length === 1, r);
  const c = calls[0] || { args: [], opts: {} };
  check('sobe sob conhost --headless (nunca pisca console)', c.cmd === 'conhost.exe' && c.args[0] === '--headless' && c.args[1] === 'powershell.exe', c);
  check('sem janela, desanexado, no script da bandeja', c.opts.windowsHide === true && c.opts.detached === true && c.opts.stdio[0] === 'pipe' && c.args.includes(TRAY.SCRIPT) && c.args.includes('-STA'));
  const boom = TRAY.ensure({ platform: 'win32', cfg: { ui: { tray: true } }, spawnFn: () => { throw new Error('sem powershell'); } });
  check('falha ao subir vira motivo legível, não exceção (fail-open)', boom.started === false && boom.reason === 'sem powershell', boom);

  if (saved === undefined) delete process.env.TOKEN_GUARD_TRAY; else process.env.TOKEN_GUARD_TRAY = saved;
  process.env.TOKEN_GUARD_TRAY = 'off';
}

console.log('\n  [o script da bandeja]');
const src = fs.readFileSync(TRAY.SCRIPT, 'utf8');
check('o script tem BOM UTF-8 (o PowerShell 5.1 lê acentos certo)', src.charCodeAt(0) === 0xFEFF);
check('estado por fluxo SSE com o token do dono', /\/token-guard\/stream/.test(src) && /X-Token-Guard/.test(src));
check('sem consulta de rede em laço no formulário: o timer só lê a tabela local', !/Invoke-(WebRequest|RestMethod)/.test(src) && /\$shared\.dirty/.test(src));
check('uma instância por usuário (mutex)', /System\.Threading\.Mutex/.test(src) && /Local\\TokenGuardTray/.test(src));
check('abre a tela por bilhete, nunca com o token na URL', /ui\/ticket/.test(src) && !/ticket=\$\(\$ep\.token/.test(src));

if (process.platform === 'win32') {
  const ps = (args) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const parse = ps(['-Command', `$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('${TRAY.SCRIPT.replace(/'/g, "''")}',[ref]$null,[ref]$e);if($e.Count){$e|ForEach-Object{$_.Message};exit 1}`]);
  check('o script parseia no PowerShell 5.1', parse.status === 0, parse.stdout + parse.stderr);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tray-icons-'));
  const dump = ps(['-File', TRAY.SCRIPT, '-DumpIcons', dir]);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  check('-DumpIcons grava os 4 estados em 2 tamanhos e sai 0, sem abrir ícone', dump.status === 0 && files.length === 8, { status: dump.status, files, err: dump.stderr });
  const hash = (s, px) => crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, `tray-${s}-${px}.png`))).digest('hex');
  const hashes = ['on', 'partial', 'off', 'down'].map((s) => hash(s, 128));
  check('cada estado desenha um ícone diferente', new Set(hashes).size === 4);
  check('os PNGs são imagens de verdade', files.every((f) => fs.readFileSync(path.join(dir, f)).slice(1, 4).toString() === 'PNG'));
  fs.rmSync(dir, { recursive: true, force: true });
} else {
  console.log('  (pulado fora do Windows: parser e ícones do PowerShell)');
}

console.log(`\n  ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
