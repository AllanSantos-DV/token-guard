'use strict';

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createServer, dispatch } = require('../adapters/daemon-server.cjs');
const { encodeFrame, parseStream } = require('../lib/ipc-frame.cjs');
const { CASES, TMP, cleanup } = require('./fixtures/cases.cjs');

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

function tmpEndpoint() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-daemon-'));
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\token-guard-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    : path.join(base, 'test.sock');
}

async function rpc(endpoint, msg) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(endpoint);
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timeout')); });
    sock.on('error', reject);
    const frames = parseStream(sock);
    let settled = false;
    frames.on('data', (reply) => {
      if (!settled && reply && reply.id === msg.id) {
        settled = true;
        sock.end();
        resolve(reply);
      }
    });
    sock.write(encodeFrame(msg));
  });
}

(async () => {
  const endpoint = tmpEndpoint();
  const server = createServer();
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(endpoint, res);
  });

  try {
    const hello = await rpc(endpoint, { id: 1, method: 'hello' });
    check('hello responde protocolVersion', hello.result && typeof hello.result.protocolVersion === 'number');
    check('hello responde packageVersion', hello.result && typeof hello.result.packageVersion === 'string');

    const ping = await rpc(endpoint, { id: 2, method: 'ping' });
    check('ping responde pong', ping.result && ping.result.pong === true);

    const unknown = await rpc(endpoint, { id: 3, method: 'nope' });
    check('método desconhecido retorna erro -32601', unknown.error && unknown.error.code === -32601);

    const denyCase = CASES.find(([exp]) => exp === 'deny');
    const [, , denyPayload] = denyCase;
    const r1 = await rpc(endpoint, { id: 4, method: 'check', params: { payload: denyPayload } });
    check('check serve um deny via IPC', r1.result && r1.result.ok && r1.result.verdict && r1.result.verdict.decision === 'deny');
    check('primeiro check é cache miss', r1.result && !r1.result.cached);

    const r2 = await rpc(endpoint, { id: 5, method: 'check', params: { payload: denyPayload } });
    check('segundo check igual retorna do cache', r2.result && r2.result.cached === true);
    check('cache mantém mesmo veredito', JSON.stringify(r2.result.verdict) === JSON.stringify(r1.result.verdict));

    const allowCase = CASES.find(([exp]) => exp === 'allow');
    const [, , allowPayload] = allowCase;
    const r3 = await rpc(endpoint, { id: 6, method: 'check', params: { payload: allowPayload } });
    check('check serve allow como verdict null', r3.result && r3.result.ok && r3.result.verdict === null);

    const hostile = [{}, [], 'string', 42, null];
    for (let i = 0; i < hostile.length; i++) {
      const rh = await rpc(endpoint, { id: 100 + i, method: 'check', params: { payload: hostile[i] } });
      check(`payload hostil ${i} não derruba o servidor`, rh.result && rh.result.ok !== undefined);
    }

    const afterHostile = await rpc(endpoint, { id: 200, method: 'ping' });
    check('servidor sobrevive a payloads hostis', afterHostile.result && afterHostile.result.pong === true);

    const d = dispatch({ payload: {} });
    check('dispatch direto funciona sem socket', d.ok === true);

    const cfgDir = path.join(TMP, '.token-guard');
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ threshold: 1000 }));
    const r4 = await rpc(endpoint, { id: 7, method: 'check', params: { root: TMP, payload: denyPayload } });
    check('primeiro check apos criar config é miss', r4.result && r4.result.ok && !r4.result.cached);
    fs.writeFileSync(cfgPath, JSON.stringify({ threshold: 2000 }));
    const r5 = await rpc(endpoint, { id: 8, method: 'check', params: { root: TMP, payload: denyPayload } });
    check('mudanca de config no disco gera nova chave (miss)', r5.result && r5.result.ok && !r5.result.cached);
    const r6 = await rpc(endpoint, { id: 9, method: 'check', params: { root: TMP, payload: denyPayload } });
    check('repeticao pos-mudanca bate no cache', r6.result && r6.result.cached === true);
  } finally {
    server.close();
    if (typeof endpoint === 'string' && !endpoint.startsWith('\\\\')) {
      try { fs.unlinkSync(endpoint); } catch { /* noop */ }
    }
    cleanup();
  }

  console.log(`\n  daemon-server: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();