#!/usr/bin/env node
'use strict';
/**
 * cli.cjs — porta de entrada do token-guard.
 *
 *   npx @allansantos-dev/token-guard init [caminho] [--mode warn] [--dry-run] [--global]
 *   npx @allansantos-dev/token-guard audit [caminho] [--md|--json] [--top N]
 *   npx @allansantos-dev/token-guard status [caminho]
 *   npx @allansantos-dev/token-guard contract [caminho]
 *   npx @allansantos-dev/token-guard test
 *
 * Roteia para os scripts, que continuam executáveis diretamente — quem instalou
 * pelo repositório chama `node .github/token-guard/token-audit.cjs` do mesmo jeito.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const argv = process.argv.slice(2);
const cmd = (argv[0] || '').toLowerCase();
const rest = argv.slice(1);

const SCRIPTS = {
  init: 'install.cjs',
  install: 'install.cjs',
  audit: 'token-audit.cjs',
  test: 'selftest.cjs',
  selftest: 'selftest.cjs',
  mcp: path.join('adapters', 'mcp-server.cjs'),
  'mcp-cost': 'mcp-cost.cjs',
  contract: 'contract.cjs',
};

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], {
    stdio: 'inherit',
  });
  process.exit(r.status === null ? 1 : r.status);
}

function status(args) {
  const root = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
  const CFG = require('./lib/config.cjs');
  const cfg = CFG.load(root);
  const stats = CFG.repoStats(root);
  const on = Object.entries(cfg.rules || {}).filter(([, v]) => v !== false).map(([k]) => k);

  console.log('');
  console.log(`  token-guard · ${root}`);
  console.log('  ' + '─'.repeat(66));
  console.log(`  modo:            ${cfg.mode}`);
  console.log(`  config:          ${cfg._source}`);
  console.log(`  regras ativas:   ${on.join(', ') || '(nenhuma)'}`);
  console.log(`  leitura s/faixa: acima de ${cfg.limits.readBytesWithoutRange} bytes`);
  console.log(`  guarda varredura: a partir de ${cfg.limits.minRepoFilesForScanGuard} arquivos`);
  console.log(stats
    ? `  cache:           ${Number(stats.totalFiles).toLocaleString('pt-BR')} arquivos medidos`
    : '  cache:           ausente — rode `token-guard audit` para calibrar');
  if (cfg.mode === 'off') {
    console.log('');
    console.log('  ATENÇÃO: o guard está DESLIGADO (mode "off" ou TOKEN_GUARD=off).');
  }
  console.log('');
}

function help() {
  console.log(`
  token-guard · economia de contexto para agentes de IA

  COMANDOS

    init [caminho]        Instala. Escolha onde com --target:

                            copilot   Copilot CLI / Copilot App   (bloqueia)
                            claude    Claude Code                 (bloqueia)
                            cursor    Cursor (recente)            (bloqueia)
                            mcp       qualquer IDE com MCP        (só orienta)
                            repo      .github/ do repositório      (viaja no git)
                            all       copilot + claude + cursor + mcp

                          --mode warn   começa avisando em vez de bloquear
                          --dry-run     simula, não escreve nada
                          --force       sobrescreve config já existente

    audit [caminho]       Mede o custo de contexto do repositório.
                          --md          relatório em markdown
                          --json        dados crus
                          --top N       quantos itens nos rankings
                          --no-cache    não grava o cache de calibração

    status [caminho]      Mostra a configuração ativa.

    mcp                   Sobe o MCP server (stdio). Use no campo "command"
                          da configuração MCP do seu IDE.

    mcp-cost [caminho]    Mede quanto os servidores MCP declarados custam de
                          preâmbulo, em toda sessão, antes da primeira pergunta.
                          --list        só inventaria (não executa nada)
                          --server NOME mede um servidor só
                          --timeout MS  teto por handshake (padrão 15000)
                          --json        dados crus
                          Sem --list, os servidores declarados SÃO EXECUTADOS:
                          é a única forma de saber o tamanho real dos schemas.

    contract [caminho]    Mostra o contrato de saída em vigor: quantas regras
                          por seção, quanto custa de entrada e o que entraria
                          numa sessão.
                          --touched a.js,b.md  simula a evidência da sessão
                          --subagente   só o bloco de contexto descartável
                          --json        dados crus

    test                  Roda a bateria de testes contra o hook real.

  COMEÇANDO

    npx @allansantos-dev/token-guard audit                       # veja o tamanho do problema
    npx @allansantos-dev/token-guard init --target all --mode warn   # instale sem atrito
    npx @allansantos-dev/token-guard test                        # confirme que responde aqui

  Depois reinicie a sessão do agente para carregar o hook.
  Emergência: TOKEN_GUARD=off desliga sem editar arquivo.

  Cobertura real por IDE: docs/IDES.md
`);
}

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  help();
  process.exit(0);
}

if (cmd === 'status') {
  status(rest);
  process.exit(0);
}

if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  console.log(require('./package.json').version);
  process.exit(0);
}

const script = SCRIPTS[cmd];
if (!script) {
  console.error(`token-guard: comando desconhecido "${cmd}". Use \`token-guard help\`.`);
  process.exit(1);
}
run(script, rest);
