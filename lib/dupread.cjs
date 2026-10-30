'use strict';
/** dupread.cjs — R1 · dedupe de leitura. Fail-open → null. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const CAP = 32;
const { family } = require('./rules.cjs');

function sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function isRead(n) { return family(n) === 'read'; }

/** Resolve o alvo e devolve {key, abs} ou null. */
function targetOf(root, input) {
  for (const k of ['file_path', 'path', 'filePath', 'absolute_path']) {
    if (input && typeof input[k] === 'string' && input[k]) {
      const abs = path.isAbsolute(input[k]) ? path.normalize(input[k]) : path.resolve(root, input[k]);
      let norm = abs.replace(/\\/g, '/');
      if (FOLD) norm = norm.toLowerCase();
      return { key: sha(norm).slice(0, 16), abs };
    }
  }
  return null;
}

function sfPath(root, sid) {
  const raw = String(sid || '');
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
  const name = safe === raw ? safe : safe + '-' + sha(raw).slice(0, 8);
  return path.join(root || process.cwd(), '.token-guard', 'sessions', name + '-reads.json');
}

function loadMap(f) {
  try {
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch { return {}; }
}

function saveMap(f, m) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(m), 'utf8');
  fs.renameSync(tmp, f);
}

/** Texto que o modelo recebe de um Read: string (hooks de outras IDEs) ou o
 *  objeto do Claude Code ({type:'text', file:{content}}). null = formato desconhecido. */
function textOf(result) {
  if (typeof result === 'string') return result;
  const c = result && typeof result === 'object' && result.file && result.file.content;
  return typeof c === 'string' ? c : null;
}

/** Mesmo resultado com o texto trocado, preservando o resto do formato. */
function withText(result, text) {
  return typeof result === 'string' ? text : { ...result, file: { ...result.file, content: text } };
}

/** Abaixo disso o stub custa quase o que economiza e só traria risco. */
const MIN_DUP_CHARS = 2000;

function flagOn(v) { return !(v === false || v === 'false' || v === 0 || v === 'off'); }

/**
 * Camada A — pós-execução. Grava hash integral; se idêntico ao anterior da
 * mesma origem E resultado > 0 chars → stub de duplicata.
 */
function noteResult(args) {
  try {
    const cfg = args.cfg || {};
    if (!flagOn((cfg.rules || {}).dupRead)) return null;
    if (!isRead(args.name)) return null;
    const text = textOf(args.result);
    if (!text || !text.length) return null;
    const tgt = targetOf(args.root, args.input);
    if (!tgt) return null;
    const f = sfPath(args.root, args.sessionId);
    const map = loadMap(f);
    const prev = map[tgt.key];

    // sempre atualiza mapa
    map[tgt.key] = { hash: sha(text), at: Date.now(), count: (prev ? prev.count : 0) + 1 };
    const ks = Object.keys(map);
    while (ks.length > CAP) delete map[ks.shift()];
    saveMap(f, map);

    // duplicata só se prev existe E hash igual
    if (!prev || prev.hash !== map[tgt.key].hash) return null;

    // A faixa do PDF no Read é `pages`: offset/limit ali não recortam nada.
    const range = /\.pdf$/i.test(tgt.abs) ? 'pages' : 'offset/limit';
    return {
      duplicate: true,
      savedChars: text.length,
      originKey: tgt.key,
      stub: '[dupRead] conteúdo idêntico à leitura anterior (' + text.length + ' chars): o arquivo não mudou desde então, e aquela leitura está acima na conversa. ' +
        `Se não a vê (contexto compactado), releia com ${range}.\n(PT-BR) idêntico à leitura anterior; releia com ${range} se ela saiu do contexto.`,
    };
  } catch (e) { return null; }
}

/**
 * Registra a leitura e, se for duplicata grande, devolve o resultado no mesmo
 * formato do bigResult ({modifiedResult, additionalContext}) para os adapters
 * entregarem via updatedToolOutput. null = nada a substituir.
 */
function dedupe(args) {
  const dup = noteResult(args);
  if (!dup || dup.savedChars < MIN_DUP_CHARS) return null;
  return { modifiedResult: withText(args.result, dup.stub), additionalContext: dup.stub, duplicate: true, savedChars: dup.savedChars };
}

/** Compactação/limpeza/retomada: a leitura anterior não está mais na janela. */
function resetSession(root, sid) {
  try { fs.unlinkSync(sfPath(root, sid)); } catch { /* nada registrado */ }
}

/**
 * Camada B — pré-execução. Arquivo grande já presente no mapa → hint.
 */
function checkRepeat(args) {
  try {
    if (!isRead(args.name)) return null;
    const tgt = targetOf(args.root, args.input);
    if (!tgt) return null;
    const f = sfPath(args.root, args.sessionId);
    const map = loadMap(f);
    if (!map[tgt.key]) return null;
    let sz = 0;
    try { sz = fs.statSync(tgt.abs).size; } catch { sz = 0; }
    return { repeat: true, path: tgt.abs, sizeBytes: sz };
  } catch (e) { return null; }
}

module.exports = { noteResult, dedupe, resetSession, checkRepeat, isRead, MIN_DUP_CHARS };
