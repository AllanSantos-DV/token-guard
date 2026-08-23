'use strict';
/**
 * postresult.cjs — economia na SAÍDA das ferramentas (pós-execução).
 *
 * As quatro regras barram a chamada cara ANTES dela rodar. Esta camada cuida
 * do que escapa: uma busca legítima que devolve 200 KB, um build log enorme,
 * uma leitura que o harness permitiu. O mercado chama o output de ferramenta
 * de "o maior custo escondido" — e todo harness moderno trunca por conta
 * própria, sem ensinar nada.
 *
 * Filosofia inalterada:
 *   · nunca suprimir sem destino — trunca preservando cabeça+cauda, salva o
 *     texto integral em disco e devolve a alternativa barata pronta;
 *   · fail-open absoluto — qualquer erro interno devolve null (resultado
 *     passa intacto; um pós-processador jamais pode corromper a sessão).
 *
 * Sem dependências. Só Node stdlib.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FAM = {
  grep:  /(^|_)(grep|ripgrep|search_text|text_search|grep_search|search_in_files)($|_)/,
  glob:  /(^|_)(glob|file_search|find_files|list_dir|list_files|list_directory|listdirectory)($|_)/,
  read:  /^(view|read|read_file|readfile|cat_file|open_file|get_file_contents|str_replace_editor)$/,
  shell: /(^|_)(bash|sh|shell|zsh|powershell|pwsh|run_in_terminal|run_command|execute_command|terminal|run_shell)$/,
};

function familyOf(name) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  for (const [fam, re] of Object.entries(FAM)) if (re.test(n)) return fam;
  return null;
}

/** Dica específica da família — a alternativa barata, pronta para reexecutar. */
function adviceFor(fam, chars) {
  const kb = Math.round(chars / 1024);
  switch (fam) {
    case 'grep':
      return `Re-run the search with output_mode="files_with_matches" first, or add head_limit and a file filter — the full ${kb} KB of matches is rarely needed.`;
    case 'glob':
      return `Bound it next time: by extension ("**/*.java"), directory (paths=["src"]) or name ("**/*Service*").`;
    case 'read':
      return `Locate the region first (scoped search), then re-read with a line range around the hit.`;
    case 'shell':
      return `Filter and cap shell output: pipe through "| Select-Object -First 50" / "| head -50", or redirect to a file and read ranges of it.`;
    default:
      return `If only part of this matters, re-run bounded (filter, limit, range) instead of consuming the whole output again.`;
  }
}

/** Corte no meio preservando início e fim (mesma heurística dos harnesses). */
function middleTruncate(str, keepChars) {
  if (str.length <= keepChars) return str;
  const head = Math.floor(keepChars * 0.72);
  const tail = Math.max(0, keepChars - head);
  const hidden = str.length - head - tail;
  return str.slice(0, head) +
    `\n... [token-guard: ${hidden} caracteres truncados — versão completa gravada] ...\n` +
    (tail ? str.slice(-tail) : '');
}

/**
 * Pós-processa o resultado de uma ferramenta.
 * @param {{name:string, input?:object, result:unknown, root:string, cfg:object}} args
 * @returns {null | {modifiedResult:unknown, additionalContext:string, savedTo:string}}
 *          null = nada a fazer (ou falha silenciosa: fail-open).
 */
function postProcess({ name, input, result, root, cfg }) {
  try {
    // Flag tolerante a string ("false"/"off" chegam de JSON mal tipado).
    const flag = cfg.rules ? cfg.rules.bigResult : undefined;
    if (flag === false || flag === 'false' || flag === 0 || flag === 'off') return null;
    if (result == null) return null;

    const serialized = typeof result === 'string' ? result : safeStringify(result);
    if (serialized == null) return null;

    // Limites com validação local: config lixo ("abc", negativo) cai no
    // default em vez de virar NaN-comparison que trunca TUDO.
    const rawLimit = Number(cfg.limits && cfg.limits.resultCharsWithoutTrim);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 25000;
    const rawKeep = Number(cfg.limits && cfg.limits.resultTrimKeepChars);
    const keep = Number.isFinite(rawKeep) && rawKeep > 0
      ? Math.min(rawKeep, limit - 1) : 8000;

    if (serialized.length <= limit) return null;

    // Texto integral em disco: o destino existe antes de cortar.
    const dir = path.join(root || process.cwd(), '.token-guard', 'results');
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('sha1').update(serialized).digest('hex').slice(0, 10);
    const file = path.join(dir, `${Date.now()}-${familyOf(name) || 'tool'}-${hash}.txt`);
    fs.writeFileSync(file, serialized, 'utf8');

    const fam = familyOf(name);

    let modifiedResult;
    if (typeof result === 'string') {
      modifiedResult = middleTruncate(result, keep);
    } else {
      modifiedResult = {
        token_guard_truncated: true,
        original_chars: serialized.length,
        preview: middleTruncate(serialized, keep),
        full_output_file: file,
      };
    }

    const additionalContext =
      `[token-guard/bigResult] Tool output was ${Math.round(serialized.length / 1024)} KB and would flood ` +
      `the context window. Truncated; full version saved to ${file}. ${adviceFor(fam, serialized.length)}\n` +
      `(PT-BR) Saída de ${Math.round(serialized.length / 1024)} KB truncada; versão completa em ${file}. ` +
      `${adviceFor(fam, serialized.length)}`;

    return { modifiedResult, additionalContext, savedTo: file };
  } catch {
    return null; // fail-open absoluto
  }
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null; // circular etc.: não conseguimos medir, deixamos passar
  }
}

module.exports = { postProcess, familyOf, middleTruncate, adviceFor };
