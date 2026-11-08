#!/usr/bin/env node
'use strict';
/**
 * cost.test.cjs — custo por sessão a partir de transcripts (A26).
 * Cada caso prova uma garantia: dedupe do streaming, tarifa por TTL de cache,
 * fração acima de 200k, modelo sem preço visível, janela --since.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const COST = require('../lib/cost.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`); }
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

const PRICES = { opus: { in: 10, out: 100 }, sonnet: { in: 2, out: 20 } };

function rec(id, req, model, usage, ts = '2026-10-10T12:00:00.000Z', extra = {}) {
  return JSON.stringify({ type: 'assistant', sessionId: 's1', cwd: '/p/proj', timestamp: ts, requestId: req,
    message: { id, model, usage }, ...extra });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cost-'));
  const proj = path.join(root, 'proj-a');
  fs.mkdirSync(proj);
  const file = path.join(proj, 's1.jsonl');
  fs.writeFileSync(file, [
    // streaming: a mesma resposta em duas linhas, usage cumulativo — só a última conta
    rec('m1', 'r1', 'claude-opus-5', { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    rec('m1', 'r1', 'claude-opus-5', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 3000, cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } }),
    // contexto > 200k
    rec('m2', 'r2', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 250000, cache_creation_input_tokens: 0 }),
    rec('m3', 'r3', 'modelo-novo-x', { input_tokens: 1000000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }),
    rec('m4', 'r4', '<synthetic>', { input_tokens: 5, output_tokens: 5 }),
    'linha quebrada {',
    '{"type":"assistant","message":{"usage": {',
    JSON.stringify({ type: 'user', message: { content: 'oi' } }),
  ].join('\n'), 'utf8');

  console.log('\n  [custo por sessão]');
  const r = await COST.analyze({ dir: root, prices: PRICES });
  const s = r.sessions[0];
  check('uma sessão, chamadas deduplicadas (3: opus, sonnet, modelo novo; synthetic fora)', r.sessions.length === 1 && s.agg.calls === 3, JSON.stringify(s.agg));

  const opus = r.models['claude-opus-5'];
  const wantOpus = (1000 * 10 + 500 * 100 + 2000 * 10 * 0.1 + 1000 * 10 * 1.25 + 2000 * 10 * 2) / 1e6;
  check('opus: usa a ÚLTIMA linha do streaming e tarifa cache 5min/1h/leitura', near(opus.usd, wantOpus), `${opus.usd} != ${wantOpus}`);
  check('contexto máximo = entrada + cache lido + cache escrito', opus.maxContext === 6000, String(opus.maxContext));

  const son = r.models['claude-sonnet-5'];
  check('fração acima de 200k contada na chamada de contexto grande', son.usdHeavy > 0 && near(son.usdHeavy, son.usd));
  check('modelo sem preço: listado, custo não inventado', r.unpricedModels.includes('modelo-novo-x') &&
    r.models['modelo-novo-x'].usd === 0 && r.models['modelo-novo-x'].unpricedCalls === 1);
  check('linha de uso ilegível contada, não engolida; linha sem "usage" nem lida', r.badLines === 1, String(r.badLines));

  console.log('\n  [leitura em blocos]');
  const big = path.join(root, 'big.jsonl');
  const pad = 'x'.repeat(2.5 * (1 << 20));
  fs.writeFileSync(big, [
    JSON.stringify({ type: 'user', message: { content: pad } }),
    rec('b1', 'rb1', 'claude-opus-5', { input_tokens: 7, output_tokens: 0 }),
    JSON.stringify({ type: 'user', message: { content: pad } }),
    rec('b3', 'rb3', 'claude-opus-5', { input_tokens: 11, output_tokens: 0 }),
  ].join('\r\n'), 'utf8');
  const bt = await COST.readTranscript(big);
  check('linhas maiores que o bloco de leitura, CRLF e última linha sem quebra: as 2 chamadas lidas',
    bt.calls.length === 2 && bt.calls.map((c) => c.input).join(',') === '7,11' && bt.bad === 0,
    JSON.stringify({ n: bt.calls.length, bad: bt.bad }));
  fs.unlinkSync(big);
  check('relatório avisa o modelo sem preço', /sem preço configurado.*modelo-novo-x/.test(COST.renderText(r, { prices: PRICES })));

  console.log('\n  [janela --since]');
  const none = await COST.analyze({ dir: root, prices: PRICES, since: Date.parse('2026-10-11T00:00:00Z') });
  check('--since depois das chamadas: nada entra', none.total.calls === 0 && none.sessions.length === 0);
  const some = await COST.analyze({ dir: root, prices: PRICES, since: Date.parse('2026-10-10T00:00:00Z') });
  check('--since antes das chamadas: tudo entra', some.total.calls === 3);
  check('parseSince: 7d, 12h e data', COST.parseSince('7d', 1e12) === 1e12 - 7 * 86400000 &&
    COST.parseSince('12h', 1e12) === 1e12 - 12 * 3600000 && COST.parseSince('2026-10-10') === Date.parse('2026-10-10'));
  let threw = false;
  try { COST.parseSince('ontem'); } catch { threw = true; }
  check('parseSince inválido lança (fail loud)', threw);

  console.log('\n  [sem TTL no usage]');
  const f2 = path.join(proj, 's2.jsonl');
  fs.writeFileSync(f2, rec('n1', 'q1', 'claude-sonnet-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000000 }, undefined, { sessionId: 's2' }), 'utf8');
  const r2 = await COST.analyze({ dir: root, prices: PRICES });
  const s2 = r2.sessions.find((x) => x.sessionId === 's2');
  check('escrita de cache sem quebra por TTL conta como 5 min (não superestima)', near(s2.agg.usd, 2 * 1.25), String(s2.agg.usd));

  console.log('\n  [transcript sem requestId (Claude Code recente grava requestRef)]');
  const refRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cost-ref-'));
  fs.mkdirSync(path.join(refRoot, 'proj-c'));
  const ref = (usage) => rec('c1', undefined, 'claude-sonnet-5', usage, undefined, { sessionId: 'r1', requestRef: 'ref-1' });
  fs.writeFileSync(path.join(refRoot, 'proj-c', 'r1.jsonl'), [
    ref({ input_tokens: 100, output_tokens: 0 }),
    ref({ input_tokens: 500000, output_tokens: 0 }),
  ].join('\n'), 'utf8');
  const rr = await COST.analyze({ dir: refRoot, prices: PRICES });
  check('streaming sem requestId no transcript principal conta uma vez (a última linha)', rr.total.calls === 1 && near(rr.total.usd, 1), JSON.stringify(rr.total));

  console.log('\n  [subagentes entram na sessão do pai]');
  const subRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cost-sub-'));
  const subProj = path.join(subRoot, 'proj-b');
  fs.mkdirSync(path.join(subProj, 'p1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(subProj, 'p1.jsonl'),
    rec('a1', 'ra', 'claude-sonnet-5', { input_tokens: 1000000, output_tokens: 0 }, undefined, { sessionId: 'p1' }), 'utf8');
  // transcript de subagente: sessionId do pai, sem requestId, streaming repete o message.id
  const sub = (usage) => rec('b1', undefined, 'claude-sonnet-5', usage, undefined, { sessionId: 'p1', isSidechain: true, agentId: 'x' });
  fs.writeFileSync(path.join(subProj, 'p1', 'subagents', 'agent-x.jsonl'), [
    sub({ input_tokens: 100, output_tokens: 0 }),
    sub({ input_tokens: 500000, output_tokens: 0 }),
  ].join('\n'), 'utf8');
  const rs = await COST.analyze({ dir: subRoot, prices: PRICES });
  check('subagente soma na sessão do pai (uma sessão, 2 chamadas)', rs.sessions.length === 1 && rs.sessions[0].agg.calls === 2, JSON.stringify(rs.sessions.map((x) => [x.sessionId, x.agg.calls])));
  check('streaming do subagente sem requestId conta uma vez (a última linha)', near(rs.total.usd, 2 + 1), String(rs.total.usd));

  console.log('\n  [--here: só as sessões do repositório atual]');
  const hereRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cost-here-'));
  const repo = path.join(hereRoot, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'sub', 'deep'), { recursive: true });
  const tdir = path.join(hereRoot, 'transcripts', 'proj');
  fs.mkdirSync(tdir, { recursive: true });
  const at = (sid, cwd, id) => fs.writeFileSync(path.join(tdir, `${sid}.jsonl`),
    rec(id, `q-${id}`, 'claude-sonnet-5', { input_tokens: 1000000, output_tokens: 0 }, undefined, { sessionId: sid, cwd }), 'utf8');
  at('in-root', repo, 'h1');
  at('in-sub', path.join(repo, 'sub'), 'h2');
  at('sibling', path.join(hereRoot, 'repo-x'), 'h3');
  at('outside', hereRoot, 'h4');
  check('repoRoot sobe até a pasta com .git', COST.repoRoot(path.join(repo, 'sub', 'deep')) === repo);
  check('repoRoot fora de repositório devolve a própria pasta', COST.repoRoot(path.join(hereRoot, 'transcripts')) === path.join(hereRoot, 'transcripts'));
  const here = await COST.analyze({ dir: path.join(hereRoot, 'transcripts'), prices: PRICES, within: repo });
  const ids = here.sessions.map((x) => x.sessionId).sort().join(',');
  check('conta a raiz e as subpastas do repositório; pasta irmã com o mesmo prefixo e pasta acima ficam fora', ids === 'in-root,in-sub', ids);
  check('total soma só as sessões do repositório', here.total.calls === 2 && near(here.total.usd, 4), JSON.stringify(here.total));
  check('relatório diz que filtrou e por qual pasta', COST.renderText(here, { prices: PRICES }).includes(`só as sessões em ${repo} e abaixo (--here)`));
  if (process.platform === 'win32') {
    check('Windows: cwd com maiúsculas diferentes conta como o mesmo repositório', COST.isWithin(path.join(repo, 'sub').toUpperCase(), repo));
  }
  const cli = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'cost.cjs'), '--here', '--json', '--dir', path.join(hereRoot, 'transcripts')],
    { cwd: path.join(repo, 'sub', 'deep'), encoding: 'utf8' });
  const cliOut = cli.status === 0 ? JSON.parse(cli.stdout) : null;
  check('token-guard cost --here a partir de uma subpasta usa a raiz do repositório', cliOut && cliOut.within === repo && cliOut.sessions.length === 2, cli.stderr || cli.stdout.slice(0, 200));

  console.log('\n  [tabela padrão: preços oficiais por modelo]');
  const use = (f) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, ...f });
  const usd = (model, f) => COST.callCost(use(f), COST.priceOf(model, COST.DEFAULT_PRICES));
  check('Opus 5.5: entrada 4, saída 20, cache lido 0,05× (0,20)', near(usd('claude-opus-5-5', { input: 1e6 }), 4) &&
    near(usd('claude-opus-5-5', { output: 1e6 }), 20) && near(usd('claude-opus-5-5', { cacheRead: 1e6 }), 0.2),
    String(usd('claude-opus-5-5', { cacheRead: 1e6 })));
  check('Sonnet 5.5 (id do Vertex): entrada 2, cache lido 0,10', near(usd('vertex_ai.anthropic.claude-sonnet-5-5', { input: 1e6 }), 2) &&
    near(usd('vertex_ai.anthropic.claude-sonnet-5-5', { cacheRead: 1e6 }), 0.1));
  check('Fable 5.1: entrada 10, saída 50, cache lido 0,025× (0,25)', near(usd('claude-fable-5-1', { input: 1e6, output: 1e6 }), 60) &&
    near(usd('claude-fable-5-1', { cacheRead: 1e6 }), 0.25));
  check('Haiku 5.5 até 100k de prompt: 0,10 de entrada e 0,01 de cache lido', near(usd('claude-haiku-5-5', { input: 50000 }), 0.005) &&
    near(usd('claude-haiku-5-5', { cacheRead: 100000 }), 0.001));
  check('Haiku 5.5 acima de 100k de prompt: faixa 0,50/2,50 na chamada inteira', near(usd('claude-haiku-5-5', { input: 150000, output: 1000 }), 0.075 + 0.0025));
  check('modelo anterior da família segue a tabela da família (Opus 4.7: 5/25, cache 0,1×)', near(usd('claude-opus-4-7', { input: 1e6, cacheRead: 1e6 }), 5.5));
  check('relatório mostra o fator de cache próprio do modelo', /opus-5-5 4\/20 \(cache 0,05×\)/.test(COST.renderText(r, { prices: COST.DEFAULT_PRICES })));

  console.log('\n  [relatório: repositórios, poupança do guard e preço de entrada]');
  const withSaved = COST.renderText(here, { prices: COST.DEFAULT_PRICES, saved: { blocks: 3, tokensSaved: 2000000 } });
  check('o texto lista os repositórios mais caros, com sessões e custo (as duas sessões do repo somam num só)',
    /repositórios mais caros\n\s+repo\s+2 sessões\s+2 ch\s+US\$ 4\.00/.test(withSaved), withSaved);
  check('o texto diz o que o guard poupou na mesma janela, com a conta (2M tokens × US$ 4/Mtok = US$ 8,00)',
    /guard na mesma janela: 3 barrados · ~2\.0M tokens poupados ≈ US\$ 8\.00 \(tokens × US\$ 4\/Mtok de opus-5-5, tabela padrão; aproximado\)/.test(withSaved), withSaved);
  check('sem `saved` o texto não inventa a linha do guard', !/guard na mesma janela/.test(COST.renderText(here, { prices: COST.DEFAULT_PRICES })));
  check('inputUsdText: tokens × entrada do primeiro modelo, com a conta e a fonte',
    COST.inputUsdText(1e6, COST.DEFAULT_PRICES) === '≈ US$ 4,00 de entrada (opus-5-5, US$ 4/Mtok, tabela padrão; aproximado)', COST.inputUsdText(1e6, COST.DEFAULT_PRICES));
  check('inputUsdText: primeiro modelo sem preço de entrada devolve vazio, nunca um valor inventado', COST.inputUsdText(1e6, { sonnet: { out: 10 } }) === '');

  const AUDIT = require('../lib/audit.cjs');
  const CFGL = require('../lib/config.cjs');
  const auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cost-audit-'));
  fs.writeFileSync(path.join(auditDir, 'a.js'), 'x'.repeat(4000));
  const auditCfg = CFGL.load(auditDir);
  check('token-audit mostra o preço de entrada da lista de nomes de arquivo, com a fonte',
    /≈ US\$ \d+,\d\d de entrada \(opus-5-5, US\$ 4\/Mtok, tabela padrão; aproximado\)/.test(AUDIT.renderText(AUDIT.scan(auditDir, auditCfg, { top: 3 }), auditCfg)));
  const MC = require('../lib/mcp-cost.cjs');
  const mcpText = MC.renderText(MC.measure([], {}), COST.DEFAULT_PRICES);
  check('mcp-cost mostra o preço de entrada do preâmbulo, com a fonte', /≈ US\$ 0,00 de entrada \(opus-5-5, US\$ 4\/Mtok, tabela padrão; aproximado\), se o schema todo entrar na janela/.test(mcpText), mcpText);
  check('mcp-cost sem tabela de preços não mostra a linha de US$', !/de entrada \(/.test(MC.renderText(MC.measure([], {}))));

  console.log('');
  console.log(`  ${pass} passaram · ${fail} falharam`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
