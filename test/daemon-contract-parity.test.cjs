'use strict';

/**
 * daemon-contract-parity.test.cjs — paridade do RPC `contract` contra a
 * sequência real de prompt-hook.cjs:42-52 (CFG.load + CT.load/readState/
 * readTouched/decide). Mesmo estilo de test/daemon-parity.test.cjs.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const CFG = require('../lib/config.cjs');
const CT = require('../lib/contract.cjs');
const { dispatchContract, handleMessage } = require('../adapters/daemon-server.cjs');

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

const norm = (v) => v == null ? '__NULL__' : JSON.stringify(v, Object.keys(typeof v === 'object' && v ? v : {}).sort());

/** Replica prompt-hook.cjs:42-52 — a mesma sequência que dispatchContract. */
function computeDirect(root, sessionId) {
  const cfg = CFG.load(root);
  if (cfg.mode === 'off') return { triggers: [], text: '' };
  const contract = CT.load(root);
  if (!contract.order.length) return { triggers: [], text: '' };
  const state = CT.readState(root, sessionId);
  const touched = CT.readTouched(root, sessionId);
  const decision = CT.decide({ contract, touched, injected: state.injected });
  return { triggers: decision.triggers, text: decision.text };
}

function newRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-daemon-contract-'));
}

function assertParity(label, root, sessionId) {
  CFG.clearMemo();
  const direct = computeDirect(root, sessionId);
  const viaDispatch = dispatchContract({ root, sessionId });
  check(`dispatchContract idêntico ao direto: ${label}`,
    norm({ triggers: viaDispatch.triggers, text: viaDispatch.text }) === norm(direct),
    `direct=${norm(direct)} dispatch=${norm({ triggers: viaDispatch.triggers, text: viaDispatch.text })}`);

  const reply = handleMessage({ id: 1, method: 'contract', params: { root, sessionId } }, { cache: new Map(), hits: 0, misses: 0 });
  check(`handleMessage idêntico ao direto: ${label}`,
    norm({ triggers: reply.result.triggers, text: reply.result.text }) === norm(direct),
    `direct=${norm(direct)} handle=${norm({ triggers: reply.result.triggers, text: reply.result.text })}`);
}

const cleanupDirs = [];

try {
  // Caso 1: contrato vazio (TOKEN_GUARD=off zera CT.load, independente de cfg.mode)
  {
    const root = newRoot();
    cleanupDirs.push(root);
    const antes = process.env.TOKEN_GUARD;
    process.env.TOKEN_GUARD = 'off';
    try {
      assertParity('contrato vazio', root, 'sess-vazio');
    } finally {
      if (antes === undefined) delete process.env.TOKEN_GUARD; else process.env.TOKEN_GUARD = antes;
    }
  }

  // Caso 2: contrato sempre-only
  {
    const root = newRoot();
    cleanupDirs.push(root);
    fs.writeFileSync(path.join(root, 'contract.md'), '## sempre\n\n- Regra sempre.\n', 'utf8');
    assertParity('contrato sempre-only', root, 'sess-sempre');
  }

  // Caso 3: gatilho por touched (código)
  {
    const root = newRoot();
    cleanupDirs.push(root);
    fs.writeFileSync(path.join(root, 'contract.md'), '## quando: codigo\n\n- Regra de código.\n', 'utf8');
    CT.recordTouched(root, 'sess-touched', ['lib/a.cjs']);
    assertParity('gatilho por touched (código)', root, 'sess-touched');
  }

  // Caso 3b: gatilho por touched (teste/docs)
  {
    const root = newRoot();
    cleanupDirs.push(root);
    fs.writeFileSync(path.join(root, 'contract.md'),
      '## quando: teste\n\n- Regra de teste.\n\n## quando: docs\n\n- Regra de docs.\n', 'utf8');
    CT.recordTouched(root, 'sess-touched2', ['test/x.test.cjs', 'README.md']);
    assertParity('gatilho por touched (teste/docs)', root, 'sess-touched2');
  }

  // Caso 4: seção já injetada não volta
  {
    const root = newRoot();
    cleanupDirs.push(root);
    fs.writeFileSync(path.join(root, 'contract.md'), '## sempre\n\n- Regra sempre.\n', 'utf8');
    CT.writeState(root, 'sess-injetada', { injected: ['sempre'] });
    assertParity('seção já injetada', root, 'sess-injetada');
  }

  // Caso 5: cfg.mode === 'off' (via token-guard.config.json do root)
  {
    const root = newRoot();
    cleanupDirs.push(root);
    fs.writeFileSync(path.join(root, 'token-guard.config.json'), JSON.stringify({ mode: 'off' }), 'utf8');
    fs.writeFileSync(path.join(root, 'contract.md'), '## sempre\n\n- Regra sempre.\n', 'utf8');
    assertParity('cfg.mode=off', root, 'sess-cfgoff');
  }

  // Caso 6: sessionId ausente
  {
    const root = newRoot();
    cleanupDirs.push(root);
    fs.writeFileSync(path.join(root, 'contract.md'), '## sempre\n\n- Regra sempre.\n', 'utf8');
    assertParity('sessionId ausente', root, undefined);
  }
} finally {
  CFG.clearMemo();
  for (const d of cleanupDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(`\n  daemon-contract-parity: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
