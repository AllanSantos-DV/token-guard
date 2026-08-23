#!/usr/bin/env node
'use strict';
/**
 * contract.cjs — CLI de inspeção do contrato de saída.
 *
 *   node contract.cjs [caminho] [--json] [--subagente] [--touched a.js,b.md]
 *
 * Mostra o contrato que vale neste repositório, quanto ele custa de entrada e
 * o que seria injetado numa sessão que tocou os arquivos de `--touched`.
 *
 * Sem dependências. Só Node stdlib.
 */

const path = require('path');
const fs = require('fs');
const CT = require('./lib/contract.cjs');
const CFG = require('./lib/config.cjs');

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--touched');

const ROOT = path.resolve(positional[0] || process.cwd());
if (!fs.existsSync(ROOT)) {
  console.error(`contract: caminho não encontrado: ${ROOT}`);
  process.exit(1);
}

const cfg = CFG.load(ROOT);
const perToken = cfg.charsPerToken || 4;
const tokens = (text) => Math.ceil(text.length / perToken);

const contract = CT.load(ROOT);
const touched = String(opt('--touched', '')).split(',').map((s) => s.trim()).filter(Boolean);

if (!contract.order.length) {
  console.error('contract: nenhum contrato em vigor (TOKEN_GUARD=off ou contract.default.md ausente).');
  process.exit(0);
}

/* --subagente: só o bloco de contexto descartável, pronto para colar no prompt. */
if (flag('--subagente')) {
  console.log(CT.subagentText(contract));
  process.exit(0);
}

const sections = contract.order.map((trigger) => {
  const text = CT.render(contract, [trigger]);
  return {
    trigger,
    rules: (contract.rules[trigger] || []).length,
    tokens: tokens(text),
    injectable: trigger !== CT.SUBAGENT,
  };
});

const decision = CT.decide({ contract, touched });

if (flag('--json')) {
  console.log(JSON.stringify({
    root: ROOT,
    source: contract._source,
    charsPerToken: perToken,
    sections,
    touched,
    would: { triggers: decision.triggers, tokens: tokens(decision.text) },
  }, null, 2));
  process.exit(0);
}

console.log('');
console.log(`  contrato de saída · ${ROOT}`);
console.log('  ' + '─'.repeat(70));
console.log(`  fonte: ${contract._source}`);
console.log('');
for (const s of sections) {
  const marca = s.injectable ? ' ' : '·';
  console.log(`  ${marca} ${s.trigger.padEnd(14)} ${String(s.rules).padStart(2)} regras   ~${s.tokens} tokens`);
}
console.log('');
console.log(`  · a seção "${CT.SUBAGENT}" não entra na sessão principal; vai no prompt do scout.`);
console.log('');

if (touched.length) {
  console.log(`  numa sessão que tocou ${touched.join(', ')}:`);
  console.log(decision.triggers.length
    ? `    entraria ${decision.triggers.join(' + ')} · ~${tokens(decision.text)} tokens, uma vez só`
    : '    nada entraria (as seções já teriam sido injetadas)');
  console.log('');
}
