#!/usr/bin/env node
'use strict';
/**
 * status.test.cjs — `token-guard status` mostra o que o guard barrou e poupou (hoje e total),
 * lido de ~/.token-guard/events.jsonl, e diz quando ainda não há nada registrado.
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
  else { fail += 1; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}

const CLI = path.join(__dirname, '..', 'cli.cjs');

/** Roda `cli status` num HOME próprio com os eventos dados; devolve a saída. */
function statusWith(events, extraFiles = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-status-home-'));
  fs.mkdirSync(path.join(home, '.token-guard'), { recursive: true });
  if (events) fs.writeFileSync(path.join(home, '.token-guard', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  for (const [rel, body] of Object.entries(extraFiles)) fs.writeFileSync(path.join(home, rel), body);
  const r = spawnSync(process.execPath, [CLI, 'status', home], {
    cwd: home,
    env: { ...process.env, HOME: home, USERPROFILE: home, TOKEN_GUARD_UPDATE_CHECK: 'off' },
    encoding: 'utf8',
  });
  return { ...r, home };
}

const now = Date.now();
const twoDaysAgo = now - 2 * 86400000;
const EVENTS = [
  { t: twoDaysAgo, kind: 'deny', rule: 'blindRead', target: 'claude', tokens: null },
  { t: twoDaysAgo, kind: 'dup', rule: 'dupRead', target: 'claude', tokens: 1500000 },
  { t: now, kind: 'deny', rule: 'broadScan', target: 'copilot', tokens: null },
  { t: now, kind: 'trim', rule: 'bigResult', target: 'claude', tokens: 5000 },
];

console.log('\n  [bloqueios e tokens poupados]');
const r = statusWith(EVENTS);
check('status sai com código 0', r.status === 0, r.stderr);
check('barrados: hoje conta só os de hoje, total conta todos', /barrados:\s+hoje 1 · total 2 desde /.test(r.stdout), r.stdout);
check('barrados: diz a data do primeiro evento', r.stdout.includes(`desde ${new Date(twoDaysAgo).toLocaleDateString('pt-BR')}`), r.stdout);
check('tokens poupados: hoje ~5k, total ~1,5M', /tokens poupados: hoje ~5k · total ~1,5M/.test(r.stdout), r.stdout);

console.log('\n  [tokens poupados em US$, sempre aproximado]');
check('tabela padrão: tokens × entrada do primeiro modelo (opus-5-5, US$ 4/Mtok), com a conta e a fonte visíveis',
  r.stdout.includes('em US$ (aprox.): hoje ≈ US$ 0,02 · total ≈ US$ 6,02 — estimativa: tokens × US$ 4/Mtok (entrada de opus-5-5, tabela padrão)'), r.stdout);
const own = statusWith(EVENTS, { 'token-guard.config.json': JSON.stringify({ cost: { prices: { sonnet: { in: 2.5, out: 10 } } } }) });
check('cost.prices da config: usa o preço de entrada do primeiro modelo dela e diz que veio de cost.prices',
  own.stdout.includes('hoje ≈ US$ 0,01 · total ≈ US$ 3,76 — estimativa: tokens × US$ 2,5/Mtok (entrada de sonnet, cost.prices)'), own.stdout);
const noIn = statusWith(EVENTS, { 'token-guard.config.json': JSON.stringify({ cost: { prices: { sonnet: { out: 10 } } } }) });
check('primeiro modelo sem preço de entrada: diz que não há estimativa, sem inventar valor',
  /em US\$:\s+sem estimativa/.test(noIn.stdout) && !/≈ US\$/.test(noIn.stdout), noIn.stdout);

console.log('\n  [sem eventos]');
const empty = statusWith(null);
check('sem events.jsonl: diz que nada foi registrado ainda', /barrados:\s+nenhum registrado ainda/.test(empty.stdout) && !/tokens poupados:/.test(empty.stdout), empty.stdout);

console.log('');
console.log(`  status: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
