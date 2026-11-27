#!/usr/bin/env node
'use strict';
/**
 * cost.cjs — `token-guard cost [--here] [--since 7d|AAAA-MM-DD] [--top N] [--dir PASTA] [--json | --repos] [--sessao ID | --ultima]`
 * Custo por sessão e por modelo a partir dos transcripts do Claude Code. `--here`: só as sessões
 * do repositório atual (a pasta com `.git` acima de onde o comando roda, senão a própria pasta).
 * O texto traz também o custo por repositório, ao lado do que o guard poupou nele (evento sem pasta gravada,
 * o histórico antigo, conta zero), e o que o guard poupou na mesma janela.
 * `--repos`: JSON com o total e o custo por repositório (com `saved`, tokens poupados), o formato que a tela
 * de setup recebe do daemon.
 * `--sessao ID`: relatório de uma sessão só (chamadas, cache, contexto máximo, contexto por família); o ID pode ser
 * o prefixo único que a lista mostra. `--ultima`: a sessão com a mensagem mais recente. ID inexistente sai com erro.
 */

const path = require('path');
const COST = require('./lib/cost.cjs');
const CFG = require('./lib/config.cjs');

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Valor de `--sessao`; lança se faltar o id ou se vier junto com `--ultima`. */
function sessionArg(argv) {
  if (!argv.includes('--sessao')) return null;
  if (argv.includes('--ultima')) throw new Error('--sessao e --ultima não combinam: use um só');
  const id = flag(argv, '--sessao');
  if (!id || id.startsWith('--')) throw new Error('--sessao pede o id da sessão (ou o prefixo único que a lista mostra)');
  return id;
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = CFG.load(process.cwd());
  const prices = COST.pricesFrom(cfg);
  const top = Number(flag(argv, '--top')) > 0 ? Number(flag(argv, '--top')) : 10;
  const dir = flag(argv, '--dir');
  const within = argv.includes('--here') ? COST.repoRoot(process.cwd()) : null;
  const since = COST.parseSince(flag(argv, '--since'));
  const session = sessionArg(argv);
  const r = await COST.analyze({ since, prices, within, session, last: argv.includes('--ultima'), ...(dir ? { dir: path.resolve(dir) } : {}) });
  const EVENTS = require('./lib/events.cjs');
  const saved = EVENTS.savedSince(since);
  const savedRepos = EVENTS.byRepo(EVENTS.readAll().filter((e) => e.t >= since)).repos;
  if (argv.includes('--repos')) {
    console.log(JSON.stringify({
      ok: true,
      approximate: true,
      total: { sessions: r.sessions.length, calls: r.total.calls, usd: r.total.usd, usdHeavy: r.total.usdHeavy },
      repos: COST.byRepo(r.sessions, savedRepos),
      unpricedModels: r.unpricedModels,
      prices: { source: prices === COST.DEFAULT_PRICES ? 'tabela padrão' : 'cost.prices' },
      transcripts: r.transcripts,
      badLines: r.badLines,
    }));
  } else if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...r, saved }, null, 2));
  } else {
    console.log(COST.renderText(r, { top, prices, saved: r.session ? undefined : saved, savedRepos }));
  }
}

main().catch((e) => { console.error(`token-guard cost: ${e.message}`); process.exit(1); });
