#!/usr/bin/env node
'use strict';
/**
 * bench/latency.cjs — o número do README, reprodutível na SUA máquina.
 *
 *   node bench/latency.cjs [N]
 *
 * Mede a mediana de quatro caminhos:
 *   1. plugin       — decide() in-process, o que o modo plugin custa por chamada
 *   2. hook         — spawnSync(node token-guard.cjs) com o daemon já de pé
 *   3. piso node    — node -e "0" (o custo de LIGAR o Node, sem guard nenhum)
 *   4. hook a frio  — a primeira chamada da sessão: o hook ainda sobe o daemon
 *
 * (2) já passa pelo daemon: o hook chama `tryDaemon` e, se o endpoint não
 * responde, sobe o daemon ele mesmo (start-on-demand). Não existe modo "hook
 * sem daemon" — logo a comparação honesta não é com/sem daemon, é (2) contra
 * (3): o piso do runtime é quase todo o custo, e o que o daemon tira do caminho
 * é a decisão (sub-milissegundo), não o spawn do cliente. Quem elimina o spawn
 * é o modo plugin (1). Para a latência da decisão servida por IPC, o perfil em
 * rajada e o RSS do residente, use bench/daemon-bench.cjs.
 *
 * Números são desta máquina — meça o seu.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const N = Math.max(5, parseInt(process.argv[2], 10) || 30);

/*
 * SID próprio: o bench nunca fala com o daemon de trabalho do usuário, e o que
 * ele sobe morre no fim de cada medida. Idle curto é a rede de segurança para o
 * caso de o bench ser interrompido no meio.
 */
process.env.TOKEN_GUARD_SID = `bench-${process.pid}`;
process.env.TOKEN_GUARD_DAEMON_IDLE_MS = '60000';
const { tryDaemon } = require(path.join(ROOT, 'lib', 'daemon-client.cjs'));

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

const GUARD = path.join(ROOT, 'token-guard.cjs');
const hook = () => spawnSync(process.execPath, [GUARD], { input: payload });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
hook(); // warm-up do FS e bring-up do daemon
const bySpawn = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  hook();
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

/*
 * 4. hook a frio: cada iteração derruba o daemon antes de medir, então a medida
 * inclui o bring-up que só a primeira ferramenta da sessão paga.
 */
async function coldHook() {
  const runs = Math.min(N, 10);
  const xs = [];
  for (let i = 0; i < runs; i++) {
    const down = await tryDaemon('shutdown', {});
    if (!down.ok) return null;
    await sleep(60); // o endpoint fecha em setImmediate no lado do daemon
    const t0 = Date.now();
    hook();
    xs.push(Date.now() - t0);
  }
  await tryDaemon('shutdown', {});
  return { median: median(xs), runs };
}

function report(cold) {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }

  const f = (v) => v.toFixed(v < 10 ? 3 : 1).replace('.', ',') + ' ms';
  const mp = median(inProc);
  const ms = median(bySpawn);
  const mb = median(bareNode);
  const coldLine = cold
    ? `hook a frio (sobe o daemon)  ${f(cold.median)}   [mediana de ${cold.runs}]`
    : 'hook a frio (sobe o daemon)  — daemon indisponível nesta máquina';

  console.log(`
  token-guard · latência por chamada (mediana de ${N}, ${process.platform}, Node ${process.version})

  plugin (in-process)          ${f(mp)}
  hook (spawn, daemon de pé)   ${f(ms)}
  piso do Node (-e "0")        ${f(mb)}
  ${coldLine}

  custo da lógica do guard no spawn: ${f(ms - mb)}
  razão spawn/plugin:                ${(ms / Math.max(mp, 0.0001)).toFixed(0)}×

  Estes números são DESTA máquina. Antivírus corporativo domina o piso do
  spawn — publique sempre a sua medição junto da sua configuração. O daemon
  corta a decisão, não o spawn do cliente: por isso "hook" fica perto do piso
  do Node, e só o modo plugin sai dessa faixa.
`);
}

coldHook().then(report, () => report(null));
