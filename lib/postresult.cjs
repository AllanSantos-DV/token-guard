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

// Mesma tabela de famílias das regras de entrada: uma fonte só, sem deriva.
const { family: familyOf } = require('./rules.cjs');

/** Dica específica da família — a alternativa barata, pronta para reexecutar. */
function adviceFor(fam, chars, input) {
  const kb = Math.round(chars / 1024);
  if (fam === 'read' && /\.pdf$/i.test(String(require('./payload.cjs').inputPath(input) || ''))) {
    return `PDF pages, not lines: re-read with pages for the part you need (e.g. pages: "1-5").`;
  }
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

/** Linha-sinal de shell: início de linha que denuncia erro/falha/exceção. */
const SIGNAL_LINE = /^\s*(?:not ok\b|(?:FAIL|FAILED|FAILURE|ERROR|FATAL)\b|Traceback\b|Caused by:|panic:|fatal:|error(?:\[\w+\])?:|\d+\s+failing\b|[\w.$]*(?:Error|Exception)\b[:\s])/;
const SIGNAL_LINE_MAX = 300;

/**
 * Corte de SAÍDA DE SHELL: início + fim + linhas-sinal do trecho cortado.
 * Log longo esconde a falha no meio; começo+fim sozinhos a perdiam (medido em
 * 121 saídas reais: 9% das linhas-sinal mantidas, contra 26% com esta regra e
 * -37% de contexto). Orçamento derivado de keepChars: início 37,5% · fim 25% ·
 * sinais até 37,5% (sem sinal, gasta só início+fim).
 */
function shellTruncate(str, keepChars) {
  if (str.length <= keepChars) return str;
  const head = Math.floor(keepChars * 0.375);
  const tail = Math.floor(keepChars * 0.25);
  const sigBudget = keepChars - head - tail;
  const mid = str.slice(head, Math.max(head, str.length - tail));

  const kept = []; // { text, at } — at = deslocamento da linha dentro de mid
  let used = 0;
  let dropped = 0;
  let at = 0;
  for (const raw of mid.split('\n')) {
    const lineAt = at;
    at += raw.length + 1;
    if (!SIGNAL_LINE.test(raw)) continue;
    const text = raw.length > SIGNAL_LINE_MAX ? raw.slice(0, SIGNAL_LINE_MAX) + '…' : raw;
    if (used + text.length + 1 > sigBudget) { dropped += 1; continue; }
    used += text.length + 1;
    kept.push({ text, at: lineAt, end: lineAt + raw.length });
  }

  const omit = (n) => `\n... [token-guard: ${n} caracteres omitidos — versão completa gravada] ...\n`;
  let out = str.slice(0, head);
  let cursor = 0; // primeiro caractere de mid ainda não coberto
  for (const k of kept) {
    if (k.at > cursor) out += omit(k.at - cursor);
    else out += '\n';
    out += k.text;
    cursor = k.end + 1; // pula o \n que fecha a linha-sinal
  }
  const rest = mid.length - cursor;
  if (rest > 0) out += omit(rest);
  else out += '\n';
  if (dropped) out += `[token-guard: +${dropped} linhas de erro/falha não couberam no orçamento]\n`;
  return out + str.slice(str.length - tail);
}

/** Objeto de shell {stdout,stderr,...} com os fluxos cortados; null se nenhum
 *  fluxo excede keepChars (nada a substituir). */
function shellStreams(result, keepChars) {
  if (!result || typeof result !== 'object' || typeof result.stdout !== 'string') return null;
  const out = { ...result };
  let cut = false;
  for (const k of ['stdout', 'stderr']) {
    if (typeof out[k] === 'string' && out[k].length > keepChars) {
      out[k] = shellTruncate(out[k], keepChars);
      cut = true;
    }
  }
  return cut ? out : null;
}

/** Escolhe o corte pela família: shell preserva sinais; o resto, início+fim. */
function truncateFor(fam, str, keepChars) {
  return fam === 'shell' ? shellTruncate(str, keepChars) : middleTruncate(str, keepChars);
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
    // Ferramenta de escrita: o resultado carrega o arquivo (originalFile,
    // content), mas o modelo só vê a confirmação — nada disso entra na janela.
    if (WRITE_TOOL.test(String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_'))) return null;

    // Mede só o TEXTO que entra na janela. Copilot entrega ToolResultObject
    // (o texto é textResultForLlm); imagem chega ao modelo como imagem, então
    // base64/binário não conta — medir esses bytes era falso positivo.
    const copilot = isToolResultObject(result);
    const serialized = typeof result === 'string' ? result
      : copilot ? result.textResultForLlm
      : safeStringify(result, dropOutsideWindow);
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
    pruneSaved(dir);

    const fam = familyOf(name);

    // replaced: o harness aplica a substituição (string no Claude Code,
    // ToolResultObject no Copilot, {stdout,...} do shell). Objeto genérico
    // chega intacto ao modelo — a mensagem não pode dizer que truncou.
    const shellOut = fam === 'shell' ? shellStreams(result, keep) : null;
    let modifiedResult;
    let replaced = true;
    if (typeof result === 'string') {
      modifiedResult = truncateFor(fam, result, keep);
    } else if (copilot) {
      modifiedResult = { ...result, textResultForLlm: truncateFor(fam, serialized, keep) };
    } else if (shellOut) {
      // Bash do Claude Code: {stdout,stderr,...}. updatedToolOutput aceita o
      // mesmo formato, então o corte vale de fato (não só o aviso).
      modifiedResult = shellOut;
    } else {
      replaced = false;
      modifiedResult = {
        token_guard_truncated: true,
        original_chars: serialized.length,
        preview: middleTruncate(serialized, keep),
        full_output_file: file,
      };
    }

    const kb = Math.round(serialized.length / 1024);
    const advice = adviceFor(fam, serialized.length, input);
    const additionalContext = replaced
      ? `[token-guard/bigResult] Tool output was ${kb} KB and would flood ` +
        `the context window. Truncated; full version saved to ${file}. ${advice}\n` +
        `(PT-BR) Saída de ${kb} KB truncada; versão completa em ${file}. ${advice}`
      : `[token-guard/bigResult] Tool output was ${kb} KB and all of it entered the context window. ` +
        `A copy is saved to ${file}. Next time: ${advice}\n` +
        `(PT-BR) Saída de ${kb} KB entrou inteira na janela; cópia em ${file}. Da próxima vez: ${advice}`;

    return { modifiedResult, additionalContext, savedTo: file };
  } catch {
    return null; // fail-open absoluto
  }
}

function safeStringify(v, replacer) {
  try {
    return JSON.stringify(v, replacer);
  } catch {
    return null; // circular etc.: não conseguimos medir, deixamos passar
  }
}

const WRITE_TOOL = /^(edit|multiedit|write|notebookedit|edit_file|write_file|create_file|replace_string_in_file|insert_edit_into_file|apply_patch)$/;

/** Formato de resultado do SDK do Copilot (substituível por outro igual). */
function isToolResultObject(v) {
  return Boolean(v) && typeof v === 'object' && typeof v.textResultForLlm === 'string';
}

/** Replacer: o que o resultado carrega mas o modelo não recebe — binário em
 *  base64 (imagem/PDF) e o bashEditDiff do Bash do Claude Code (só interface).
 *  Blocos MCP ({type:'image'|'audio',data}, {source:{type:'base64',data}} e o
 *  `blob` de recurso binário embutido): `this` é o objeto-pai, então só o
 *  binário desses blocos sai da medida. */
function dropOutsideWindow(key, value) {
  if ((key === 'base64' || key === 'blob') && typeof value === 'string') return undefined;
  if (key === 'data' && typeof value === 'string' && this &&
      (this.type === 'image' || this.type === 'audio' || this.type === 'base64')) return undefined;
  if (key === 'bashEditDiff') return undefined;
  return value;
}

/** Teto de arquivos em .token-guard/results: os mais antigos saem. */
const MAX_SAVED_RESULTS = 50;

function pruneSaved(dir) {
  try {
    // Nome começa com Date.now() (13 dígitos): ordem lexicográfica = cronológica.
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_SAVED_RESULTS))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* em uso: fica para a próxima */ }
    }
  } catch { /* poda é cortesia */ }
}

module.exports = { postProcess, familyOf, middleTruncate, shellTruncate, shellStreams, adviceFor, MAX_SAVED_RESULTS };
