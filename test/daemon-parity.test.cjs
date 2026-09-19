'use strict';

const path = require('path');
const { CASES, cleanup } = require('./fixtures/cases.cjs');
const { decide } = require('../lib/decide.cjs');
const { dispatch, handleMessage } = require('../adapters/daemon-server.cjs');

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

try {
  const ctx = { cache: new Map(), hits: 0, misses: 0 };
  const norm = (v) => v == null ? '__NULL__' : JSON.stringify(v, Object.keys(typeof v === 'object' && v ? v : {}).sort());

  for (const [expect, label, payload] of CASES) {
    const direct = decide(payload);
    const viaDispatch = dispatch({ payload });
    check(
      `paridade: ${label}`,
      expect === 'deny' ? Boolean(direct && direct.decision === 'deny') : true,
      norm(direct)
    );
    check(
      `dispatch idêntico a decide(): ${label}`,
      norm(viaDispatch.verdict) === norm(direct),
      `direct=${norm(direct)} dispatch=${norm(viaDispatch.verdict)}`
    );
    const reply = handleMessage({ id: 1, method: 'check', params: { payload } }, ctx);
    check(
      `handleMessage idêntico a decide(): ${label}`,
      norm(reply.result.verdict) === norm(direct),
      `direct=${norm(direct)} handle=${norm(reply.result.verdict)}`
    );
  }

  const denyCase = CASES.find(([exp]) => exp === 'deny');
  const [, , denyPayload] = denyCase;
  const first = handleMessage({ id: 2, method: 'check', params: { payload: denyPayload } }, ctx);
  check('repeticao via handleMessage bate no cache', first.result.cached === true);
  check('cache preserva veredito identico ao decide()',
    norm(first.result.verdict) === norm(decide(denyPayload)));
} finally {
  cleanup();
}

console.log(`\n  daemon-parity: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);