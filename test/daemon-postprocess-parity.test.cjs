'use strict';

/**
 * daemon-postprocess-parity.test.cjs — paridade do RPC `postprocess` contra a
 * sequência real de post-hook.cjs:26-53 (CFG.load + postProcess + dupRead).
 * Mesmo estilo de test/daemon-parity.test.cjs.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const CFG = require('../lib/config.cjs');
const { noteResult, isRead } = require('../lib/dupread.cjs');
const { postProcess } = require('../lib/postresult.cjs');
const { dispatchPostprocess, handleMessage } = require('../adapters/daemon-server.cjs');

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

/**
 * postProcess() grava o integral em disco com nome prefixado por Date.now() —
 * cada chamada (direct/dispatch/handleMessage) roda em milissegundos diferentes,
 * então o nome do arquivo diverge por natureza. Normaliza esse carimbo antes de
 * comparar, do mesmo jeito que qualquer chamador real trataria (o caminho muda
 * a cada execução, o conteúdo/estrutura não).
 */
function stripTimestamp(v) {
  const s = JSON.stringify(v, Object.keys(typeof v === 'object' && v ? v : {}).sort());
  return s.replace(/\d{13}-[a-z0-9-]+\.txt/gi, '__SAVED__');
}
const norm = (v) => v == null ? '__NULL__' : stripTimestamp(v);

/** Replica post-hook.cjs:26-53 — a mesma sequência que dispatchPostprocess. */
function computeDirect({ name, input, result, root, sessionId }) {
  const cfg = CFG.load(root);
  const trimmed = postProcess({ name, input, result, root, cfg });
  if (trimmed) return { trimmed };
  if (sessionId && isRead(name)) {
    try { noteResult({ name, input, result, root, sessionId, cfg }); } catch { /* evidência */ }
  }
  return { trimmed: null };
}

function newRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-daemon-post-'));
}

function assertParity(label, params) {
  CFG.clearMemo();
  const direct = computeDirect(params);
  const viaDispatch = dispatchPostprocess(params);
  check(`dispatchPostprocess idêntico ao direto: ${label}`,
    norm(viaDispatch.trimmed) === norm(direct.trimmed),
    `direct=${norm(direct.trimmed)} dispatch=${norm(viaDispatch.trimmed)}`);

  const reply = handleMessage({ id: 1, method: 'postprocess', params }, { cache: new Map(), hits: 0, misses: 0 });
  check(`handleMessage idêntico ao direto: ${label}`,
    norm(reply.result.trimmed) === norm(direct.trimmed),
    `direct=${norm(direct.trimmed)} handle=${norm(reply.result.trimmed)}`);
}

const cleanupDirs = [];

try {
  // Caso 1: bigResult abaixo do limite (passa intacto)
  {
    const root = newRoot();
    cleanupDirs.push(root);
    assertParity('bigResult abaixo do limite', {
      name: 'View', input: {}, result: 'curto', root, sessionId: 'sess-1',
    });
  }

  // Caso 2: bigResult acima do limite (trunca)
  {
    const root = newRoot();
    cleanupDirs.push(root);
    assertParity('bigResult acima do limite', {
      name: 'Grep', input: {}, result: 'x'.repeat(30000), root, sessionId: 'sess-2',
    });
  }

  // Caso 3: dupRead hit (segunda leitura idêntica do mesmo arquivo)
  {
    const root = newRoot();
    cleanupDirs.push(root);
    const params1 = {
      name: 'view', input: { file_path: path.join(root, 'a.txt') }, result: 'conteudo idêntico',
      root, sessionId: 'sess-3',
    };
    // primeira leitura — direto E via dispatch escrevem no MESMO arquivo de sessão,
    // então rodamos a sequência real uma vez (direto) pra popular o mapa antes de comparar.
    computeDirect(params1);
    assertParity('dupRead hit', params1);
  }

  // Caso 4: dupRead miss (arquivo nunca visto)
  {
    const root = newRoot();
    cleanupDirs.push(root);
    assertParity('dupRead miss', {
      name: 'view', input: { file_path: path.join(root, 'novo.txt') }, result: 'conteudo novo',
      root, sessionId: 'sess-4',
    });
  }

  // Caso 5: sessionId ausente
  {
    const root = newRoot();
    cleanupDirs.push(root);
    assertParity('sessionId ausente', {
      name: 'view', input: { file_path: path.join(root, 'b.txt') }, result: 'conteudo',
      root, sessionId: undefined,
    });
  }

  // Caso 6: ferramenta que não é leitura (dupRead nunca dispara)
  {
    const root = newRoot();
    cleanupDirs.push(root);
    assertParity('ferramenta não-leitura', {
      name: 'Bash', input: {}, result: 'saída de shell', root, sessionId: 'sess-6',
    });
  }
} finally {
  CFG.clearMemo();
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(`\n  daemon-postprocess-parity: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
