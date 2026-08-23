#!/usr/bin/env node
'use strict';
/**
 * replay-transcripts.cjs — a validação definitiva da economia: REPLAY REAL.
 *
 *   node bench/replay-transcripts.cjs [dir-transcripts] [--json]
 *
 * Em vez de simular perfis, este replay percorre transcripts JSONL de sessões
 * REAIS (padrão Claude Code: ~/.claude/projects/**), extrai cada chamada de
 * ferramenta que aconteceu de fato e roda o decide() ATUAL sobre ela.
 *
 * Mede:
 *   · quantas chamadas históricas seriam barradas hoje, por regra;
 *   · custo bruto evitado estimado (mesma matemática capped do savings);
 *   · overhead dos denies;
 *   · FALSOS POSITIVOS CANDIDATOS: denies cujo comando/leitura parece legítimo
 *     à inspeção humana — listados para auditoria manual (sem ground truth,
 *     o número honesto é a lista, não um percentual).
 *
 * Limitação declarada: o transcript não guarda o RESULTADO das tools, então
 * bigResult não participa; e a economia assume que o agente seguiria a
 * alternativa barata (como os perfis do savings).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { decide } = require(path.join(ROOT, 'lib', 'decide.cjs'));

const argv = process.argv.slice(2);
const dirArg = argv.find((a) => !a.startsWith('--'));
const AS_JSON = argv.includes('--json');
const BASE = path.resolve(dirArg || path.join(os.homedir(), '.claude', 'projects'));
const OUTPUT_CAP_TOKENS = 25000;

function* jsonlFiles(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

/** Extrai {name, input} de cada tool_use num objeto de transcript. */
function toolUses(entry) {
  const out = [];
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return out;
  for (const block of content) {
    if (block?.type === 'tool_use' && block.name) {
      out.push({ name: block.name, input: block.input || {} });
    }
  }
  return out;
}

/* custo efetivo estimado por movimento barrado (mesmo modelo do savings) */
function estimateTokens(rule) {
  switch (rule) {
    case 'broadScan':  return OUTPUT_CAP_TOKENS;   // saída truncada pelo harness
    case 'shellDump':  return OUTPUT_CAP_TOKENS;
    case 'blindRead':  return 51200 / 4;            // arquivo grande inteiro
    case 'noisePath':  return OUTPUT_CAP_TOKENS / 2;// ruído variável; estimativa conservadora
    default:           return 0;
  }
}

function main() {
  const files = [...jsonlFiles(BASE)];
  const sessions = new Set();
  const byRule = Object.create(null);
  const suspects = [];
  let calls = 0, watched = 0, denied = 0;

  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let entry;
      try { entry = JSON.parse(t); } catch { continue; }
      if (entry?.cwd && entry?.sessionId) sessions.add(entry.sessionId);
      for (const call of toolUses(entry)) {
        calls += 1;
        const payload = {
          tool_name: call.name,
          tool_input: call.input,
          cwd: entry.cwd || process.cwd(),
          sessionId: entry.sessionId,
        };
        // triagem barata igual ao decide interno: só conta vigiadas
        const verdict = decide(payload);
        const watchedRe = /(view|read|grep|glob|search|list_|bash|shell|powershell|pwsh|terminal|run_command|execute_command|find_files|cat_file|open_file|ripgrep)/i;
        if (watchedRe.test(call.name)) watched += 1;
        if (!verdict) continue;
        denied += 1;
        byRule[verdict.rule] = (byRule[verdict.rule] || 0) + 1;
        if (suspects.length < 40) {
          suspects.push({
            rule: verdict.rule,
            tool: call.name,
            input: JSON.stringify(call.input).slice(0, 160),
            file: path.basename(file),
          });
        }
      }
    }
  }

  const avoided = Object.entries(byRule)
    .reduce((acc, [rule, n]) => acc + estimateTokens(rule) * n, 0);
  const overhead = denied * 225; // ~900 chars por reason (medido)

  if (AS_JSON) {
    console.log(JSON.stringify({
      base: BASE, files: files.length, sessions: sessions.size,
      calls, watched, denied, byRule,
      avoidedTokensEstimate: Math.round(avoided),
      denyOverheadTokens: overhead,
      netEstimate: Math.round(avoided - overhead),
      suspectsForManualAudit: suspects,
    }, null, 2));
    return;
  }

  const tok = (n) => Math.round(n).toLocaleString('pt-BR');
  console.log(`
  token-guard · replay de transcripts reais (${tok(files.length)} arquivos em ${BASE})
  sessões: ${tok(sessions.size)} · chamadas de ferramenta: ${tok(calls)} (${tok(watched)} nas famílias vigiadas)

  SERIAM BARRADAS HOJE: ${tok(denied)}
${Object.entries(byRule).map(([r, n]) => `    ${r.padEnd(12)} ${String(n).padStart(5)}`).join('\n')}

  economia bruta estimada:  ${tok(avoided)} tok (teto de truncamento 25k/movimento)
  overhead dos denies:    −${tok(overhead)} tok
  LÍQUIDO ESTIMADO:        ${tok(avoided - overhead)} tok nessas sessões

  AUDITORIA MANUAL DE FALSOS POSITIVOS (até 40 denies, para inspeção):
`);
  for (const s of suspects.slice(0, 15)) {
    console.log(`  [${s.rule}] ${s.tool} ${s.input}`);
  }
  console.log(`
  Limitações honestas: transcripts não guardam o resultado das tools (bigResult
  fora da conta); custo é ESTIMADO pela matemática do savings; falsos positivos
  exigem a sua leitura da lista acima.
`);
}

main();
