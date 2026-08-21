#!/usr/bin/env node
'use strict';
/**
 * token-audit.cjs — CLI da auditoria de contexto.
 *
 *   node token-audit.cjs [caminho] [--json] [--md] [--no-cache] [--top N]
 *
 * A lógica vive em lib/audit.cjs, para que a extensão possa chamá-la in-process.
 * Este arquivo é só o parser de argumentos e a saída.
 */

const fs = require('fs');
const path = require('path');
const CFG = require('./lib/config.cjs');
const AUDIT = require('./lib/audit.cjs');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--top');
const ROOT = path.resolve(positional[0] || process.cwd());
const TOP = Math.max(1, parseInt(opt('--top', '10'), 10) || 10);

if (!fs.existsSync(ROOT)) {
  console.error(`token-audit: caminho não encontrado: ${ROOT}`);
  process.exit(1);
}

const cfg = CFG.load(ROOT);
const result = AUDIT.scan(ROOT, cfg, { top: TOP });

let cachePath = null;
if (!flag('--no-cache') && AUDIT.writeCache(ROOT, result)) {
  cachePath = path.join(ROOT, '.token-guard', 'repo-stats.json');
}

if (flag('--json')) {
  console.log(JSON.stringify({ ...result.stats, ...result.derived, topExt: result.topExt, topDir: result.topDir }, null, 2));
} else if (flag('--md')) {
  console.log(AUDIT.renderMarkdown(result, cfg));
} else {
  console.log(AUDIT.renderText(result, cfg, { configSource: cfg._source, cachePath }));
}
