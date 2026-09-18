'use strict';

const path = require('path');
const { CASES, cleanup } = require('./fixtures/cases.cjs');
const { decide } = require('../lib/decide.cjs');
const { dispatch } = require('../adapters/daemon-server.cjs');

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

for (const [expect, label, payload] of CASES) {
  const direct = decide(payload);
  const viaDispatch = dispatch({ payload });
  const norm = (v) => v == null ? '__NULL__' : JSON.stringify(v, Object.keys(typeof v === 'object' && v ? v : {}).sort());
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
}

cleanup();

console.log(`\n  daemon-parity: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);