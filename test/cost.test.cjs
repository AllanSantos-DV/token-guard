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

  console.log('\n  [contexto por família: tamanho dos resultados de ferramenta]');
  const ctxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cost-ctx-'));
  fs.mkdirSync(path.join(ctxRoot, 'proj-ctx'));
  const USAGE = { input_tokens: 10, output_tokens: 1 };
  const ctxTs = (ts) => ({ type: 'user', sessionId: 'ctx1', cwd: '/p/proj', timestamp: ts });
  const toolUse = (id, name, ts = '2026-10-10T12:00:00.000Z') => JSON.stringify({ type: 'assistant', sessionId: 'ctx1', cwd: '/p/proj', timestamp: ts,
    message: { id: `m-${id}`, model: 'claude-opus-5', usage: USAGE, content: [{ type: 'tool_use', id, name, input: {} }] } });
  const toolResult = (id, content, ts = '2026-10-10T12:00:01.000Z', extra = {}) => JSON.stringify({ ...ctxTs(ts), ...extra,
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content }] } });
  const ctxFile = path.join(ctxRoot, 'proj-ctx', 'ctx1.jsonl');
  fs.writeFileSync(ctxFile, [
    toolUse('t-bash', 'Bash'),
    toolResult('t-bash', 'x'.repeat(40000)),
    // streaming repete o tool_use e o resultado volta como cópia do api-request-blob: uma chamada só
    toolUse('t-bash', 'Bash'),
    JSON.stringify({ type: 'api-request-blob', sessionId: 'ctx1', message: { content: [{ type: 'tool_result', tool_use_id: 't-bash', content: 'x'.repeat(40000) }] } }),
    toolUse('t-read', 'Read'),
    toolResult('t-read', [{ type: 'text', text: 'a'.repeat(1500) }, { type: 'text', text: 'b'.repeat(500) }, { type: 'image', source: { type: 'base64', data: 'Z'.repeat(9000) } }]),
    toolUse('t-grep', 'Grep'),
    toolResult('t-grep', 'g'.repeat(300)),
    toolUse('t-glob', 'Glob'),
    toolResult('t-glob', 'l'.repeat(200)),
    toolUse('t-mcp', 'mcp__whatsapp-bridge__get_recent_messages'),
    toolResult('t-mcp', 'm'.repeat(22000)),
    toolUse('t-fsmcp', 'mcp__fs__read_text_file'),
    toolResult('t-fsmcp', 'f'.repeat(100)),
    toolUse('t-edit', 'Edit'),
    toolResult('t-edit', 'ok', undefined, { toolUseResult: 'y'.repeat(5000) }),
    toolUse('t-ref', 'ToolSearch'),
    toolResult('t-ref', [{ type: 'tool_reference', tool_name: 'x' }]),
    toolResult('t-orfao', 'o'.repeat(70)),
    toolUse('t-old', 'Bash', '2026-09-01T12:00:00.000Z'),
    toolResult('t-old', 'z'.repeat(1000), '2026-09-01T12:00:01.000Z'),
  ].join('\n'), 'utf8');
  const cx = await COST.analyze({ dir: ctxRoot, prices: PRICES });
  const fam = cx.contextByFamily || {};
  check('shell: 1 chamada Bash com resultado de 40000 caracteres (a cópia do api-request-blob e o streaming não duplicam), mais a de setembro',
    fam.shell && fam.shell.calls === 2 && fam.shell.chars === 41000, JSON.stringify(fam));
  check('read: resultado em array de blocos de texto soma só o texto (imagem fora) e o Read do MCP de filesystem cai em read',
    fam.read && fam.read.calls === 2 && fam.read.chars === 2100, JSON.stringify(fam.read));
  check('search (Grep) e list (Glob) separados', fam.search && fam.search.chars === 300 && fam.list && fam.list.chars === 200, JSON.stringify([fam.search, fam.list]));
  check('mcp: ferramenta de servidor MCP fora das famílias de leitura/busca', fam.mcp && fam.mcp.calls === 1 && fam.mcp.chars === 22000, JSON.stringify(fam.mcp));
  check('outras: Edit, ToolSearch (só tool_reference, 0 caracteres) e resultado sem tool_use conhecido; o toolUseResult duplicado não conta',
    fam.other && fam.other.calls === 3 && fam.other.chars === 72, JSON.stringify(fam.other));
  const cxSince = await COST.analyze({ dir: ctxRoot, prices: PRICES, since: Date.parse('2026-10-01T00:00:00Z') });
  check('--since também corta os resultados antigos', ((cxSince.contextByFamily || {}).shell || {}).calls === 1 && cxSince.contextByFamily.shell.chars === 40000, JSON.stringify(cxSince.contextByFamily));
  const cxText = COST.renderText(cx, { prices: PRICES });
  check('o texto traz a seção "contexto por família" com chamadas e caracteres, a maior primeiro',
    /contexto por família/.test(cxText) && /shell\s+2 chamadas\s+41k caracteres/.test(cxText) && cxText.indexOf('shell ') < cxText.indexOf('mcp '), cxText);
  const cxCli = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'cost.cjs'), '--json', '--dir', ctxRoot], { encoding: 'utf8', windowsHide: true });
  const cxJson = cxCli.status === 0 ? JSON.parse(cxCli.stdout) : null;
  check('cost --json traz contextByFamily e mantém as chaves de antes', cxJson && cxJson.contextByFamily.shell.chars === 41000 && 'total' in cxJson && 'models' in cxJson && 'sessions' in cxJson && 'saved' in cxJson, cxCli.stderr);
  check('sem transcripts de ferramenta a seção some do texto', !/contexto por família/.test(COST.renderText(here, { prices: PRICES })));

  console.log('\n  [custo e poupança lado a lado por repositório]');
  const EV = require('../lib/events.cjs');
  const evs = [
    { t: 1, kind: 'trim', rule: 'bigResult', tokens: 3000, root: repo },
    { t: 2, kind: 'dup', rule: 'dupRead', tokens: 500, root: repo },
    { t: 3, kind: 'deny', rule: 'broadScan', tokens: null, root: repo },
    { t: 4, kind: 'trim', rule: 'bigResult', tokens: 9000 },
  ];
  const savedRepos = EV.byRepo(evs).repos;
  const rows = COST.byRepo(here.sessions, savedRepos);
  check('byRepo: `saved` soma os tokens poupados dos eventos com root; o evento sem root não entra em repositório nenhum',
    rows.length === 1 && rows[0].saved === 3500, JSON.stringify(rows));
  check('byRepo sem eventos: `saved` é 0 em toda entrada e o resto da entrada não muda',
    COST.byRepo(here.sessions).every((g) => g.saved === 0) && COST.byRepo(here.sessions)[0].calls === 2);
  const allRows = COST.byRepo((await COST.analyze({ dir: path.join(hereRoot, 'transcripts'), prices: PRICES })).sessions, savedRepos);
  check('byRepo: repositório de sessão sem evento fica com saved 0 (aparece como zero, nunca inventado)',
    allRows.length === 3 && allRows.filter((g) => g.saved === 0).length === 2 && allRows.find((g) => g.root === repo).saved === 3500, JSON.stringify(allRows));
  if (process.platform === 'win32') {
    check('Windows: a chave de raiz casa nos dois lados mesmo com maiúsculas diferentes',
      COST.byRepo(here.sessions, [{ root: repo.toUpperCase(), tokensSaved: 70 }])[0].saved === 70);
  }
  const rowsText = COST.renderText(here, { prices: PRICES, savedRepos });
  check('o texto da linha do repositório traz a poupança do guard e avisa que histórico sem root aparece como zero',
    /repo\s+2 sessões\s+2 ch\s+US\$ 4\.00\s+>200k: 100%\s+poupou ~4k tokens/.test(rowsText) && /histórico antigo.*zero/.test(rowsText), rowsText);
  check('sem `savedRepos` a linha do repositório fica como antes (sem coluna nem aviso)',
    !/poupou/.test(COST.renderText(here, { prices: PRICES })) && !/histórico antigo/.test(COST.renderText(here, { prices: PRICES })));
  const evDir = path.join(os.homedir(), '.token-guard');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'events.jsonl'), evs.map((e) => JSON.stringify({ ...e, t: Date.now() + e.t })).join('\n') + '\n', 'utf8');
  const repoCli = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'cost.cjs'), '--repos', '--dir', path.join(hereRoot, 'transcripts')], { encoding: 'utf8', windowsHide: true });
  const repoJson = repoCli.status === 0 ? JSON.parse(repoCli.stdout) : null;
  const repoRow = repoJson && repoJson.repos.find((g) => g.root === repo);
  check('cost --repos traz `saved` por repositório (3500 no repo; 0 nos demais) e mantém `total`',
    repoRow && repoRow.saved === 3500 && repoJson.repos.every((g) => 'saved' in g) && 'total' in repoJson, repoCli.stderr || repoCli.stdout.slice(0, 300));
  const repoTxt = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'cost.cjs'), '--dir', path.join(hereRoot, 'transcripts')], { encoding: 'utf8', windowsHide: true });
  check('cost em texto mostra a poupança na linha do repositório', repoTxt.status === 0 && /repo\s+2 sessões.*poupou ~4k tokens/.test(repoTxt.stdout), repoTxt.stderr || repoTxt.stdout);
  fs.rmSync(path.join(evDir, 'events.jsonl'), { force: true });

  console.log('\n  [cost --sessao <id> e --ultima: relatório de uma sessão]');
  const one = await COST.analyze({ dir: ctxRoot, prices: PRICES, session: 'ctx1' });
  check('analyze com `session` devolve só essa sessão, com as famílias de contexto dela',
    one.sessions.length === 1 && one.sessions[0].sessionId === 'ctx1' && one.contextByFamily.shell.chars === 41000 && one.session === 'ctx1', JSON.stringify(one.sessions.map((x) => x.sessionId)));
  const two = await COST.analyze({ dir: root, prices: PRICES, session: 's2' });
  check('só a sessão pedida entra no total (s2 tem 1 chamada; s1, 3)', two.sessions.length === 1 && two.total.calls === 1, JSON.stringify(two.total));
  const byPrefix = await COST.analyze({ dir: path.join(hereRoot, 'transcripts'), prices: PRICES, session: 'in-r' });
  check('prefixo único do id (como o texto lista, 8 caracteres) acha a sessão', byPrefix.sessions.length === 1 && byPrefix.sessions[0].sessionId === 'in-root');
  const failMsg = async (opts, dir = root) => { try { await COST.analyze({ dir, prices: PRICES, ...opts }); return null; } catch (e) { return e.message; } };
  const missing = await failMsg({ session: 'nao-existe' });
  check('id inexistente: erro claro com o id pedido (fail loud)', /sessão "nao-existe" não encontrada/.test(missing || ''), String(missing));
  const ambiguous = await failMsg({ session: 'in-' }, path.join(hereRoot, 'transcripts'));
  check('prefixo ambíguo: erro lista os ids que casam, não escolhe um', /ambíguo/.test(ambiguous || '') && /in-root/.test(ambiguous) && /in-sub/.test(ambiguous), String(ambiguous));
  const emptyMsg = await failMsg({ last: true }, fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cost-vazio-')));
  check('--ultima sem nenhuma sessão: erro claro', /nenhuma sessão/.test(emptyMsg || ''), String(emptyMsg));

  const lastRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cost-last-'));
  fs.mkdirSync(path.join(lastRoot, 'p'));
  const lastLine = (sid, ts) => rec(`m-${sid}-${ts}`, `r-${sid}-${ts}`, 'claude-sonnet-5', { input_tokens: 10, output_tokens: 0 }, ts, { sessionId: sid });
  fs.writeFileSync(path.join(lastRoot, 'p', 'velha.jsonl'), [
    lastLine('velha', '2026-10-10T12:00:00.000Z'),
    JSON.stringify({ type: 'user', sessionId: 'velha', timestamp: '2026-10-13T08:00:00.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } }),
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(lastRoot, 'p', 'nova.jsonl'), lastLine('nova', '2026-10-12T12:00:00.000Z'), 'utf8');
  const lastOne = await COST.analyze({ dir: lastRoot, prices: PRICES, last: true });
  check('--ultima escolhe a sessão com a mensagem mais recente, mesmo que seja um resultado de ferramenta (não só a última chamada)',
    lastOne.sessions.length === 1 && lastOne.sessions[0].sessionId === 'velha', JSON.stringify(lastOne.sessions.map((x) => x.sessionId)));
  fs.appendFileSync(path.join(lastRoot, 'p', 'nova.jsonl'), '\n' + lastLine('nova', '2026-10-14T12:00:00.000Z'), 'utf8');
  const lastTwo = await COST.analyze({ dir: lastRoot, prices: PRICES, last: true });
  check('--ultima muda quando a outra sessão ganha mensagem mais nova', lastTwo.sessions[0].sessionId === 'nova' && lastTwo.total.calls === 2, JSON.stringify(lastTwo.total));

  const oneText = COST.renderText(one, { prices: PRICES });
  check('relatório da sessão: título com o id, cwd, chamadas, cache, contexto máximo e o bloco "contexto por família"',
    /token-guard cost · sessão ctx1/.test(oneText) && /\/p\/proj/.test(oneText) && /9 chamadas/.test(oneText) && /cache lido/.test(oneText) &&
    /contexto máximo/.test(oneText) && /contexto por família/.test(oneText) && /shell\s+2 chamadas\s+41k caracteres/.test(oneText), oneText);
  check('relatório da sessão não traz as listas de repositórios nem de sessões mais caras', !/repositórios mais caros/.test(oneText) && !/sessões mais caras/.test(oneText), oneText);
  const run = (...args) => require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'cost.cjs'), ...args], { encoding: 'utf8', windowsHide: true });
  const cliOne = run('--sessao', 'ctx1', '--dir', ctxRoot);
  check('cost --sessao <id> imprime o relatório da sessão e sai com 0', cliOne.status === 0 && /sessão ctx1/.test(cliOne.stdout) && /contexto por família/.test(cliOne.stdout), cliOne.stderr || cliOne.stdout);
  const cliMiss = run('--sessao', 'nao-existe', '--dir', ctxRoot);
  check('cost --sessao inexistente: erro no stderr e saída não zero', cliMiss.status !== 0 && /sessão "nao-existe" não encontrada/.test(cliMiss.stderr) && cliMiss.stdout === '', cliMiss.stderr);
  const cliNoVal = run('--sessao', '--dir', ctxRoot);
  check('cost --sessao sem id: erro claro, saída não zero', cliNoVal.status !== 0 && /--sessao pede o id/.test(cliNoVal.stderr), cliNoVal.stderr);
  const cliBoth = run('--sessao', 'ctx1', '--ultima', '--dir', ctxRoot);
  check('cost --sessao junto com --ultima: erro claro, saída não zero', cliBoth.status !== 0 && /--sessao e --ultima/.test(cliBoth.stderr), cliBoth.stderr);
  const cliLast = run('--ultima', '--json', '--dir', lastRoot);
  const lastJson = cliLast.status === 0 ? JSON.parse(cliLast.stdout) : null;
  check('cost --ultima --json: uma sessão só, a mais recente', lastJson && lastJson.sessions.length === 1 && lastJson.sessions[0].sessionId === 'nova', cliLast.stderr);
  check('sem as flags novas o texto geral continua com repositórios e sessões mais caras', /repositórios mais caros/.test(run('--dir', ctxRoot).stdout) && /sessões mais caras/.test(run('--dir', ctxRoot).stdout));

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
