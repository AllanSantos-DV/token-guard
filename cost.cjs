#!/usr/bin/env node
'use strict';
/**
 * cost.cjs — `token-guard cost [--here] [--since 7d|AAAA-MM-DD] [--top N] [--dir PASTA] [--json]`
 * Custo por sessão e por modelo a partir dos transcripts do Claude Code. `--here`: só as sessões
 * do repositório atual (a pasta com `.git` acima de onde o comando roda, senão a própria pasta).
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
  const r = await COST.analyze({ since: COST.parseSince(flag(argv, '--since')), prices, within, ...(dir ? { dir: path.resolve(dir) } : {}) });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(COST.renderText(r, { top, prices }));
  }
}

main().catch((e) => { console.error(`token-guard cost: ${e.message}`); process.exit(1); });
