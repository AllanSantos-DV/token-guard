#!/usr/bin/env node
'use strict';
/**
 * cli.cjs — porta de entrada do token-guard.
 *
 *   npx @allansantos-dev/token-guard init [caminho] [--mode block|off] [--dry-run] [--global]
 *   npx @allansantos-dev/token-guard audit [caminho] [--md|--json] [--top N]
 *   npx @allansantos-dev/token-guard status [caminho]
 *   npx @allansantos-dev/token-guard setup [--no-open]
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
  cost: 'cost.cjs',
};

function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], {
    stdio: 'inherit',
  });
  process.exit(r.status === null ? 1 : r.status);
}

function updateCacheFile() {
  return path.join(require('os').homedir(), '.token-guard', 'update-check.json');
}

async function printUpdateNotice(prefix) {
  try {
    const UC = require('./lib/update-check.cjs');
    const localVersion = require('./package.json').version;
    const r = await UC.checkForUpdate({ localVersion, cacheFile: updateCacheFile() });
    if (r.checked && r.updateAvailable) {
      console.log(`${prefix}v${r.latestVersion} disponível (você está na v${r.localVersion}) — atualize: ${require('./lib/auto-update.cjs').manualCommand(r.latestVersion, 'all')} — novidades: ${UC.SITE_URL}`);
    }
  } catch { /* aviso de update é best-effort, nunca pode quebrar status/--version */ }
}

const approxTokens = (n) => (n >= 1e6 ? `~${(n / 1e6).toFixed(1).replace('.', ',')}M` : n >= 1e3 ? `~${Math.round(n / 1e3)}k` : String(n));

const twoDecimals = (n) => n.toFixed(2).replace('.', ',');

/** Linhas de bloqueios e tokens poupados, hoje e total, de `events.summary()`, com a estimativa em US$ e a conta usada. */
function savingsLines(s, prices) {
  if (!s.since) return ['  barrados:        nenhum registrado ainda (todas as sessões desta máquina)'];
  const since = new Date(s.since).toLocaleDateString('pt-BR');
  return [
    `  barrados:        hoje ${s.today.blocks} · total ${s.total.blocks} desde ${since} (todas as sessões desta máquina)`,
    `  tokens poupados: hoje ${approxTokens(s.today.tokensSaved)} · total ${approxTokens(s.total.tokensSaved)} (cortes e releituras evitadas, a 4 caracteres por token)`,
    usdLine(require('./lib/cost.cjs').savingsUsd({ today: s.today.tokensSaved, total: s.total.tokensSaved }, prices)),
  ];
}

/** Linha do repositório atual: só eventos gravados com a pasta; o histórico anterior não é repartido. */
function repoLines(r, prices) {
  const t = r.total;
  if (!t.blocks && !t.trims && !t.dups && !t.scouts) {
    return ['  neste repositório: nada registrado ainda (a conta por repositório só inclui eventos novos; o histórico anterior não é repartido)'];
  }
  const u = require('./lib/cost.cjs').savingsUsd({ today: r.today.tokensSaved, total: t.tokensSaved }, prices);
  return [
    `  neste repositório: barrados hoje ${r.today.blocks} · total ${t.blocks}; tokens poupados hoje ${approxTokens(r.today.tokensSaved)} · total ${approxTokens(t.tokensSaved)}`
      + (u ? ` ≈ US$ ${twoDecimals(u.total)} no total (mesma conta do US$ acima; aproximado)` : '')
      + ' — só eventos novos',
  ];
}

function usdLine(u) {
  if (!u) return '  em US$:          sem estimativa (o primeiro modelo de cost.prices não tem preço de entrada "in")';
  return `  em US$ (aprox.): hoje ≈ US$ ${twoDecimals(u.today)} · total ≈ US$ ${twoDecimals(u.total)} — estimativa: tokens × US$ ${String(u.inPerMtok).replace('.', ',')}/Mtok (entrada de ${u.model}, ${u.source})`;
}

async function status(args) {
  const root = path.resolve(args.find((a) => !a.startsWith('--')) || process.cwd());
  const CFG = require('./lib/config.cjs');
  const cfg = CFG.load(root);
  const stats = CFG.repoStats(root);
  const on = CFG.activeRules(cfg);

  if (args.includes('--json')) {
    const attempt = async (fn) => { try { return await fn(); } catch (e) { return { error: e.message }; } };
    const s = await attempt(() => require('./lib/events.cjs').summary());
    const out = {
      root, mode: cfg.mode, modeLabel: CFG.modeLabel(cfg), configSource: cfg._source, rules: on, targets: cfg.targets || {},
      limits: { readBytesWithoutRange: cfg.limits.readBytesWithoutRange, minRepoFilesForScanGuard: cfg.limits.minRepoFilesForScanGuard },
      repoStats: stats ? { totalFiles: stats.totalFiles } : null,
      saved: s.error ? s : { since: s.since, today: s.today, total: s.total,
        usd: require('./lib/cost.cjs').savingsUsd({ today: s.today.tokensSaved, total: s.total.tokensSaved }, require('./lib/cost.cjs').pricesFrom(cfg)) },
      savedHere: await attempt(() => {
        const r = require('./lib/events.cjs').forRepo(root);
        return { ...r, usd: require('./lib/cost.cjs').savingsUsd({ today: r.today.tokensSaved, total: r.total.tokensSaved }, require('./lib/cost.cjs').pricesFrom(cfg)) };
      }),
      daemon: await attempt(() => require('./lib/daemon-status.cjs').inspect()),
      scout: await attempt(() => require('./lib/daemon-status.cjs').inspectScout()),
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log('');
  console.log(`  token-guard · ${root}`);
  console.log('  ' + '─'.repeat(66));
  console.log(`  modo:            ${CFG.modeLabel(cfg)}`);
  console.log(`  config:          ${cfg._source}`);
  console.log(`  regras ativas:   ${on.join(', ') || '(nenhuma)'}`);
  const perTarget = Object.entries(cfg.targets || {});
  if (perTarget.length) console.log(`  modo por IDE:    ${perTarget.map(([t, m]) => `${t} ${m}`).join(', ')} (os demais seguem o geral)`);
  console.log(`  leitura s/faixa: acima de ${cfg.limits.readBytesWithoutRange} bytes`);
  console.log(`  guarda varredura: a partir de ${cfg.limits.minRepoFilesForScanGuard} arquivos`);
  console.log(stats
    ? `  cache:           ${Number(stats.totalFiles).toLocaleString('pt-BR')} arquivos medidos`
    : '  cache:           ausente — rode `token-guard audit` para calibrar');
  if (cfg.mode === 'off') {
    console.log('');
    console.log('  ATENÇÃO: o guard está DESLIGADO (mode "off" ou TOKEN_GUARD=off).');
  }
  try {
    const prices = require('./lib/cost.cjs').pricesFrom(cfg);
    for (const line of savingsLines(require('./lib/events.cjs').summary(), prices)) console.log(line);
    for (const line of repoLines(require('./lib/events.cjs').forRepo(root), prices)) console.log(line);
  } catch (e) {
    console.log(`  economia:        não foi possível ler os eventos (${e.message})`);
  }
  try {
    const d = await require('./lib/daemon-status.cjs').inspect();
    console.log(`  daemon (ipc):    ${d.ipc.ok ? `no ar (v${d.ipc.version})` : 'fora do ar — sobe sozinho na próxima chamada de hook'}`);
    console.log(`  daemon (http):   porta ${d.http.port || 'não registrada'} · ${d.http.state}${d.http.detail ? ` (${d.http.detail})` : ''}`);
    console.log(`  hook http:       ${d.verdict}`);
  } catch (e) {
    console.log(`  daemon:          não foi possível inspecionar (${e.message})`);
  }
  try {
    console.log(`  scout:           ${require('./lib/daemon-status.cjs').inspectScout().verdict}`);
  } catch (e) {
    console.log(`  scout:           não foi possível inspecionar (${e.message})`);
  }
  await printUpdateNotice('  atualização:     ');
  console.log('');
}

/** Abre a tela de setup (servida pelo daemon). --no-open só imprime a URL de uso único. */
async function setup(args) {
  const UL = require('./lib/ui-launch.cjs');
  const r = await UL.prepare();
  for (const n of r.notes) console.log(`  ${n}`);
  if (!r.ok) {
    console.error(`token-guard setup: ${r.error}`);
    return 1;
  }
  if (args.includes('--no-open')) {
    console.log(`  tela de setup (vale 60 s, uma vez): ${r.url}`);
  } else {
    UL.openBrowser(r.url);
    console.log('  tela de setup aberta no navegador. Se ele não abriu, rode de novo com --no-open e cole a URL.');
  }
  return 0;
}

function help() {
  console.log(`
  token-guard · economia de contexto para agentes de IA

  COMANDOS

    init [caminho]        Instala. Escolha onde com --target:

                            copilot   Copilot CLI / Copilot App   (bloqueia)
                            claude    Claude Code                 (bloqueia)
                            codex     Codex CLI                   (bloqueia, após /hooks)
                            cursor    Cursor (recente)            (bloqueia)
                            mcp       qualquer IDE com MCP        (só orienta)
                            repo      .github/ do repositório      (viaja no git)
                            all       copilot + claude + codex + cursor + mcp

                          --mode off    grava a config global desligada (warn foi aposentado: vale block)
                          --dry-run     simula, não escreve nada
                          --force       sobrescreve config já existente
                          --command-hooks  Claude Code com hook de comando em vez de http
                          --autostart      registra a partida do daemon no logon (por padrão
                                           o token-guard não cria tarefa agendada nenhuma)

    audit [caminho]       Mede o custo de contexto do repositório.
                          --md          relatório em markdown
                          --json        dados crus
                          --top N       quantos itens nos rankings
                          --no-cache    não grava o cache de calibração

    status [caminho] [--json]  Mostra a configuração ativa (--json: o mesmo, para script).

    setup                 Abre a tela de configurações no navegador: escolha o que
                          o token-guard barra, em quais IDEs, e veja o que ele já
                          barrou e poupou. Sobe o daemon se preciso.
                          --no-open     só imprime a URL (vale 60 s, uma vez)
                          No Windows o ícone da bandeja abre a mesma tela.

    mcp                   Sobe o MCP server (stdio). Use no campo "command"
                          da configuração MCP do seu IDE.

    mcp-cost [caminho]    Mede o tamanho do schema dos servidores MCP declarados
                          (preâmbulo onde o harness o carrega por inteiro; o Claude
                          Code adia as ferramentas por padrão).
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

    cost [--since 7d]     Custo por sessão e por modelo a partir dos transcripts do
                          Claude Code (~/.claude/projects): chamadas, tokens, cache,
                          contexto máximo, US$ estimado e fração acima de 200k.
                          --here        só as sessões do repositório atual
                          --top N       sessões mais caras (padrão 10)
                          --dir PASTA   outra pasta de transcripts
                          --json        dados crus
                          Preços: premissa em cost.prices do token-guard.config.json.

    uninstall [--dry-run] Desfaz o que o init gravou: hooks, MCP, runtimes copiados,
                          autostart e daemon. Só sai o que é do token-guard; hooks de
                          terceiros, a configuração e o histórico de eventos ficam.
                          --dry-run     só lista o que removeria, sem remover

    test                  Roda a bateria de testes contra o hook real.

  COMEÇANDO

    npx @allansantos-dev/token-guard audit                       # veja o tamanho do problema
    npx @allansantos-dev/token-guard init --target all             # instale
    npx @allansantos-dev/token-guard test                        # confirme que responde aqui

  Depois reinicie a sessão do agente para carregar o hook.
  Emergência: TOKEN_GUARD=off desliga sem editar arquivo.

  Cobertura real por IDE: https://allansantos-dv.github.io/token-guard/#ides
`);
}

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  help();
  process.exit(0);
}

if (cmd === 'status') {
  status(rest).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else if (cmd === 'uninstall') {
  require('./lib/uninstall.cjs').main(rest).then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
} else if (cmd === 'setup') {
  setup(rest).then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(1); });
} else if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
  const localVersion = require('./package.json').version;
  (async () => {
    try {
      const UC = require('./lib/update-check.cjs');
      const r = await UC.checkForUpdate({ localVersion, cacheFile: updateCacheFile() });
      if (r.checked && r.updateAvailable) {
        console.log(`${localVersion} (nova versão disponível: ${r.latestVersion} — atualize: ${require('./lib/auto-update.cjs').manualCommand(r.latestVersion, 'all')} — novidades: ${UC.SITE_URL})`);
      } else {
        console.log(localVersion);
      }
    } catch {
      console.log(localVersion);
    }
    process.exit(0);
  })();
} else {
  const script = SCRIPTS[cmd];
  if (!script) {
    console.error(`token-guard: comando desconhecido "${cmd}". Use \`token-guard help\`.`);
    process.exit(1);
  }
  run(script, rest);
}
