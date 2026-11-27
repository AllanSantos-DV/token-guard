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

console.log('\n  [status --json e a poupança na janela do cost]');
const js = (() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-status-json-'));
  fs.mkdirSync(path.join(home, '.token-guard'), { recursive: true });
  fs.writeFileSync(path.join(home, '.token-guard', 'events.jsonl'), EVENTS.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TOKEN_GUARD_UPDATE_CHECK: 'off' };
  const run = (script, args) => spawnSync(process.execPath, [path.join(__dirname, '..', script), ...args], { cwd: home, env, encoding: 'utf8' });
  return { status: run('cli.cjs', ['status', home, '--json']), cost: run('cost.cjs', ['--since', '1d', '--json', '--dir', path.join(home, 'vazio')]), home };
})();
let parsed = null;
try { parsed = JSON.parse(js.status.stdout); } catch { /* o check abaixo acusa */ }
check('status --json é JSON válido, sem texto solto', parsed !== null && js.status.status === 0, js.status.stdout.slice(0, 200) + js.status.stderr);
check('status --json traz modo, regras ativas e a pasta', parsed && parsed.mode === 'block' && parsed.rules.includes('broadScan') && parsed.root === js.home, JSON.stringify(parsed && { mode: parsed.mode, root: parsed.root }));
check('status --json traz os barrados e a poupança em US$ aproximado, com a conta', parsed && parsed.saved.total.blocks === 2 && parsed.saved.today.blocks === 1 && parsed.saved.usd.approximate === true
  && parsed.saved.usd.inPerMtok === 4 && Math.abs(parsed.saved.usd.total - 6.02) < 0.01, JSON.stringify(parsed && parsed.saved));
let costJson = null;
try { costJson = JSON.parse(js.cost.stdout); } catch { /* o check abaixo acusa */ }
check('cost --since 1d --json traz só o que o guard poupou nessa janela (o evento de 2 dias atrás fica fora)',
  costJson && costJson.saved.blocks === 1 && costJson.saved.tokensSaved === 5000 && costJson.saved.dups === 0, JSON.stringify(costJson && costJson.saved) + js.cost.stderr);

console.log('\n  [alvos instalados, lidos de install-state.json]');
const stateJson = JSON.stringify({ targets: ['codex', 'cursor'], commandHooks: false, version: '2.20.0' });
const withState = statusWith(null, { '.token-guard/install-state.json': stateJson });
check('texto: lista os alvos com hook gravado, na ordem do install-state', /alvos instalados:\s+codex, cursor/.test(withState.stdout), withState.stdout);
check('texto: as linhas existentes seguem (hook http e scout)', /hook http:/.test(withState.stdout) && /scout:/.test(withState.stdout), withState.stdout);
const withStateJson = (() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-status-targets-'));
  fs.mkdirSync(path.join(home, '.token-guard'), { recursive: true });
  fs.writeFileSync(path.join(home, '.token-guard', 'install-state.json'), stateJson);
  const run = spawnSync(process.execPath, [CLI, 'status', home, '--json'], { cwd: home, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TOKEN_GUARD_UPDATE_CHECK: 'off' } });
  try { return JSON.parse(run.stdout); } catch { return null; }
})();
check('--json: installedTargets traz a lista', withStateJson && JSON.stringify(withStateJson.installedTargets) === '["codex","cursor"]', JSON.stringify(withStateJson && withStateJson.installedTargets));
check('--json: as chaves existentes seguem (targets, daemon, scout)', withStateJson && 'targets' in withStateJson && 'daemon' in withStateJson && 'scout' in withStateJson);
const noState = statusWith(null);
check('sem install-state.json: a linha some, sem erro', noState.status === 0 && !/alvos instalados/.test(noState.stdout), noState.stdout);
const brokenState = statusWith(null, { '.token-guard/install-state.json': '{ não é json' });
check('install-state.json ilegível: a linha some, sem erro', brokenState.status === 0 && !/alvos instalados/.test(brokenState.stdout), brokenState.stdout + brokenState.stderr);
const noStateJson = (() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-status-notargets-'));
  const run = spawnSync(process.execPath, [CLI, 'status', home, '--json'], { cwd: home, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TOKEN_GUARD_UPDATE_CHECK: 'off' } });
  try { return JSON.parse(run.stdout); } catch { return null; }
})();
check('--json sem install-state.json: installedTargets é null', noStateJson && noStateJson.installedTargets === null, JSON.stringify(noStateJson && noStateJson.installedTargets));

console.log('\n  [últimos bloqueios]');
const mkDeny = (i, extra = {}) => ({ t: now - (20 - i) * 1000, kind: 'deny', rule: `regra${i}`, target: 'claude', tool: `Ferramenta${i}`, detail: `detalhe ${i}`, tokens: null, ...extra });
const BLOCKS = [1, 2, 3, 4, 5, 6, 7].map((i) => mkDeny(i));
const withTrim = [...BLOCKS, { t: now, kind: 'trim', rule: 'bigResult', target: 'claude', tool: 'Bash', detail: 'não é bloqueio', tokens: 5000 }];
const blocksJson = (events) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-status-blocks-'));
  fs.mkdirSync(path.join(home, '.token-guard'), { recursive: true });
  if (events) fs.writeFileSync(path.join(home, '.token-guard', 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const run = spawnSync(process.execPath, [CLI, 'status', home, '--json'], { cwd: home, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TOKEN_GUARD_UPDATE_CHECK: 'off' } });
  try { return JSON.parse(run.stdout); } catch { return null; }
};
const blocksTxt = statusWith(withTrim);
check('texto: seção "últimos bloqueios" com regra, ferramenta e detalhe do mais novo', /últimos bloqueios/.test(blocksTxt.stdout)
  && /regra7\b.*Ferramenta7.*detalhe 7/.test(blocksTxt.stdout), blocksTxt.stdout);
check('texto: só os 5 últimos bloqueios, do mais novo ao mais antigo; o mais velho fica de fora', /regra3\b/.test(blocksTxt.stdout) && !/regra2\b/.test(blocksTxt.stdout)
  && blocksTxt.stdout.indexOf('regra7') < blocksTxt.stdout.indexOf('regra3'), blocksTxt.stdout);
check('texto: evento que não é deny não entra na lista', !/não é bloqueio/.test(blocksTxt.stdout), blocksTxt.stdout);
check('texto: sem nenhum bloqueio, a seção é omitida', !/últimos bloqueios/.test(statusWith([{ t: now, kind: 'trim', rule: 'bigResult', target: 'claude', tokens: 5000 }]).stdout)
  && !/últimos bloqueios/.test(statusWith(null).stdout));
const bj = blocksJson(withTrim);
check('--json: recentBlocks traz os 5 últimos deny com rule, tool e detail, do mais novo ao mais antigo',
  bj && Array.isArray(bj.recentBlocks) && bj.recentBlocks.length === 5 && bj.recentBlocks.every((b) => b.kind === 'deny')
  && bj.recentBlocks[0].rule === 'regra7' && bj.recentBlocks[0].tool === 'Ferramenta7' && bj.recentBlocks[0].detail === 'detalhe 7' && bj.recentBlocks[4].rule === 'regra3',
  JSON.stringify(bj && bj.recentBlocks));
check('--json: sem eventos, recentBlocks é lista vazia', (() => { const j = blocksJson(null); return j && Array.isArray(j.recentBlocks) && j.recentBlocks.length === 0; })());

console.log('\n  [contrato de saída]');
const contractMd = '## sempre\n- regra a\n- regra b\n\n## quando: docs\n- regra c\n';
const contractTxt = statusWith(null, { 'contract.md': contractMd });
check('texto: linha "contrato" diz que está carregado e quantas regras há por gatilho', /contrato:\s+carregado.*sempre 2.*docs 1/.test(contractTxt.stdout), contractTxt.stdout);
const contractJson = (() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-status-contract-'));
  fs.writeFileSync(path.join(home, 'contract.md'), contractMd);
  const run = (extraEnv) => spawnSync(process.execPath, [CLI, 'status', home, '--json'], { cwd: home, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TOKEN_GUARD_UPDATE_CHECK: 'off', ...extraEnv } });
  const preload = path.join(home, 'preload.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'contract.cjs'))}).load = () => { throw new Error('contrato quebrado'); };\n`);
  return { ok: run({}), broken: run({ NODE_OPTIONS: `--require ${preload}` }) };
})();
const cj = (() => { try { return JSON.parse(contractJson.ok.stdout); } catch { return null; } })();
check('--json: contract {loaded, rules por gatilho}', cj && cj.contract && cj.contract.loaded === true && cj.contract.rules.sempre === 2 && cj.contract.rules.docs === 1, JSON.stringify(cj && cj.contract));
const brokenTxt = (() => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-status-contract-bad-'));
  const preload = path.join(home, 'preload.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'contract.cjs'))}).load = () => { throw new Error('contrato quebrado'); };\n`);
  return spawnSync(process.execPath, [CLI, 'status', home], { cwd: home, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, TOKEN_GUARD_UPDATE_CHECK: 'off', NODE_OPTIONS: `--require ${preload}` } }); })();
check('texto: falha ao ler o contrato não derruba o status e a linha diz que não pôde ler', brokenTxt.status === 0 && /contrato:\s+não foi possível ler.*contrato quebrado/.test(brokenTxt.stdout) && /ativo:/.test(brokenTxt.stdout), brokenTxt.stdout + brokenTxt.stderr);
const bjson = (() => { try { return JSON.parse(contractJson.broken.stdout); } catch { return null; } })();
check('--json: falha ao ler o contrato vira contract {loaded:false, error} e o resto segue', bjson && bjson.contract && bjson.contract.loaded === false && /contrato quebrado/.test(bjson.contract.error) && 'daemon' in bjson, contractJson.broken.stdout.slice(0, 300) + contractJson.broken.stderr);

console.log('\n  [sem eventos]');
const empty = statusWith(null);
check('sem events.jsonl: diz que nada foi registrado ainda', /barrados:\s+nenhum registrado ainda/.test(empty.stdout) && !/tokens poupados:/.test(empty.stdout), empty.stdout);

console.log('');
console.log(`  status: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
