#!/usr/bin/env node
'use strict';
/**
 * mcp-cost.test.cjs — bateria do medidor de custo de preâmbulo MCP.
 *
 * Servidores MCP de verdade são de terceiros e mudam sem aviso, então aqui
 * sondamos FIXTURES: servidores stdio sintéticos, escritos neste arquivo, com
 * comportamento controlado — inclusive os patológicos (não responde, responde
 * erro, loga lixo em stdout, nunca encerra).
 *
 * Node puro, sem framework, pelo mesmo motivo do resto do projeto: zero deps.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const MC = require('../lib/mcp-cost.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mcp-cost-'));
const NODE = process.execPath;

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

/* ---------------- fixtures ---------------- */

/** Escreve um servidor stdio sintético e devolve o spec pronto para sondar. */
function fixture(name, body) {
  const file = path.join(TMP, `${name}.cjs`);
  fs.writeFileSync(file, body, 'utf8');
  return { name, ide: 'fixture', file, spec: { command: NODE, args: [file] }, transport: 'stdio' };
}

const READER = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
`;

/* Servidor saudável: 2 ferramentas, tamanhos conhecidos. */
const GOOD = fixture('good', `${READER}
const TOOLS = [
  { name: 'alpha', description: 'A'.repeat(100), inputSchema: { type: 'object', properties: {} } },
  { name: 'beta',  description: 'B'.repeat(300), inputSchema: { type: 'object', properties: {} } },
];
function handle(msg) {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'good', version: '9.9.9' } } });
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }); process.exit(0); }
}
`);

/* Servidor gordo: uma ferramenta muito maior que todas as do "good". */
const FAT = fixture('fat', `${READER}
const TOOLS = [{ name: 'megatool', description: 'C'.repeat(5000), inputSchema: { type: 'object', properties: {} } }];
function handle(msg) {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'fat', version: '1' } } });
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } }); process.exit(0); }
}
`);

/* Servidor que loga lixo em stdout antes de responder — caso real e comum. */
const NOISY = fixture('noisy', `${READER}
process.stdout.write('starting up, listening on stdio...\\n');
function handle(msg) {
  process.stdout.write('[debug] got ' + msg.method + '\\n');
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'noisy', version: '1' } } });
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'x', description: 'y', inputSchema: {} }] } }); process.exit(0); }
}
`);

/* Servidor que responde initialize e falha em tools/list. */
const ERRORING = fixture('erroring', `${READER}
function handle(msg) {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'err', version: '1' } } });
  if (msg.method === 'tools/list') { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'sem ferramentas aqui' } }); process.exit(0); }
}
`);

/* Servidor que morre na largada. */
const CRASHER = fixture('crasher', `process.stderr.write('boom: faltou variavel de ambiente\\n'); process.exit(1);`);

/* Servidor que responde tudo e NUNCA encerra — precisa cair no timeout e ainda medir. */
const HANGER = fixture('hanger', `${READER}
function handle(msg) {
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'hang', version: '1' } } });
  if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'h', description: 'z', inputSchema: {} }] } });
}
setInterval(() => {}, 1000);
`);

console.log('');
console.log('  token-guard · mcp-cost');
console.log('  ' + '─'.repeat(72));
console.log('  [handshake]');

/* ================================================================== */
/* Sondagem                                                           */
/* ================================================================== */

{
  const r = MC.probe(GOOD);
  check('servidor saudável responde e é medido', r.ok && r.tools.length === 2, JSON.stringify(r).slice(0, 200));
  check('serverInfo do initialize é preservado', r.serverInfo && r.serverInfo.name === 'good', JSON.stringify(r.serverInfo));
  check('schemaChars é a soma das ferramentas', r.schemaChars === r.tools.reduce((a, t) => a + t.chars, 0));
  check('a ferramenta maior mede mais que a menor',
    r.tools.find((t) => t.name === 'beta').chars > r.tools.find((t) => t.name === 'alpha').chars);
}

{
  const r = MC.probe(NOISY);
  check('lixo em stdout não impede a medição', r.ok && r.tools.length === 1, r.error);
}

{
  const r = MC.probe(ERRORING);
  check('erro em tools/list vira ok:false com motivo', !r.ok && /sem ferramentas aqui/.test(r.error || ''), r.error);
}

{
  const r = MC.probe(CRASHER);
  check('servidor que morre não derruba a sonda', r.ok === false && !!r.error, JSON.stringify(r));
  check('o motivo da morte chega ao relatório', /boom|sem resposta/.test(r.error || ''), r.error);
}

{
  const r = MC.probe(HANGER, { timeoutMs: 2500 });
  check('servidor que não encerra ainda é medido (timeout não é falha)', r.ok && r.tools.length === 1, r.error);
}

{
  const r = MC.probe({ name: 'remoto', ide: 'x', spec: { url: 'https://exemplo/mcp' }, transport: 'http' });
  check('transporte não-stdio é recusado explicitamente, não silenciosamente',
    !r.ok && /não é sondável/.test(r.error || ''), r.error);
}

/* ================================================================== */
/* Consolidação                                                       */
/* ================================================================== */

console.log('');
console.log('  [consolidação]');

{
  const m = MC.measure([GOOD, FAT, CRASHER], { timeoutMs: 8000 });
  check('totais somam só o que foi sondado', m.totals.probed === 2 && m.totals.failed === 1, JSON.stringify(m.totals));
  check('contagem de ferramentas é a soma dos servidores vivos', m.totals.toolCount === 3, String(m.totals.toolCount));
  check('schemaTokens = schemaChars / charsPerToken',
    m.totals.schemaTokens === Math.round(m.totals.schemaChars / 4), JSON.stringify(m.totals));
  // `windows` guarda a fração exata; `schemaTokens` é arredondado para exibição.
  // O invariante é contra os chars, não contra o número já arredondado.
  check('janelas é fração coerente da janela de contexto',
    Math.abs(m.totals.windows - m.totals.schemaChars / 4 / 200000) < 1e-9, String(m.totals.windows));

  const fat = m.servers.find((s) => s.name === 'fat');
  const good = m.servers.find((s) => s.name === 'good');
  check('o servidor gordo mede mais que o magro', fat.schemaChars > good.schemaChars);

  const txt = MC.renderText(m);
  check('o relatório nomeia o servidor mais caro', /megatool/.test(txt));
  check('o relatório expõe quem não respondeu', /crasher/.test(txt), txt.slice(0, 300));
  check('o relatório não inventa custo para quem falhou', !/crasher.*\d+ tok/.test(txt));
}

/* ================================================================== */
/* Descoberta (sem executar nada)                                     */
/* ================================================================== */

console.log('');
console.log('  [descoberta]');

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home-'));
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify({
    mcpServers: {
      um: { command: 'node', args: ['a.js'] },
      dois: { url: 'https://exemplo/mcp' },
    },
  }), 'utf8');

  const found = MC.discover({ home, cwd: home });
  check('descobre servidores sem executar nenhum', found.length === 2, JSON.stringify(found.map((f) => f.name)));
  check('classifica o transporte de cada um',
    found.find((f) => f.name === 'um').transport === 'stdio' &&
    found.find((f) => f.name === 'dois').transport === 'http',
    JSON.stringify(found.map((f) => [f.name, f.transport])));
}

{
  // O mesmo servidor declarado em duas IDEs é UM custo por sessão, não dois.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home2-'));
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.mkdirSync(path.join(home, '.token-guard'), { recursive: true });
  const spec = { mcpServers: { repetido: { command: 'node', args: ['x.js'] } } };
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), JSON.stringify(spec), 'utf8');
  fs.writeFileSync(path.join(home, '.token-guard', 'mcp.json'), JSON.stringify(spec), 'utf8');

  const found = MC.discover({ home, cwd: home });
  check('servidor declarado em duas IDEs conta uma vez', found.length === 1, JSON.stringify(found.map((f) => f.file)));
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home3-'));
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), '{ isto não é json', 'utf8');
  const found = MC.discover({ home, cwd: home });
  check('config ilegível é reportada, não engolida',
    found.length === 1 && found[0].transport === 'erro', JSON.stringify(found));
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home4-'));
  const found = MC.discover({ home, cwd: home });
  check('máquina sem MCP nenhum não quebra', Array.isArray(found) && found.length === 0);
}

{
  // A chave externa varia por IDE: "servers" em vez de "mcpServers".
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-home5-'));
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'),
    JSON.stringify({ servers: { alt: { command: 'node', args: ['y.js'] } } }), 'utf8');
  const found = MC.discover({ home, cwd: home });
  check('aceita a chave "servers" além de "mcpServers"', found.length === 1 && found[0].name === 'alt');
}

/* ================================================================== */
/* Diagnóstico de falha — o motivo tem que ser útil, não o rodapé      */
/* ================================================================== */

console.log('');
console.log('  [diagnóstico]');

{
  // Regressão real: um servidor que morre imprime a versão do Node por último.
  // Reportar "Node.js v24.14.1" como causa é inútil.
  const stack = [
    'node:internal/modules/cjs/loader:1215',
    '  throw err;',
    '  ^',
    "Error: Cannot find module 'vercel-mcp'",
    '    at Module._resolveFilename (node:internal/modules/cjs/loader:1212:15)',
    '',
    'Node.js v24.14.1',
  ].join('\n');
  const why = MC.firstErrorLine(stack);
  check('o motivo é a causa, não o rodapé de versão do Node',
    /Cannot find module/.test(why) && !/^Node\.js v/.test(why), why);
  check('o motivo não vem de linha de stack trace', !/^\s*at\s/.test(why), why);
}

{
  check('stderr vazio não inventa motivo', MC.firstErrorLine('') === '');
  check('stderr sem palavra de erro ainda devolve algo útil',
    MC.firstErrorLine('boot abortado na etapa 3') === 'boot abortado na etapa 3');
}

{
  const r = MC.spawnPlan(process.execPath, ['-e', '0']);
  check('executável real roda sem shell',
    r.shell === false && r.command === process.execPath && r.args.length === 2);

  if (process.platform === 'win32') {
    /* Regressão: o Node recusa spawnar .cmd sem shell (EINVAL desde o
       CVE-2024-27980). npx/uvx são .cmd — sem isto, nenhum servidor lançado
       por npx é sondado. */
    const c = MC.spawnPlan('C:\\bin\\npx.cmd', ['-y', 'algum pacote']);
    check('.cmd exige shell, senão dá EINVAL', c.shell === true);
    check('.cmd manda linha única, sem array de args (evita DEP0190)',
      c.args.length === 0 && c.command.startsWith('"C:\\bin\\npx.cmd"'));
    check('argumento com espaço vai entre aspas', c.command.includes('"algum pacote"'));
    check('argumento simples não ganha aspas à toa', / -y /.test(c.command));

    const b = MC.spawnPlan('setup.BAT', []);
    check('.bat também exige shell, sem depender de caixa', b.shell === true);
  } else {
    const c = MC.spawnPlan('npx', ['-y', 'pkg']);
    check('fora do Windows nada de shell', c.shell === false && c.args.length === 2);
  }
}

/* ================================================================== */
/* Recomendações acionáveis — medir sem sugerir é metade do trabalho    */
/* ================================================================== */

console.log('');
console.log('  [recomendações]');

{
  const mk = (name, schemaChars, tools, ok = true) => ({
    name, ok, transport: 'stdio', tools: (tools || []).map((t) => ({ name: t[0], chars: t[1] })),
    schemaChars,
  });
  const result = {
    servers: [
      mk('github', 16000, [['create_issue', 3000], ['list_prs', 2500]]),
      mk('leve', 800, [['ping', 400]]),
      mk('morto', 0, [], false),
    ],
    totals: { charsPerToken: 4, contextWindow: 200000 },
  };

  const advices = MC.advise(result);

  check('servidor gordo recebe recomendação',
    advices.some((a) => a.server === 'github' && a.kind === 'server-heavy'), JSON.stringify(advices));
  check('ferramenta individual cara recebe recomendação',
    advices.some((a) => a.server === 'github' && a.tool === 'create_issue'));
  check('servidor leve não gera ruído',
    !advices.some((a) => a.server === 'leve'));
  check('servidor que falhou não recebe recomendação inventada',
    !advices.some((a) => a.server === 'morto'));

  const text = MC.renderText({
    servers: result.servers,
    totals: { ...result.totals, declared: 3, probed: 2, failed: 1, toolCount: 3, schemaChars: 16800, schemaTokens: 4200, windows: 0.021 },
    elapsedMs: 10,
  });
  check('renderText inclui a seção de recomendações',
    /RECOMENDA/.test(text) && /github/.test(text));
}

/* ================================================================== */

console.log('');
console.log('  ' + '─'.repeat(72));
console.log(`  ${pass} passaram · ${fail} falharam`);
console.log('');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

process.exit(fail === 0 ? 0 : 1);
