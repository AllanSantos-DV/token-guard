#!/usr/bin/env node
'use strict';
/**
 * cost.cjs — `token-guard cost [--since 7d|AAAA-MM-DD] [--top N] [--dir PASTA] [--json]`
 * Custo por sessão e por modelo a partir dos transcripts do Claude Code.
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
  const prices = (cfg.cost && cfg.cost.prices && typeof cfg.cost.prices === 'object') ? cfg.cost.prices : COST.DEFAULT_PRICES;
  const top = Number(flag(argv, '--top')) > 0 ? Number(flag(argv, '--top')) : 10;
  const dir = flag(argv, '--dir');
  const r = await COST.analyze({ since: COST.parseSince(flag(argv, '--since')), prices, ...(dir ? { dir: path.resolve(dir) } : {}) });
  if (argv.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(COST.renderText(r, { top, prices }));
  }
}

main().catch((e) => { console.error(`token-guard cost: ${e.message}`); process.exit(1); });
