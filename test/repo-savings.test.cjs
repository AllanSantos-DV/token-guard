#!/usr/bin/env node
'use strict';
/**
 * repo-savings.test.cjs — poupança por repositório: o evento grava a raiz do repositório, a soma
 * por repositório só conta eventos novos (o histórico sem raiz não é repartido), `status` mostra
 * a linha do repositório atual e a tela traz o cartão com a explicação.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const EV = require('../lib/events.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); } else { fail += 1; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reposav-'));
const mk = (name) => {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  return root;
};
const A = mk('alfa');
const B = mk('beta');
const cwdA = path.join(A, 'src', 'deep');

console.log('\n  [o evento grava a raiz do repositório]');
const e1 = EV.record({ kind: 'trim', rule: 'bigResult', target: 'claude', tokens: 3000, root: cwdA });
check('subpasta vira a raiz do repositório (a mesma regra do custo)', e1 && e1.root === A, JSON.stringify(e1));
const e2 = EV.record({ kind: 'deny', rule: 'broadScan', target: 'claude', root: B });
check('raiz já normalizada passa igual', e2 && e2.root === B);
const e3 = EV.record({ kind: 'deny', rule: 'blindRead', target: 'claude' });
check('sem pasta, o evento não ganha raiz inventada', e3 && !('root' in e3));
const e4 = EV.recordDeny({ rule: 'shellDump' }, 'claude', { cwd: cwdA, tool_name: 'Bash', tool_input: { command: 'cat x' } });
check('recordDeny usa o cwd do payload, nunca o do processo', e4 && e4.root === A, JSON.stringify(e4));
const e5 = EV.recordDeny({ rule: 'shellDump' }, 'claude', { tool_name: 'Bash', tool_input: { command: 'cat x' } }, B);
check('recordDeny prefere a raiz explícita', e5 && e5.root === B);

console.log('\n  [soma por repositório e histórico sem raiz]');
fs.appendFileSync(EV.eventsPath(), JSON.stringify({ t: Date.now() - 1000, kind: 'trim', rule: 'bigResult', target: 'claude', tool: '', detail: '', tokens: 9000 }) + '\n');
const { repos, noRepo } = EV.byRepo();
const a = repos.find((r) => r.root === A);
const b = repos.find((r) => r.root === B);
check('alfa soma o trim medido e o deny; beta soma os dois denys', a && a.tokensSaved === 3000 && a.trims === 1 && a.blocks === 1 && b && b.blocks === 2 && b.tokensSaved === 0, JSON.stringify(repos));
check('ordem: quem mais poupou vem primeiro', repos[0].root === A);
check('evento antigo sem raiz fica em noRepo e não é repartido', noRepo.tokensSaved === 9000 && noRepo.trims === 1 && repos.every((r) => r.tokensSaved !== 9000));
const sum = EV.summary();
check('summary traz repos (limitado), reposTotal e noRepo', sum.repos.length === 2 && sum.reposTotal === 2 && sum.noRepo.tokensSaved === 9000);

const here = EV.forRepo(cwdA);
check('forRepo(subpasta) devolve o total do repositório, sem o histórico sem raiz', here.root === A && here.name === 'alfa' && here.total.tokensSaved === 3000 && here.total.blocks === 1, JSON.stringify(here));
check('forRepo conta o "hoje" separado', here.today.blocks === 1 && here.today.trims === 1);
const none = EV.forRepo(path.join(base, 'nunca-visto'));
check('forRepo de pasta sem eventos é zero, sem erro', none.total.blocks === 0 && none.total.tokensSaved === 0);

console.log('\n  [poupança medida grava no mesmo formato em qualquer caminho]');
{
  const ctx = { root: cwdA, target: 'copilot', name: 'Read', input: { file_path: 'x.log' }, charsPerToken: 4 };
  const cut = EV.recordTrim(ctx, { replaced: true, originalChars: 10000, modifiedResult: 'x'.repeat(2000) });
  check('recordTrim conta os caracteres que deixaram de entrar, com raiz, alvo e caminho', cut.kind === 'trim' && cut.rule === 'bigResult' && cut.tokens === 2000 && cut.root === A && cut.target === 'copilot' && cut.detail === 'x.log', JSON.stringify(cut));
  const copy = EV.recordTrim(ctx, { replaced: false, originalChars: 10000, modifiedResult: 'x' });
  check('corte que o harness não aplica (só cópia em disco) não conta tokens', copy.tokens === 0);
  const dup = EV.recordSaving(ctx, 'dup', 'dupRead', 400);
  const sug = EV.recordSaving(ctx, 'scout', 'scout', 0);
  check('dup mede os caracteres; scout fica sem tokens medidos', dup.tokens === 100 && dup.kind === 'dup' && sug.kind === 'scout' && sug.tokens === null, JSON.stringify([dup, sug]));
}

console.log('\n  [status mostra o repositório atual]');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reposav-home-'));
  fs.mkdirSync(path.join(home, '.token-guard'), { recursive: true });
  const repo = path.join(home, 'meu-repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  const t = Date.now();
  fs.writeFileSync(path.join(home, '.token-guard', 'events.jsonl'), [
    { t, kind: 'trim', rule: 'bigResult', target: 'claude', tokens: 8000, root: repo },
    { t, kind: 'deny', rule: 'broadScan', target: 'claude', tokens: null, root: repo },
    { t, kind: 'trim', rule: 'bigResult', target: 'claude', tokens: 5000 },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const cli = path.join(__dirname, '..', 'cli.cjs');
  const env = { ...process.env, HOME: home, USERPROFILE: home, TOKEN_GUARD_UPDATE_CHECK: 'off' };
  const txt = spawnSync(process.execPath, [cli, 'status', repo], { cwd: home, env, encoding: 'utf8' });
  check('texto: linha do repositório com só os eventos dele', /neste repositório: barrados hoje 1 · total 1; tokens poupados hoje .*8.*· total/.test(txt.stdout) && /só eventos novos/.test(txt.stdout), txt.stdout);
  const js = JSON.parse(spawnSync(process.execPath, [cli, 'status', repo, '--json'], { cwd: home, env, encoding: 'utf8' }).stdout);
  check('--json traz savedHere com a conta do repositório', js.savedHere && js.savedHere.name === 'meu-repo' && js.savedHere.total.tokensSaved === 8000 && js.savedHere.total.blocks === 1, JSON.stringify(js.savedHere));
  const other = path.join(home, 'outro');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  const none2 = spawnSync(process.execPath, [cli, 'status', other], { cwd: home, env, encoding: 'utf8' });
  check('repositório sem eventos: diz que não há registro e que o histórico não é repartido', /neste repositório: nada registrado ainda/.test(none2.stdout) && /histórico anterior não é repartido/.test(none2.stdout), none2.stdout);
}

console.log('\n  [tela de setup]');
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'ui', 'setup.html'), 'utf8');
  check('cartão e função de render existem e são chamados no estado', /id="byrepo-card"/.test(html) && /function renderRepoSavings\(st, sv\)/.test(html) && /renderRepoSavings\(s\.stats, s\.savings\)/.test(html));
  check('a explicação diz que só conta eventos novos e que o US$ é aproximado', /o histórico anterior/.test(html) && /não é repartido/.test(html) && /aproximado/.test(html));
  check('sem repositório o cartão some', /byrepo-card'\)\.style\.display = repos\.length \? '' : 'none'/.test(html));
}

console.log(`\n  repo-savings: ${pass} passaram · ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
