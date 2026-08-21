#!/usr/bin/env node
'use strict';
/**
 * mcp-server.cjs — adapter MCP (Model Context Protocol), transporte stdio.
 *
 * POR QUE ESTE ADAPTER EXISTE
 *   Nem todo harness expõe hook pré-ferramenta. VS Code Copilot Chat, Windsurf,
 *   Zed e os plugins de JetBrains, hoje, não expõem. Nesses ambientes é
 *   impossível BARRAR uma chamada cara — mas ainda é possível dar ao agente as
 *   ferramentas para ele mesmo evitar o desperdício, e um veredito consultável.
 *
 *   Ou seja: aqui a economia é POR ORIENTAÇÃO, não por imposição. É uma
 *   degradação honesta, e está documentada como tal em docs/IDES.md. Onde houver
 *   hook nativo (Copilot, Claude Code, Cursor), use o hook — é enforcement real.
 *
 * FERRAMENTAS EXPOSTAS
 *   token_audit          mede o custo de contexto do repositório e calibra o cache
 *   token_guard_status   mostra config ativa, regras e limites
 *   token_guard_check    avalia uma chamada PLANEJADA e devolve a alternativa barata
 *
 * PROTOCOLO
 *   JSON-RPC 2.0, uma mensagem por linha (transporte stdio do MCP).
 *   Zero dependências: nada de SDK, porque o projeto precisa rodar em máquina
 *   corporativa sem `npm install`.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const CFG = require('../lib/config.cjs');
const AUDIT = require('../lib/audit.cjs');
const { decide } = require('../lib/decide.cjs');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER = { name: 'token-guard', version: require('../package.json').version };

let checked = 0;
const byRule = Object.create(null);

/* ------------------------------------------------------------------ */
/* Definição das ferramentas                                          */
/* ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'token_audit',
    description:
      'Mede o custo de contexto de um repositório: arquivos, volume, tokens, quantas ' +
      'janelas de contexto ele ocupa, quanto é ruído de build/dependência e quanto custa ' +
      'apenas listar os nomes dos arquivos. Também grava o cache que calibra os guardrails ' +
      'do token-guard. Use antes de explorar um repositório desconhecido.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Caminho do repositório. Padrão: diretório atual.' },
        format: { type: 'string', enum: ['texto', 'markdown', 'json'], description: 'Padrão: markdown.' },
      },
    },
    handler: (args) => {
      const root = args?.path ? path.resolve(args.path) : process.cwd();
      if (!fs.existsSync(root)) return { text: `Caminho não encontrado: ${root}`, isError: true };
      const cfg = CFG.load(root);
      const result = AUDIT.scan(root, cfg, { top: 10 });
      AUDIT.writeCache(root, result);
      if (args?.format === 'json') return { text: JSON.stringify({ ...result.stats, ...result.derived }, null, 2) };
      if (args?.format === 'texto') return { text: AUDIT.renderText(result, cfg, { configSource: cfg._source }) };
      return { text: AUDIT.renderMarkdown(result, cfg) };
    },
  },

  {
    name: 'token_guard_status',
    description:
      'Mostra a configuração ativa do token-guard (modo, regras habilitadas, limites, ' +
      'origem do arquivo de config) e quantas chamadas foram avaliadas nesta sessão.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Repositório a inspecionar. Padrão: diretório atual.' },
      },
    },
    handler: (args) => {
      const root = args?.path || process.cwd();
      const cfg = CFG.load(root);
      const stats = CFG.repoStats(root);
      const on = Object.entries(cfg.rules || {}).filter(([, v]) => v !== false).map(([k]) => k);

      const lines = [
        `modo: ${cfg.mode}`,
        `transporte: MCP (advisory — este harness não permite bloquear a chamada)`,
        `config: ${cfg._source}`,
        `regras ativas: ${on.join(', ') || '(nenhuma)'}`,
        `limite de leitura sem faixa: ${cfg.limits.readBytesWithoutRange} bytes`,
        `guarda de varredura a partir de: ${cfg.limits.minRepoFilesForScanGuard} arquivos`,
        stats
          ? `cache do repositório: ${Number(stats.totalFiles).toLocaleString('pt-BR')} arquivos medidos`
          : 'cache do repositório: ausente — rode token_audit para calibrar os limites',
        '',
        `chamadas avaliadas nesta sessão: ${checked}`,
      ];
      for (const [rule, n] of Object.entries(byRule)) lines.push(`  ${rule}: ${n}`);
      if (cfg.mode === 'off') lines.push('', 'ATENÇÃO: o guard está DESLIGADO (mode "off" ou TOKEN_GUARD=off).');
      return { text: lines.join('\n') };
    },
  },

  {
    name: 'token_guard_check',
    description:
      'Avalia uma chamada de ferramenta ANTES de executá-la e diz se ela desperdiça ' +
      'contexto. Se desperdiçar, devolve a alternativa barata pronta para reexecutar. ' +
      'Use quando for varrer o repositório, ler um arquivo grande inteiro ou rodar um ' +
      'comando de shell que despeja árvore de diretórios.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Nome da ferramenta que você pretende chamar (ex: grep, view, bash).' },
        input: { type: 'object', description: 'Os argumentos que você passaria para ela.' },
        path: { type: 'string', description: 'Raiz do repositório. Padrão: diretório atual.' },
      },
      required: ['tool'],
    },
    handler: (args) => {
      const root = args?.path ? path.resolve(args.path) : process.cwd();
      checked += 1;
      const verdict = decide({ toolName: args?.tool, toolInput: args?.input || {}, cwd: root });
      if (!verdict) return { text: `OK — \`${args?.tool}\` com esses argumentos não desperdiça contexto. Pode executar.` };
      byRule[verdict.rule] = (byRule[verdict.rule] || 0) + 1;
      return {
        text:
          `EVITE esta chamada (regra: ${verdict.rule}, veredito: ${verdict.decision}).\n\n` +
          verdict.reason,
      };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------------------ */
/* JSON-RPC 2.0 sobre stdio                                           */
/* ------------------------------------------------------------------ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  if (id === undefined || id === null) return; // notificação: não se responde
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
      });

    case 'notifications/initialized':
    case 'initialized':
      return; // notificação, sem resposta

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const tool = TOOL_BY_NAME.get(params?.name);
      if (!tool) return replyError(id, -32602, `Ferramenta desconhecida: ${params?.name}`);
      try {
        const out = tool.handler(params?.arguments || {});
        return reply(id, {
          content: [{ type: 'text', text: String(out.text) }],
          isError: Boolean(out.isError),
        });
      } catch (err) {
        // Fail-open também aqui: o erro vira conteúdo, não derruba a sessão.
        return reply(id, {
          content: [{ type: 'text', text: `token-guard falhou: ${err && err.message ? err.message : err}` }],
          isError: true,
        });
      }
    }

    case 'resources/list':
      return reply(id, { resources: [] });

    case 'prompts/list':
      return reply(id, { prompts: [] });

    default:
      return replyError(id, -32601, `Método não suportado: ${method}`);
  }
}

function start() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const raw = line.trim();
    if (!raw) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // lixo na linha: ignora em silêncio, não derruba o servidor
    }
    try {
      handle(msg);
    } catch {
      replyError(msg?.id, -32603, 'Erro interno do token-guard');
    }
  });
  rl.on('close', () => process.exit(0));
}

if (require.main === module) start();

module.exports = { TOOLS, handle, start, PROTOCOL_VERSION };
