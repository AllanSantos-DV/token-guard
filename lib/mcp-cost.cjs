'use strict';
/**
 * mcp-cost.cjs — quanto custa, em tokens de preâmbulo, cada servidor MCP declarado.
 *
 * Por que existe: o `token-audit` mede o que o agente lê DEPOIS de começar a
 * trabalhar. Este módulo mede o que já está na janela ANTES da primeira palavra —
 * o schema de toda ferramenta que os servidores MCP declarados injetam na sessão.
 *
 * Por que por handshake e não por leitura de config: o arquivo de configuração diz
 * QUE o servidor existe, nunca QUANTAS ferramentas ele declara nem o tamanho dos
 * schemas. Só o protocolo responde isso. Então falamos JSON-RPC de verdade:
 * `initialize` → `notifications/initialized` → `tools/list`.
 *
 * AVISO: sondar significa EXECUTAR o `command` declarado na config. São processos
 * que o usuário já roda na própria IDE, mas quem chama precisa saber que há spawn.
 * Use `discover()` sozinho para inventariar sem executar nada.
 *
 * Sem dependências. Só Node stdlib.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

/* ---------------- descoberta ---------------- */

/**
 * Arquivos onde as IDEs guardam declaração de servidor MCP.
 * Caminho relativo ao HOME, salvo quando absoluto.
 */
const CONFIG_LOCATIONS = [
  { ide: 'Claude Code', rel: ['.claude.json'] },
  { ide: 'Claude Code', rel: ['.claude', 'settings.json'] },
  { ide: 'Cursor', rel: ['.cursor', 'mcp.json'] },
  { ide: 'Windsurf', rel: ['.codeium', 'windsurf', 'mcp_config.json'] },
  { ide: 'Claude Desktop', rel: ['AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'] },
  { ide: 'Claude Desktop', rel: ['Library', 'Application Support', 'Claude', 'claude_desktop_config.json'] },
  { ide: 'token-guard', rel: ['.token-guard', 'mcp.json'] },
];

/**
 * Inventaria servidores MCP declarados. NÃO executa nada.
 * @param {{home?:string, extraFiles?:string[], cwd?:string}} opts
 * @returns {Array<{name:string, ide:string, file:string, spec:object, transport:string}>}
 */
function discover({ home = os.homedir(), extraFiles = [], cwd = process.cwd() } = {}) {
  const files = [
    ...CONFIG_LOCATIONS.map((l) => ({ ide: l.ide, file: path.join(home, ...l.rel) })),
    // config de projeto: viaja no repositório, então costuma ser esquecida na conta
    { ide: 'VS Code (projeto)', file: path.join(cwd, '.vscode', 'mcp.json') },
    { ide: 'Cursor (projeto)', file: path.join(cwd, '.cursor', 'mcp.json') },
    ...extraFiles.map((f) => ({ ide: 'extra', file: f })),
  ];

  const found = [];
  const seen = new Set();
  const seenFiles = new Set();

  for (const { ide, file } of files) {
    if (!fs.existsSync(file)) continue;
    // O mesmo arquivo pode aparecer por dois caminhos (ex.: cwd === home).
    // Ler duas vezes duplicaria tanto os servidores quanto os erros de parse.
    const realFile = (() => { try { return fs.realpathSync(file); } catch { return file; } })();
    if (seenFiles.has(realFile)) continue;
    seenFiles.add(realFile);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      // Fail loud: config ilegível é um achado, não um silêncio.
      found.push({ name: '(config ilegível)', ide, file, spec: null, transport: 'erro', error: err.message });
      continue;
    }
    const bag = json.mcpServers || json.servers || {};
    for (const [name, spec] of Object.entries(bag)) {
      if (!spec || typeof spec !== 'object') continue;
      const key = `${name}::${JSON.stringify(spec.args || spec.url || '')}`;
      if (seen.has(key)) continue; // mesmo servidor declarado em duas IDEs conta uma vez
      seen.add(key);
      found.push({ name, ide, file, spec, transport: transportOf(spec) });
    }
  }
  return found;
}

function transportOf(spec) {
  if (spec.command) return 'stdio';
  if (spec.url || spec.type === 'http' || spec.type === 'sse') return spec.type || 'http';
  return 'desconhecido';
}

/* ---------------- handshake ---------------- */

const PROTOCOL_VERSION = '2024-11-05';

/** Aspas no estilo cmd.exe, para quando o shell é inevitável. */
function quoteWin(s) {
  return /[\s"&|<>^]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s);
}

/**
 * Monta o plano de spawn de um servidor stdio. Duas armadilhas do Windows:
 *
 *  1. `npx`/`uvx` são `.cmd`, e desde a correção do CVE-2024-27980 o Node
 *     RECUSA spawnar `.cmd`/`.bat` sem shell — dá EINVAL. Para esses, shell é
 *     obrigatório, não preferência.
 *  2. Com `shell:true` mais array de args, o Node avisa (DEP0190) que os
 *     argumentos não são escapados. Então quando o shell é obrigatório nós
 *     mesmos montamos a linha, já com aspas, e mandamos args vazio.
 *
 * Um `.exe` (ou qualquer coisa fora do Windows) roda direto, sem shell.
 * @returns {{command:string, args:string[], shell:boolean}}
 */
function spawnPlan(command, args = []) {
  const needsShell = (file) => /\.(cmd|bat)$/i.test(file);
  const viaShell = (file) => ({
    // O executável vai SEMPRE entre aspas: "C:\Program Files\..." é o caso comum.
    command: [`"${file}"`, ...args.map(quoteWin)].join(' '),
    args: [],
    shell: true,
  });

  if (process.platform !== 'win32') return { command, args, shell: false };
  if (path.extname(command)) return needsShell(command) ? viaShell(command) : { command, args, shell: false };
  if (command.includes('/') || command.includes('\\')) return { command, args, shell: false };

  const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      try {
        if (fs.existsSync(candidate)) {
          return needsShell(candidate) ? viaShell(candidate) : { command: candidate, args, shell: false };
        }
      } catch { /* diretório inacessível no PATH não é problema nosso */ }
    }
  }
  // Não achamos no PATH: deixa o shell resolver.
  return viaShell(command);
}

/** A primeira linha que EXPLICA a falha — não o rodapé de versão que o Node imprime. */
function firstErrorLine(stderr) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const noise = /^(Node\.js v|\s*at\s|\(Use `node|\(node:\d+\))/;
  const signal = /(error|erro|cannot|not found|ENOENT|EACCES|EPERM|missing|required|denied|abortado|failed|falh)/i;
  const meaningful = lines.filter((l) => !noise.test(l));
  return (meaningful.find((l) => signal.test(l)) || meaningful[0] || '').replace(/\s+/g, ' ');
}

function rpcLines() {
  return [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'token-guard', version: 'probe' },
      },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  ].join('\n') + '\n';
}

/** Extrai objetos JSON-RPC de um stdout que pode vir com lixo no meio. */
function parseFrames(stdout) {
  const frames = [];
  for (const line of String(stdout || '').split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      frames.push(JSON.parse(t));
    } catch {
      /* linha corrompida é ignorada — o servidor pode logar em stdout */
    }
  }
  return frames;
}

/**
 * Sonda UM servidor stdio. EXECUTA o command declarado.
 * Nunca lança: um servidor quebrado vira um registro com `ok:false` e o motivo.
 * @returns {{name:string, ok:boolean, transport:string, serverInfo?:object,
 *            tools:Array<{name:string, chars:number}>, schemaChars:number, error?:string}}
 */
function probe(server, { timeoutMs = 15000 } = {}) {
  const base = { name: server.name, ide: server.ide, transport: server.transport, tools: [], schemaChars: 0 };

  if (server.transport !== 'stdio') {
    return { ...base, ok: false, error: `transporte "${server.transport}" não é sondável por stdio` };
  }

  const { command, args = [], env = {} } = server.spec;
  const plan = spawnPlan(command, args);
  let res;
  try {
    res = spawnSync(plan.command, plan.args, {
      input: rpcLines(),
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, ...env },
      windowsHide: true,
      shell: plan.shell,
    });
  } catch (err) {
    return { ...base, ok: false, error: `spawn falhou: ${err.message}` };
  }

  // Timeout NÃO é falha automática: muitos servidores não encerram no EOF do stdin,
  // e a essa altura já responderam tudo que pedimos. Julgamos pelo que chegou.
  const frames = parseFrames(res.stdout);
  const initFrame = frames.find((f) => f.id === 1);
  const listFrame = frames.find((f) => f.id === 2);

  if (!listFrame) {
    const why = firstErrorLine(res.stderr)
      || (initFrame ? 'respondeu initialize mas não tools/list' : null)
      || (res.error && res.error.message)
      || 'sem resposta JSON-RPC';
    return { ...base, ok: false, error: why.slice(0, 160) };
  }

  if (listFrame.error) {
    return { ...base, ok: false, error: `tools/list: ${listFrame.error.message || JSON.stringify(listFrame.error)}` };
  }

  const tools = (listFrame.result && listFrame.result.tools) || [];
  const measured = tools.map((t) => ({
    name: t.name,
    // O que o modelo paga é o schema serializado: nome + descrição + inputSchema.
    chars: JSON.stringify(t).length,
    descChars: (t.description || '').length,
  }));

  return {
    ...base,
    ok: true,
    serverInfo: initFrame && initFrame.result ? initFrame.result.serverInfo : undefined,
    tools: measured,
    schemaChars: measured.reduce((a, t) => a + t.chars, 0),
  };
}

/**
 * Sonda todos os servidores e consolida o custo.
 * @returns {{servers:Array, totals:object, elapsedMs:number}}
 */
function measure(servers, { timeoutMs = 15000, charsPerToken = 4, contextWindow = 200000 } = {}) {
  const start = Date.now();
  const probed = servers.map((s) => probe(s, { timeoutMs }));

  const ok = probed.filter((p) => p.ok);
  const schemaChars = ok.reduce((a, p) => a + p.schemaChars, 0);
  const toolCount = ok.reduce((a, p) => a + p.tools.length, 0);

  return {
    servers: probed,
    totals: {
      declared: servers.length,
      probed: ok.length,
      failed: probed.length - ok.length,
      toolCount,
      schemaChars,
      schemaTokens: Math.round(schemaChars / charsPerToken),
      windows: schemaChars / charsPerToken / contextWindow,
      contextWindow,
      charsPerToken,
    },
    elapsedMs: Date.now() - start,
  };
}

/* ---------------- relatório ---------------- */

const n = (x) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

function bar(fraction, width = 26) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

/* ---------------- recomendações ---------------- */

/**
 * Traduz a medição em ações candidatas. O medidor não sabe QUANTO você usa
 * cada servidor — então toda recomendação é condicional ao uso, e quem
 * decide é você. Limiares: servidor >1.5k tokens de schema; ferramenta
 * individual >500 tokens (descrição gorda).
 * @returns {Array<{kind:'server-heavy'|'tool-heavy', server:string, tool?:string, tokens:number, advice:string}>}
 */
function advise(result) {
  const out = [];
  const cpt = result.totals.charsPerToken || 4;
  const tok = (chars) => Math.round(chars / cpt);

  for (const s of result.servers || []) {
    if (!s.ok) continue; // sem medição não há recomendação inventada
    if (s.schemaChars / cpt > 1500) {
      out.push({
        kind: 'server-heavy',
        server: s.name,
        tokens: tok(s.schemaChars),
        advice:
          `considere desligar em sessões que não o usam, ou substituir por uma versão slim ` +
          `(agrupamento de ferramentas costuma cortar ~50%)`,
      });
    }
    for (const t of s.tools || []) {
      if (t.chars / cpt > 500) {
        out.push({
          kind: 'tool-heavy',
          server: s.name,
          tool: t.name,
          tokens: tok(t.chars),
          advice: `descrição longa — encurtar o description deste servidor derruba o preâmbulo inteiro`,
        });
      }
    }
  }
  return out;
}

function renderAdvice(advices, pad = 26) {
  if (!advices.length) return [];
  const L = ['', '  RECOMENDAÇÕES (condicionais ao seu uso real — o medidor não vê uso)', '  ' + '·'.repeat(74)];
  for (const a of advices.slice(0, 8)) {
    const alvo = a.tool ? `${a.server} › ${a.tool}` : a.server;
    L.push(`  ${alvo.slice(0, pad).padEnd(pad)} ${String(n(a.tokens)).padStart(6)} tok  ${a.advice}`);
  }
  L.push('');
  return L;
}

function renderText(result) {
  const { servers, totals, elapsedMs } = result;
  const W = 74;
  const out = [];
  const p = (s = '') => out.push(s);
  const tok = (chars) => Math.round(chars / totals.charsPerToken);

  p('');
  p('  mcp-cost · custo de preâmbulo dos servidores MCP declarados');
  p(`  ${'─'.repeat(W)}`);
  p(`  ${totals.declared} declarados · ${totals.probed} sondados · ${totals.failed} sem resposta · ${(elapsedMs / 1000).toFixed(1).replace('.', ',')}s`);
  p(`  janela de referência: ${n(totals.contextWindow)} tokens · ${totals.charsPerToken} caracteres por token`);
  p('');

  const okServers = servers.filter((s) => s.ok).sort((a, b) => b.schemaChars - a.schemaChars);
  const maxChars = okServers.length ? okServers[0].schemaChars : 1;

  if (okServers.length) {
    p('  SERVIDOR                     FERRAM.     TOKENS   JANELAS');
    p('  ' + '·'.repeat(W));
    for (const s of okServers) {
      const t = tok(s.schemaChars);
      p(`  ${s.name.slice(0, 26).padEnd(26)} ${String(s.tools.length).padStart(7)} ${String(n(t)).padStart(10)}   ${(s.schemaChars / totals.charsPerToken / totals.contextWindow).toFixed(3).replace('.', ',')}`);
      p(`  ${' '.repeat(26)} ${bar(s.schemaChars / maxChars)}`);
    }
    p('');
  }

  const bad = servers.filter((s) => !s.ok);
  if (bad.length) {
    p('  NÃO SONDADOS — contam na janela mesmo assim, só não sabemos quanto');
    p('  ' + '·'.repeat(W));
    for (const s of bad) p(`  ${s.name.slice(0, 26).padEnd(26)} ${s.error}`);
    p('');
  }

  p(`  ${'─'.repeat(W)}`);
  p('  O QUE ISSO CUSTA ANTES DA PRIMEIRA PERGUNTA');
  p('');
  p(`  ${n(totals.toolCount)} ferramentas em ${totals.probed} servidores`);
  p(`  ≈ ${n(totals.schemaTokens)} tokens de schema`);
  p(`  = ${totals.windows.toFixed(3).replace('.', ',')} janela(s) de contexto, em toda sessão, use ou não`);
  p('');

  // As ferramentas mais caras individualmente — é onde mora a decisão de desligar.
  const allTools = okServers.flatMap((s) => s.tools.map((t) => ({ ...t, server: s.name })));
  if (allTools.length) {
    allTools.sort((a, b) => b.chars - a.chars);
    p('  FERRAMENTAS MAIS CARAS');
    p('  ' + '·'.repeat(W));
    for (const t of allTools.slice(0, 10)) {
      p(`  ${String(n(tok(t.chars))).padStart(6)} tok  ${t.name.slice(0, 34).padEnd(36)} ${t.server.slice(0, 20)}`);
    }
    p('');
  }

  for (const l of renderAdvice(advise(result))) p(l);

  return out.join('\n');
}

module.exports = {
  discover, probe, measure, renderText, advise, renderAdvice,
  transportOf, parseFrames, spawnPlan, firstErrorLine,
  CONFIG_LOCATIONS,
};
