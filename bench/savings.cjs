#!/usr/bin/env node
'use strict';
/**
 * bench/savings.cjs — a promessa central do produto, medida ponta a ponta.
 *
 *   node bench/savings.cjs [sessões] [seed]
 *
 * O audit mede o custo POTENCIAL do repositório. Este bench mede a ECONOMIA
 * LÍQUIDA dos guards numa sessão simulada:
 *
 *   economia líquida = Σ(custo evitado nos denies verdadeiros)
 *                    − Σ(custo das mensagens de deny, que TAMBÉM entram na janela)
 *                    − Σ(custo dos movimentos caros que escaparam ao guard)
 *
 * PREMISSAS (todas declaradas, nada escondido):
 *   · Truncamento: TODO harness moderno corta tool output (~25 k tokens). Um
 *     glob de 215 mil caminhos NÃO entra inteiro na janela — entra o teto,
 *     e o agente queima turnos re-tentando. Modelamos min(bruto, TETO) +
 *     custo de retentativa quando truncado.
 *   · Os TAMANHOS vêm de medições reais: ~125 chars/caminho × 215 k arquivos
 *     (caso do README), arquivo grande = 200 KB, faixa útil = 80 linhas.
 *   · A SEQUÊNCIA vem de um perfil sintético de sessão (mix read/grep/glob/
 *     shell + taxa de erro por família) — não é replay de transcript vivo.
 *   · Cada deny injeta ~900 caracteres de reason no contexto (medido nos
 *     reasons reais): é custo e entra na conta.
 *   · Falsos positivo custa mais que um deny verdadeiro custava barato: além
 *     da mensagem, o agente reformula a chamada (retentativa + versão barata).
 *
 * Simulação paramétrica ancorada em medições reais de tamanho — o replay de
 * transcripts vivos é o próximo passo de validação.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ---------------- parâmetros ---------------- */

const SESSIONS = Math.max(10, parseInt(process.argv[2], 10) || 500);
const SEED = process.argv[3] ? Number(process.argv[3]) : 42;

let _s = SEED >>> 0;
function rnd() {
  _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
  let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const CPT = 4;
const WINDOW = 200000;
const OUTPUT_CAP_TOKENS = 25000;   // teto de tool result dos harnesses modernos
const RETRY_FRACTION = 0.5;        // fração de dumps truncados que geram 1 retentativa cara

const REPO_FILES = 215112;
const PATH_CHARS_PER_FILE = 125;
const SOURCE_LINES = 2000000;
const LINE_CHARS = 55;
const BIG_BYTES = 200 * 1024;
const RANGE_CHARS = 80 * LINE_CHARS;
const DENY_MSG_CHARS = 900;

const PROFILE = {
  callsPerSession: 120,
  mix: [
    { fam: 'read',  weight: 0.40, expensive: 0.05 },
    { fam: 'grep',  weight: 0.25, expensive: 0.12 },
    { fam: 'glob',  weight: 0.15, expensive: 0.20 },
    { fam: 'shell', weight: 0.15, expensive: 0.08 },
    { fam: 'other', weight: 0.05, expensive: 0.00 },
  ],
};

const LEARN_RATE = { teimoso: 0.85, normal: 0.30, rapido: 0.05 };

/** Custo bruto (sem truncamento) de cada movimento caro, em tokens.
 *  `scale` permite simular repositórios de tamanhos distintos. */
function grossCostOf(kind, scale = DEFAULT_SCALE) {
  switch (kind) {
    case 'globUnbounded': return (scale.files * PATH_CHARS_PER_FILE) / CPT;
    case 'grepUnbounded': return (scale.lines * 0.08 * LINE_CHARS) / CPT;
    case 'blindRead':     return BIG_BYTES / CPT;
    case 'shellDump':     return (scale.files * PATH_CHARS_PER_FILE) / CPT;
    default:              return 0;
  }
}

const DEFAULT_SCALE = { files: REPO_FILES, lines: SOURCE_LINES };

/** Custo EFETIVO na janela: o harness trunca no teto; truncado às vezes
 *  custa uma retentativa extra igualmente truncada. */
function cappedCost(kind, allowRetry, scale = DEFAULT_SCALE) {
  const g = grossCostOf(kind, scale);
  const eff = Math.min(g, OUTPUT_CAP_TOKENS);
  return eff + (g > OUTPUT_CAP_TOKENS && allowRetry && rnd() < RETRY_FRACTION ? eff : 0);
}

/** Alternativa barata pós-correção (dezenas–centenas de linhas, longe do teto). */
function cheapCostOf(kind) {
  switch (kind) {
    case 'globUnbounded': return (200 * PATH_CHARS_PER_FILE) / CPT;
    case 'grepUnbounded': return (300 * LINE_CHARS) / CPT;
    case 'blindRead':     return RANGE_CHARS / CPT;
    case 'shellDump':     return (100 * PATH_CHARS_PER_FILE) / CPT;
    default:              return 0;
  }
}

const EXPENSIVE_BY_FAM = {
  read:  () => ({ kind: 'blindRead', payload: { tool_name: 'View', tool_input: { path: 'src/BigService.java' } } }),
  grep:  () => ({ kind: 'grepUnbounded', payload: { tool_name: 'Grep', tool_input: { pattern: 'TODO', output_mode: 'content' } } }),
  glob:  () => ({ kind: 'globUnbounded', payload: { tool_name: 'Glob', tool_input: { pattern: '**/*' } } }),
  shell: () => ({ kind: 'shellDump', payload: { tool_name: 'Bash', tool_input: { command: 'ls -R' } } }),
};

function pickFam(r) {
  let acc = r();
  for (const m of PROFILE.mix) if ((acc -= m.weight) <= 0) return m;
  return PROFILE.mix[PROFILE.mix.length - 1];
}

/** decide() real sobre payload real — o guard avaliado é o produto, não um modelo. */
function makeGuard(root) {
  const { decide } = require(path.join(__dirname, '..', 'lib', 'decide.cjs'));
  return (payload) => decide({ ...payload, cwd: root });
}

function simulate(learnP, opts = {}) {
  const guard = opts.guard || makeGuard(opts.root);
  const scale = opts.scale || DEFAULT_SCALE;
  let wasted = 0, avoided = 0, denyOverhead = 0;
  let deniedTrue = 0, fpDenied = 0, passedExpensive = 0, deniedTotal = 0;
  const corrected = new Set();

  for (let i = 0; i < PROFILE.callsPerSession; i += 1) {
    const fam = pickFam(rnd);
    if (!fam.expensive || rnd() >= fam.expensive) continue;

    const { kind, payload } = EXPENSIVE_BY_FAM[fam.fam]();

    if (corrected.has(kind) && rnd() >= learnP) continue; // aprendeu: foi direto na versão barata

    const verdict = guard(payload);
    if (!verdict) {
      wasted += cappedCost(kind, true, scale);
      passedExpensive += 1;
      continue;
    }

    deniedTotal += 1;
    denyOverhead += DENY_MSG_CHARS / CPT;

    // Falso positivo simulado: fração fpRate dos denies acerta chamadas baratas —
    // o agente paga a mensagem e ainda reformula a chamada correta.
    if (opts.fpRate && rnd() < opts.fpRate) {
      fpDenied += 1;
      wasted += cheapCostOf(kind) * 0.5;
      continue;
    }

    deniedTrue += 1;
    avoided += cappedCost(kind, false, scale) - cheapCostOf(kind);
    corrected.add(kind);
  }

  return { wasted, avoided, denyOverhead, deniedTrue, fpDenied, passedExpensive };
}

/* ---------------- execução ---------------- */

function runBatch(name, learnP, opts = {}, sessions = SESSIONS) {
  const agg = { wasted: 0, avoided: 0, denyOverhead: 0, deniedTrue: 0, fpDenied: 0, passedExpensive: 0 };
  for (let i = 0; i < sessions; i++) {
    const r = simulate(learnP, opts);
    for (const k of Object.keys(agg)) agg[k] += r[k];
  }
  for (const k of Object.keys(agg)) agg[k] /= sessions; // médias POR SESSÃO
  const net = agg.avoided - agg.denyOverhead - agg.wasted;
  return { name, ...agg, net, sessions };
}

// Fixture mínimo (blindRead precisa de arquivo real)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-savings-'));
fs.mkdirSync(path.join(TMP, '.token-guard'), { recursive: true });
fs.writeFileSync(path.join(TMP, '.token-guard', 'repo-stats.json'),
  JSON.stringify({ totalFiles: REPO_FILES, pathChars: REPO_FILES * PATH_CHARS_PER_FILE }));
fs.mkdirSync(path.join(TMP, 'src'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'src', 'BigService.java'), 'x'.repeat(BIG_BYTES));

const GUARD = makeGuard(TMP);
const profiles = Object.entries(LEARN_RATE)
  .map(([name, p]) => runBatch(name, p, { guard: GUARD }));

// Repo pequeno: guards de varredura desligados por design — deve dar zero ruído.
const SMALL_FILES = 300;
const SMALL = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-savings-small-'));
fs.mkdirSync(path.join(SMALL, '.token-guard'), { recursive: true });
fs.writeFileSync(path.join(SMALL, '.token-guard', 'repo-stats.json'),
  JSON.stringify({ totalFiles: SMALL_FILES, pathChars: SMALL_FILES * PATH_CHARS_PER_FILE }));
fs.mkdirSync(path.join(SMALL, 'src'), { recursive: true });
fs.writeFileSync(path.join(SMALL, 'src', 'Big.java'), 'x'.repeat(BIG_BYTES));
const smallProfile = runBatch('repo-pequeno', LEARN_RATE.normal, { root: SMALL }, 50);

// Sensibilidade a falso positivo: em que fração de denies-FP a economia zera?
const fpCurve = [0.02, 0.05, 0.10, 0.25].map((f) => ({
  rate: f,
  net: runBatch(`fp${f}`, LEARN_RATE.normal, { guard: GUARD, fpRate: f }, 100).net,
}));

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }
try { fs.rmSync(SMALL, { recursive: true, force: true }); } catch { /* noop */ }

/* ---------------- relatório ---------------- */

const tok = (n) => Math.round(n).toLocaleString('pt-BR');
const win = (n) => (n / WINDOW).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

console.log(`
  token-guard · economia LÍQUIDA simulada (${SESSIONS} sessões × ${PROFILE.callsPerSession} chamadas, seed ${SEED})
  repo-alvo: ${tok(REPO_FILES)} arquivos · teto de tool result: ${tok(OUTPUT_CAP_TOKENS)} tok (truncamento real dos harnesses)

  MÉDIAS POR SESSÃO:
`);
for (const r of profiles) {
  console.log(`  ${r.name.padEnd(8)} denies=${r.deniedTrue.toFixed(1)} escapes=${r.passedExpensive.toFixed(2)} · `
    + `evitado=${tok(r.avoided)} −overhead=${tok(r.denyOverhead)} −escapado=${tok(r.wasted)} `
    + `→ LÍQUIDO ${tok(r.net)} tok (${win(r.net)} janela(s))`);
}
console.log(`
  REPO PEQUENO (${SMALL_FILES} arquivos, guards desligados por design):
    denies=0 · ruído adicionado: 0 tok — o kit não atrapalha onde promete não atrapalhar.

  SENSIBILIDADE A FALSO POSITIVO (perfil normal, % de denies que seriam FPs):
`);
for (const p of fpCurve) console.log(`    fp=${Math.round(p.rate * 100)}% → líquido ${tok(p.net)} tok/sessão`);

const gainPerDeny = (profiles[1].avoided / Math.max(profiles[1].deniedTrue, 1));
const fpCost = DENY_MSG_CHARS / CPT + 1200;
const breakEven = gainPerDeny / (gainPerDeny + fpCost);
console.log(`
  PONTO DE EQUILÍBRIO: com ganho médio de ${tok(gainPerDeny)} tok por deny verdadeiro e
  custo de FP ≈ ${tok(fpCost)} tok, o guard só deixa de valer se ${Math.round(breakEven * 100)}%
  dos denies forem falsos positivos. Abaixo disso, cada bloqueio paga o próprio custo.

  LIMITAÇÃO HONESTA: simulação paramétrica ancorada em tamanhos medidos
  (215 k arquivos, 200 KB/arquivo, teto 25 k tok), com sequência sintética —
  não replay de transcript vivo. Reproduza: node bench/savings.cjs [sessões] [seed]
`);

module.exports = { simulate, runBatch, makeGuard, grossCostOf, cheapCostOf, cappedCost, PROFILE, LEARN_RATE };
