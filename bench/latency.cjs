#!/usr/bin/env node
'use strict';
/**
 * bench/latency.cjs — o número do README, reprodutível na SUA máquina.
 *
 *   node bench/latency.cjs [N]
 *
 * Mede a mediana de três caminhos:
 *   1. plugin      — decide() in-process, o que o modo plugin custa por chamada
 *   2. hook        — spawnSync(node token-guard.cjs), o modo comando
 *   3. piso node   — node -e "0" (o custo de LIGAR o Node, sem guard nenhum)
 *
 * A diferença entre (2) e (3) é o custo real da lógica do guard; o resto é
 * runtime/antivírus. Números são desta máquina — meça o seu.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const N = Math.max(5, parseInt(process.argv[2], 10) || 30);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bench-'));
fs.writeFileSync(path.join(TMP, 'Big.java'), 'x'.repeat(120000));
fs.mkdirSync(path.join(TMP, '.token-guard'), { recursive: true });
fs.writeFileSync(path.join(TMP, '.token-guard', 'repo-stats.json'),
  JSON.stringify({ totalFiles: 215112, pathChars: 26726490 }));

const payload = JSON.stringify({
  tool_name: 'View',
  tool_input: { path: path.join(TMP, 'Big.java') },
  cwd: TMP,
});

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/* 1. plugin: decide() in-process sobre o payload já parseado */
const { decide } = require(path.join(ROOT, 'lib', 'decide.cjs'));
const P = require(path.join(ROOT, 'lib', 'payload.cjs'));
const parsed = { toolName: 'View', toolInput: { path: path.join(TMP, 'Big.java') }, cwd: TMP };
decide(parsed); // warm-up: requires preguiçosos e cache de config fora da medida
const inProc = [];
for (let i = 0; i < N; i++) {
  const t0 = process.hrtime.bigint();
  decide(parsed);
  inProc.push(Number(process.hrtime.bigint() - t0) / 1e6);
}

/* 2. hook: processo completo, exatamente como o harness faz */
const GUARD = path.join(ROOT, 'token-guard.cjs');
spawnSync(process.execPath, [GUARD], { input: payload }); // warm-up do FS
const bySpawn = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  spawnSync(process.execPath, [GUARD], { input: payload });
  bySpawn.push(Date.now() - t0);
}

/* 3. piso do runtime */
spawnSync(process.execPath, ['-e', '0']);
const bareNode = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  spawnSync(process.execPath, ['-e', '0']);
  bareNode.push(Date.now() - t0);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }

const f = (v) => v.toFixed(v < 10 ? 3 : 1).replace('.', ',') + ' ms';
const mp = median(inProc);
const ms = median(bySpawn);
const mb = median(bareNode);

console.log(`
  token-guard · latência por chamada (mediana de ${N}, ${process.platform}, Node ${process.version})

  plugin (in-process)   ${f(mp)}
  hook (spawn)          ${f(ms)}
  piso do Node (-e "0") ${f(mb)}

  custo da lógica do guard no spawn: ${f(ms - mb)}
  razão spawn/plugin:                ${(ms / Math.max(mp, 0.0001)).toFixed(0)}×

  Estes números são DESTA máquina. Antivírus corporativo domina o piso do
  spawn — publique sempre a sua medição junto da sua configuração.
`);
