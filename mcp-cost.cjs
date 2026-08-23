#!/usr/bin/env node
'use strict';
/**
 * mcp-cost.cjs — CLI do medidor de custo de preâmbulo MCP.
 *
 *   node mcp-cost.cjs [caminho] [--json] [--list] [--timeout MS] [--server NOME]
 *
 * `--list` inventaria sem executar nada. Sem ele, os servidores declarados SÃO
 * EXECUTADOS para o handshake — é a única forma de saber quantas ferramentas
 * cada um declara e quanto pesam os schemas.
 *
 * Sem dependências. Só Node stdlib.
 */

const path = require('path');
const fs = require('fs');
const MC = require('./lib/mcp-cost.cjs');
const CFG = require('./lib/config.cjs');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && !['--timeout', '--server'].includes(argv[i - 1]));

const ROOT = path.resolve(positional[0] || process.cwd());
if (!fs.existsSync(ROOT)) {
  console.error(`mcp-cost: caminho não encontrado: ${ROOT}`);
  process.exit(1);
}

const cfg = CFG.load(ROOT);
const only = opt('--server', null);
// Configs extras fora dos locais conhecidos (Zed, JetBrains, frotas próprias):
// --extra-files a.json,b.json — nada é executado por isso; só o inventário cresce.
const extraFiles = String(opt('--extra-files', '') || '')
  .split(',').map((s) => s.trim()).filter(Boolean)
  .map((f) => path.resolve(f));

let servers = MC.discover({ cwd: ROOT, extraFiles });
if (only) servers = servers.filter((s) => s.name === only);

if (!servers.length) {
  console.error(only
    ? `mcp-cost: nenhum servidor MCP chamado "${only}" foi declarado.`
    : 'mcp-cost: nenhum servidor MCP declarado nas configurações conhecidas.');
  process.exit(only ? 1 : 0);
}

/* --list: inventário, sem spawn. */
if (flag('--list')) {
  if (flag('--json')) {
    console.log(JSON.stringify(servers.map((s) => ({ name: s.name, ide: s.ide, file: s.file, transport: s.transport })), null, 2));
  } else {
    console.log('');
    console.log('  servidores MCP declarados (nada foi executado)');
    console.log('  ' + '─'.repeat(74));
    for (const s of servers) console.log(`  ${s.name.padEnd(24)} ${s.transport.padEnd(12)} ${s.ide}`);
    console.log('');
  }
  process.exit(0);
}

const result = MC.measure(servers, {
  timeoutMs: Math.max(1000, parseInt(opt('--timeout', '15000'), 10) || 15000),
  charsPerToken: cfg.charsPerToken,
  contextWindow: cfg.contextWindow,
});

if (flag('--json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(MC.renderText(result));
}
