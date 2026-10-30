#!/usr/bin/env node
'use strict';
/**
 * targets.test.cjs — modo de bloqueio global ou por IDE, escrita da config pela tela e o
 * registro do que foi barrado e poupado.
 *
 * Garantias:
 *   · `targets` desliga só o IDE nomeado; o geral e os outros seguem;
 *   · a tela só oferece o que a config entende (catálogo ⇄ chaves de config);
 *   · a escrita valida, preserva o resto do arquivo e nunca sobrescreve um arquivo ilegível;
 *   · cada bloqueio e cada poupança medida viram evento; deny não inventa tokens;
 *   · guard desligado (global ou do IDE) não corta, não registra e não sugere no pós-processamento.
 */

const BOOT = require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const CFG = require('../lib/config.cjs');
const CE = require('../lib/config-edit.cjs');
const EV = require('../lib/events.cjs');
const CAT = require('../lib/catalog.cjs');
const P = require('../lib/payload.cjs');
const { decide } = require('../lib/decide.cjs');
const DS = require('../adapters/daemon-server.cjs');
const { BIG, TMP } = require('./fixtures/cases.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 300)}` : ''}`); }
}

const cfgFile = CE.userConfigPath();
const writeCfg = (obj) => { fs.mkdirSync(path.dirname(cfgFile), { recursive: true }); fs.writeFileSync(cfgFile, typeof obj === 'string' ? obj : JSON.stringify(obj)); CFG.clearMemo(); };
const reset = () => { fs.rmSync(cfgFile, { force: true }); fs.rmSync(EV.eventsPath(), { force: true }); CFG.clearMemo(); };

const claudeRead = { tool_name: 'Read', tool_input: { file_path: BIG }, cwd: TMP, session_id: 'tg-targets' };

console.log('\n  [modo por IDE na config]');
{
  reset();
  check('sem targets: nenhum IDE desligado', JSON.stringify(CFG.load(TMP, 'claude').targets) === '{}' && CFG.load(TMP, 'claude').mode === 'block');
  writeCfg({ targets: { claude: 'off' } });
  const c = CFG.load(TMP, 'claude');
  check('claude desligado: mode off e _targetOff', c.mode === 'off' && c._targetOff === 'claude', c.mode);
  check('cursor segue o geral (block)', CFG.load(TMP, 'cursor').mode === 'block');
  check('sem alvo declarado, vale o geral', CFG.load(TMP).mode === 'block');
  check('a fonte diz que o IDE foi desligado em targets', /claude desligado em targets/.test(c._source), c._source);
  check('lista de IDEs bate com o catálogo', JSON.stringify(CFG.TARGETS) === JSON.stringify(CAT.TARGETS.map((t) => t.id)));
  writeCfg({ targets: { claude: 'talvez', cursor: 'off', zed: 'off' } });
  check('valor inválido e IDE desconhecido são descartados (fail-open por chave)',
    JSON.stringify(CFG.load(TMP).targets) === '{"cursor":"off"}', CFG.load(TMP).targets);
  writeCfg({ mode: 'off', targets: { claude: 'block' } });
  check('geral off vale mesmo com o IDE em block', CFG.load(TMP, 'claude').mode === 'off');
  writeCfg({ ui: { tray: false } });
  check('ui.tray false chega à config', CFG.load(TMP).ui.tray === false);
  writeCfg({});
  check('ui.tray é true por padrão', CFG.load(TMP).ui.tray === true);
  check('status mostra o modo por IDE só quando algum foge do geral',
    !CFG.statusSummary(TMP).lines.some((l) => /modo por IDE/.test(l)));
  writeCfg({ targets: { codex: 'off' } });
  check('status lista o IDE desligado', CFG.statusSummary(TMP).lines.some((l) => /modo por IDE: codex off/.test(l)));
}

console.log('\n  [decide respeita o IDE de quem chama]');
{
  reset();
  check('claude: leitura cega é barrada por padrão', decide(claudeRead, { target: 'claude' })?.rule === 'blindRead');
  writeCfg({ targets: { claude: 'off' } });
  check('claude desligado: a mesma chamada passa', decide(claudeRead, { target: 'claude' }) === null);
  check('cursor continua barrando a mesma chamada', decide(claudeRead, { target: 'cursor' })?.rule === 'blindRead');
  check('sem target, barra (o geral manda)', decide(claudeRead)?.rule === 'blindRead');
  check('harnessOf: toolCall é copilot, o resto é claude',
    P.harnessOf({ toolCall: { toolName: 'view' } }) === 'copilot' && P.harnessOf(claudeRead) === 'claude' && P.harnessOf({}) === 'claude');
}

console.log('\n  [catálogo da tela ⇄ config]');
{
  reset();
  const ids = CAT.RULES.map((r) => r.id).sort();
  const active = CFG.activeRules(CFG.load(TMP)).sort();
  check('toda regra do catálogo é uma regra ativa por padrão (e vice-versa)', JSON.stringify(ids) === JSON.stringify(active), { ids, active });
  check('toda regra tem texto humano, exemplo e tipo válido',
    CAT.RULES.every((r) => r.title && r.what && r.why && r.example.tried && r.example.does && ['barra', 'enxuga', 'sugere'].includes(r.kind)));
  check('todo IDE tem título e o que cobre', CAT.TARGETS.every((t) => t.title && t.coverage));
}

console.log('\n  [escrita pela tela: lib/config-edit]');
{
  reset();
  const bad = (p) => CE.validate(p).ok === false;
  check('rejeita mode fora de block/off', bad({ mode: 'warn' }));
  check('rejeita IDE desconhecido', bad({ targets: { zed: 'off' } }));
  check('rejeita valor de IDE inválido', bad({ targets: { claude: 'x' } }));
  check('rejeita regra desconhecida', bad({ rules: { inventada: true } }));
  check('rejeita regra não booleana', bad({ rules: { broadScan: 'sim' } }));
  check('rejeita campo desconhecido', bad({ limits: {} }));
  check('rejeita ui.tray não booleano', bad({ ui: { tray: 'sim' } }));
  check('rejeita corpo que não é objeto', bad([]) && bad('x'));

  writeCfg({ $comment: 'meu', limits: { readBytesWithoutRange: 1234 }, noiseDirsExtra: ['x'], targets: { cursor: 'off' } });
  const r = CE.save({ mode: 'off', targets: { claude: 'off', cursor: null }, rules: { shellDump: false }, ui: { tray: false } });
  check('save devolve o arquivo gravado', r.ok && r.file === cfgFile, r);
  const disk = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  check('save preserva o que a tela não gerencia', disk.$comment === 'meu' && disk.limits.readBytesWithoutRange === 1234 && disk.noiseDirsExtra[0] === 'x', disk);
  check('save aplica mode, regras e tray', disk.mode === 'off' && disk.rules.shellDump === false && disk.ui.tray === false, disk);
  check('null tira o IDE (volta a seguir o geral); os outros ficam', JSON.stringify(disk.targets) === '{"claude":"off"}', disk.targets);
  check('o que a tela gravou vale para quem lê a config (CLI, hooks, daemon)',
    CFG.load(TMP).mode === 'off' && !CFG.activeRules(CFG.load(TMP)).includes('shellDump'));
  check('não sobra arquivo temporário', fs.readdirSync(path.dirname(cfgFile)).every((f) => !f.includes('.tg-tmp-')));

  writeCfg('{ isto não é json');
  const before = fs.readFileSync(cfgFile, 'utf8');
  const r2 = CE.save({ mode: 'block' });
  check('arquivo ilegível: erro claro e nada sobrescrito', !r2.ok && /não é JSON válido/.test(r2.error) && fs.readFileSync(cfgFile, 'utf8') === before, r2);
  check('readUserConfig expõe o mesmo erro', CE.readUserConfig().ok === false);
  fs.rmSync(cfgFile, { force: true });
  check('sem arquivo ainda: save cria', CE.save({ mode: 'block' }).ok && fs.existsSync(cfgFile));
}

console.log('\n  [eventos: o que foi barrado e poupado]');
{
  reset();
  const d = EV.record({ kind: 'deny', rule: 'blindRead', target: 'claude', tool: 'Read', detail: 'a'.repeat(500) });
  check('deny: tokens null (não mede o que não rodou) e detalhe aparado', d.tokens === null && d.detail.length === 120, d);
  const t = EV.record({ kind: 'trim', rule: 'bigResult', target: 'claude', tool: 'Grep', tokens: 1234.4 });
  check('trim: tokens medidos arredondados', t.tokens === 1234, t);
  check('trim sem medida fica 0, não null', EV.record({ kind: 'trim', rule: 'bigResult', target: 'claude', tokens: 0 }).tokens === 0);
  check('kind desconhecido cai em deny (não grava lixo)', EV.record({ kind: 'x', rule: 'r' }).kind === 'deny');
  fs.appendFileSync(EV.eventsPath(), '{linha truncada por crash\n');
  EV.record({ kind: 'dup', rule: 'dupRead', target: 'cursor', tokens: 100 });
  const s = EV.summary();
  check('linha ilegível é pulada', EV.readAll().length === 5, EV.readAll().length);
  check('totais: 2 barrados, 1 corte, 1 duplicata', s.total.blocks === 2 && s.total.trims === 2 && s.total.dups === 1, s.total);
  check('tokens poupados só somam o medido', s.total.tokensSaved === 1334, s.total);
  check('por regra e por IDE', s.byRule.blindRead.count === 1 && s.byRule.bigResult.tokens === 1234 && s.byTarget.cursor === 1, s);
  check('recentes: o mais novo primeiro', s.recent[0].kind === 'dup');
  const old = JSON.stringify({ t: Date.now() - 3 * 86400000, kind: 'deny', rule: 'broadScan', target: 'claude', tool: '', detail: '', tokens: null });
  fs.appendFileSync(EV.eventsPath(), old + '\n');
  check('hoje não conta evento de dias atrás; o total conta', EV.summary().today.blocks === 2 && EV.summary().total.blocks === 3);

  let heard = null;
  const on = (e) => { heard = e; };
  EV.bus.on('event', on);
  EV.record({ kind: 'scout', rule: 'scout', target: 'claude' });
  EV.bus.removeListener('event', on);
  check('quem escuta é avisado na hora (a tela é empurrada)', heard && heard.kind === 'scout');

  const lines = [];
  for (let i = 0; i < EV.KEEP_LINES + 500; i++) lines.push(JSON.stringify({ t: i + 1, kind: 'deny', rule: 'r', target: 'claude', tool: 'x'.repeat(200), detail: 'y'.repeat(100), tokens: null }));
  fs.writeFileSync(EV.eventsPath(), lines.join('\n') + '\n');
  const grew = fs.statSync(EV.eventsPath()).size > EV.MAX_BYTES;
  check('arquivo acima do teto é aparado ao subir o daemon, mantendo o fim', grew && EV.trim() && EV.readAll().length <= EV.KEEP_LINES && EV.readAll().length > 1000 && EV.readAll().pop().t === EV.KEEP_LINES + 500 && fs.statSync(EV.eventsPath()).size <= EV.MAX_BYTES / 2);
  fs.writeFileSync(EV.eventsPath(), lines.slice(0, 10).join('\n') + '\n');
  check('abaixo do teto não mexe', EV.trim() === false && EV.readAll().length === 10);
}

console.log('\n  [daemon: alvo, eventos e guard desligado no pós-processamento]');
{
  reset();
  const ctx = () => ({ cache: new Map(), hits: 0, misses: 0, lastActivity: Date.now() });
  const check1 = (c, params) => DS.handleMessage({ id: 1, method: 'check', params }, c).result;

  const c1 = ctx();
  let r = check1(c1, { root: TMP, payload: claudeRead });
  check('check: bloqueia e registra o evento com IDE, regra e ferramenta',
    r.verdict?.rule === 'blindRead' && EV.readAll().length === 1 && EV.readAll()[0].target === 'claude' && EV.readAll()[0].rule === 'blindRead' && EV.readAll()[0].tool === 'Read', EV.readAll());
  check1(c1, { root: TMP, payload: claudeRead });
  check('check em cache também conta (cada chamada barrada é um evento)', c1.hits === 1 && EV.readAll().length === 2);
  r = check1(c1, { root: TMP, payload: { toolCall: { toolName: 'view', input: { path: BIG } }, cwd: TMP } });
  check('envelope do Copilot vira alvo copilot', EV.readAll().pop().target === 'copilot', EV.readAll().pop());
  r = check1(c1, { root: TMP, payload: claudeRead, target: 'codex' });
  check('alvo declarado pelo cliente vale sobre o envelope', EV.readAll().pop().target === 'codex');
  check('cliente que passa o alvo não reaproveita o veredito de outro alvo (alvo entra na chave do cache)', c1.misses === 3, c1.misses);

  writeCfg({ targets: { claude: 'off' } });
  const c2 = ctx();
  const n = EV.readAll().length;
  r = check1(c2, { root: TMP, payload: claudeRead });
  check('claude desligado: o daemon libera e não registra', r.verdict === null && EV.readAll().length === n, r);
  r = check1(c2, { root: TMP, payload: claudeRead, target: 'cursor' });
  check('no mesmo daemon, o cursor segue barrando', r.verdict?.rule === 'blindRead');

  const post = (target, big) => DS.handleMessage({ id: 1, method: 'postprocess', params: { name: 'Grep', input: {}, result: 'g'.repeat(big), root: TMP, sessionId: 'tg-t-post', target } }, ctx()).result;
  reset();
  const big = post(undefined, 90000);
  const ev = EV.readAll();
  check('bigResult: corta e registra tokens medidos (> 0)', big.trimmed?.savedTo && ev.length === 1 && ev[0].kind === 'trim' && ev[0].tokens > 10000, ev);
  writeCfg({ targets: { claude: 'off' } });
  const off = post(undefined, 90000);
  check('claude desligado: nada é cortado nem registrado no pós-processamento', off.trimmed === null && EV.readAll().length === 1, off);
  writeCfg({ mode: 'off' });
  check('geral desligado: idem', post('cursor', 90000).trimmed === null && EV.readAll().length === 1);
  writeCfg({ targets: { claude: 'off' } });
  check('outro IDE ainda é cortado quando só o claude está desligado', post('cursor', 90000).trimmed?.savedTo);
}

console.log('\n  [bloqueio registrado por todo caminho, não só pelo daemon]');
{
  reset();
  const { spawnSync } = require('child_process');
  const viaCursor = spawnSync(process.execPath, [path.join(__dirname, '..', 'adapters', 'cursor-hook.cjs')], {
    input: JSON.stringify({ hook_event_name: 'beforeReadFile', file_path: BIG, workspace_roots: [TMP] }), encoding: 'utf8', windowsHide: true,
  });
  const evs = EV.readAll();
  check('o hook do Cursor barra e registra o evento (IDE cursor, regra, ferramenta)',
    /"deny"/.test(viaCursor.stdout) && evs.length === 1 && evs[0].target === 'cursor' && evs[0].rule === 'blindRead' && evs[0].tool === 'read_file', { out: viaCursor.stdout.slice(0, 80), evs });
  const viaHook = spawnSync(process.execPath, [path.join(__dirname, '..', 'adapters', 'hook-cmd.cjs')], {
    input: JSON.stringify(claudeRead), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TOKEN_GUARD_SID: `tg-targets-nodaemon-${process.pid}` },
  });
  check('o hook de comando barra (com ou sem daemon) e o evento chega ao registro', /"deny"/.test(viaHook.stdout) && EV.readAll().some((e) => e.target === 'claude' && e.rule === 'blindRead'), viaHook.stdout.slice(0, 80));
  const first = EV.readAll().length;
  fs.appendFileSync(EV.eventsPath(), JSON.stringify({ t: Date.now(), kind: 'deny', rule: 'x', target: 'mcp', tool: '', detail: '', tokens: null }) + '\n');
  check('a leitura vê o evento gravado por outro processo (cache só vale com o arquivo igual)', EV.readAll().length === first + 1);
  const big = [];
  for (let i = 0; i < EV.KEEP_LINES + 500; i++) big.push(JSON.stringify({ t: i + 1, kind: 'deny', rule: 'r', target: 'claude', tool: 'x'.repeat(200), detail: 'y'.repeat(100), tokens: null }));
  fs.writeFileSync(EV.eventsPath(), big.join('\n') + '\n');
  for (let i = 0; i < 200; i++) EV.record({ kind: 'deny', rule: 'r', target: 'claude' });
  check('o teto do arquivo vale em execução: aparado durante o registro, sem reiniciar o daemon', fs.statSync(EV.eventsPath()).size < EV.MAX_BYTES, fs.statSync(EV.eventsPath()).size);
  const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'copilot-cli.mjs'), 'utf8');
  check('a extensão do Copilot respeita o modo (global e por IDE) no pós-processamento',
    /onPostToolUse[\s\S]{0,400}cfg\.mode === "off"\) return null/.test(src) && /CFG\.load\(root, "copilot"\)/.test(src));
}

fs.rmSync(cfgFile, { force: true });
console.log(`\n  ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
