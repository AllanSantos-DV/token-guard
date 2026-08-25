#!/usr/bin/env node
'use strict';
/**
 * replay-copilot.cjs — replay REAL das sessões do Copilot CLI.
 *
 *   node bench/replay-copilot.cjs [dir] [--json]
 *
 * Corpus: ~/.copilot/session-state/<id>/events.jsonl (formato interno e não
 * contratado — pode mudar entre versões do CLI; o parser é defensivo).
 *
 * Diferença para o replay do Claude Code: aqui os RESULTADOS das ferramentas
 * estão em `tool.execution_complete` → data.result.content — então o custo
 * medido é o BYTES REAIS que entraram na janela, não uma estimativa capped.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { decide } = require(path.join(ROOT, 'lib', 'decide.cjs'));

const argv = process.argv.slice(2);
const dirArg = argv.find((a) => !a.startsWith('--'));
const AS_JSON = argv.includes('--json');
const BASE = path.resolve(dirArg || path.join(os.homedir(), '.copilot', 'session-state'));

function* sessionFiles(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* sessionFiles(full);
    else if (e.isFile() && e.name === 'events.jsonl') yield full;
  }
}

function main() {
  const sessions = new Set();
  let calls = 0, watched = 0, denied = 0, results = 0;
  let realResultBytes = 0;
  const byRule = Object.create(null);
  const suspects = [];

  for (const file of sessionFiles(BASE)) {
    sessions.add(path.basename(path.dirname(file)));
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }

    // toolCallId -> { name, input } da chamada; results chegam no complete.
    const open = new Map();

    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let ev;
      try { ev = JSON.parse(t); } catch { continue; }
      const d = ev.data || {};

      if (ev.type === 'tool.execution_start') {
        const name = d.toolName || d.name || '';
        const input = d.arguments || d.input || {};
        open.set(d.toolCallId, { name, input });
        calls += 1;
        const payload = {
          toolName: name,
          toolArgs: input,
          workingDirectory: d.cwd || process.cwd(),
        };
        const watchedRe = /(view|read|grep|glob|search|list_|bash|shell|powershell|pwsh|terminal|run_command|execute_command|find_files|cat_file|open_file|ripgrep)/i;
        if (watchedRe.test(name)) watched += 1;
        const verdict = (() => { try { return decide(payload); } catch { return null; } })();
        if (!verdict) continue;
        denied += 1;
        byRule[verdict.rule] = (byRule[verdict.rule] || 0) + 1;
        if (suspects.length < 40) {
          suspects.push({
            rule: verdict.rule,
            tool: name,
            input: JSON.stringify(input).slice(0, 160),
            file: path.basename(path.dirname(file)),
          });
        }
      } else if (ev.type === 'tool.execution_complete') {
        const content = d.result && (d.result.content ?? d.result.detailedContent);
        if (typeof content === 'string' && content.length) {
          results += 1;
          realResultBytes += Buffer.byteLength(content, 'utf8');
        }
      }
    }
  }

  if (AS_JSON) {
    console.log(JSON.stringify({
      base: BASE, sessions: sessions.size, calls, watched, denied, byRule,
      toolResults: results, realResultBytes,
      suspectsForManualAudit: suspects,
    }, null, 2));
    return;
  }

  const tok = (n) => Math.round(n).toLocaleString('pt-BR');
  const kb = (n) => (n / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' KB';
  console.log(`
  token-guard · replay REAL das sessões do Copilot CLI (${tok(sessions.size)} sessões em ${BASE})
  chamadas de ferramenta: ${tok(calls)} (${tok(watched)} nas famílias vigiadas) · resultados com bytes reais: ${tok(results)} (${kb(realResultBytes)})

  SERIAM BARRADAS HOJE: ${tok(denied)}
${Object.entries(byRule).map(([r, n]) => `    ${r.padEnd(12)} ${String(n).padStart(5)}`).join('\n') || '    (nenhum)'}

  DADO REAL (não estimativa): ${kb(realResultBytes)} de resultado de ferramenta
  entrou na janela nessas sessões — é sobre isso que o bigResult e os guards
  atuam. Com o guard ativo, cada resultado >25k chars teria virado stub.

  AUDITORIA MANUAL (até 15 denies):
`);
  for (const s of suspects.slice(0, 15)) {
    console.log(`  [${s.rule}] ${s.tool} ${s.input}`);
  }
  console.log(`
  Limitação honesta: events.jsonl é formato interno do CLI (sem contrato de
  estabilidade) e não persiste contagens de token — por isso a métrica é bytes.
`);
}

main();
