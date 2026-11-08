#!/usr/bin/env node
'use strict';
/**
 * cost.cjs — `token-guard cost [--here] [--since 7d|AAAA-MM-DD] [--top N] [--dir PASTA] [--json | --repos]`
 * Custo por sessão e por modelo a partir dos transcripts do Claude Code. `--here`: só as sessões
 * do repositório atual (a pasta com `.git` acima de onde o comando roda, senão a própria pasta).
 * O texto traz também o custo por repositório e o que o guard poupou na mesma janela.
 * `--repos`: JSON com o total e o custo por repositório, o formato que a tela de setup recebe do daemon.
 */

const path = require('path');
const COST = require('./lib/cost.cjs');
const CFG = require('./lib/config.cjs');

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = CFG.load(process.cwd());
  const prices = COST.pricesFrom(cfg);
  const top = Number(flag(argv, '--top')) > 0 ? Number(flag(argv, '--top')) : 10;
  const dir = flag(argv, '--dir');
  const within = argv.includes('--here') ? COST.repoRoot(process.cwd()) : null;
  const since = COST.parseSince(flag(argv, '--since'));
  const r = await COST.analyze({ since, prices, within, ...(dir ? { dir: path.resolve(dir) } : {}) });
  const saved = require('./lib/events.cjs').savedSince(since);
  if (argv.includes('--repos')) {
    console.log(JSON.stringify({
      ok: true,
      approximate: true,
      total: { sessions: r.sessions.length, calls: r.total.calls, usd: r.total.usd, usdHeavy: r.total.usdHeavy },
      repos: COST.byRepo(r.sessions),
      unpricedModels: r.unpricedModels,
      prices: { source: prices === COST.DEFAULT_PRICES ? 'tabela padrão' : 'cost.prices' },
      transcripts: r.transcripts,
      badLines: r.badLines,
    }));
  } else if (argv.includes('--json')) {
    console.log(JSON.stringify({ ...r, saved }, null, 2));
  } else {
    console.log(COST.renderText(r, { top, prices, saved }));
  }
}

main().catch((e) => { console.error(`token-guard cost: ${e.message}`); process.exit(1); });
