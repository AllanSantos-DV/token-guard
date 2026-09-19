'use strict';
/** dupread.cjs — R1 · dedupe de leitura. Fail-open → null. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FOLD = process.platform === 'win32' || process.platform === 'darwin';
const CAP = 32;
const READ_RE = /^(view|read|read_file|readfile|cat_file|open_file|get_file_contents|str_replace_editor)$/;

function sha(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function isRead(n) {
  return READ_RE.test(String(n || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, ''));
}

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
    if (typeof args.result !== 'string' || !args.result.length) return null;
    const tgt = targetOf(args.root, args.input);
    if (!tgt) return null;
    const f = sfPath(args.root, args.sessionId);
    const map = loadMap(f);
    const prev = map[tgt.key];

    // sempre atualiza mapa
    map[tgt.key] = { hash: sha(args.result), at: Date.now(), count: (prev ? prev.count : 0) + 1 };
    const ks = Object.keys(map);
    while (ks.length > CAP) delete map[ks.shift()];
    saveMap(f, map);

    // duplicata só se prev existe E hash igual
    if (!prev || prev.hash !== map[tgt.key].hash) return null;

    return {
      duplicate: true,
      savedChars: args.result.length,
      originKey: tgt.key,
      stub: '[dupRead] conteúdo idêntico à leitura anterior (' + args.result.length + ' chars).\n(PT-BR) idêntico à leitura anterior.',
    };
  } catch (e) { return null; }
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

module.exports = { noteResult, checkRepeat, isRead };
