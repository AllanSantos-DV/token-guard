#!/usr/bin/env node
'use strict';

const { PassThrough } = require('stream');
let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${label}`);
  } else {
    fail += 1;
    console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

async function collectFrames(readable) {
  const frames = [];
  for await (const frame of readable) frames.push(frame);
  return frames;
}

function feedChunked(chunks) {
  const pt = new PassThrough();
  let i = 0;
  function pump() {
    if (i >= chunks.length) return void pt.end();
    pt.write(Buffer.from(chunks[i++]));
    setImmediate(pump);
  }
  pump();
  return pt;
}

async function main() {
  console.log('\n  [ipc-frame · transporte JSON-RPC newline-delimited]');

  const ipc = require('../lib/ipc-frame.cjs');
  check('modulo expoe encodeFrame/parseStream/writeFrame', typeof ipc.encodeFrame === 'function' && typeof ipc.parseStream === 'function' && typeof ipc.writeFrame === 'function');

  const msg = { jsonrpc: '2.0', id: 1, method: 'check', params: { eventKind: 'PreToolUse', payload: { cwd: '/tmp' } } };
  const encoded = ipc.encodeFrame(msg);
  check('encodeFrame serializa JSON + \\n exato', encoded.endsWith('\n') && JSON.parse(encoded.slice(0, -1)).method === 'check');

  const wire = `${JSON.stringify({ id: 10, method: 'a' })}\n${JSON.stringify({ id: 11, method: 'b' })}\n`;
  const decoded = await collectFrames(ipc.parseStream(feedChunked([wire])));
  check('decode multiplo frames preserva ordem', decoded.length === 2 && decoded[0].id === 10 && decoded[1].id === 11);

  const split = [`${JSON.stringify({ id: 20, x: 1 }).slice(0, 8)}`, Buffer.from(JSON.stringify({ id: 20, x: 1 }).slice(8)), '\n'];
  const partial = await collectFrames(ipc.parseStream(feedChunked(split)));
  check('frame quebrado entre chunks remonta sem perda', partial.length === 1 && partial[0].id === 20 && partial[0].x === 1);

  const dirty = [`\n`, `   \n`, `{nao eh json\n`, `${JSON.stringify({ id: 30 })}\n`, ``];
  const ignored = await collectFrames(ipc.parseStream(feedChunked(dirty)));
  check('lixo/linha vazia ignorados em silencio (padrao mcp-server)', ignored.length === 1 && ignored[0].id === 30);

  const outOfOrder = [`${JSON.stringify({ id: 1, result: 'first' })}\n`, `${JSON.stringify({ id: 2, result: 'second' })}\n`, `${JSON.stringify({ id: 1, result: 'dup' })}\n`];
  const correlated = await collectFrames(ipc.parseStream(feedChunked(outOfOrder)));
  check('correlacao por id aceita chegada fora de ordem e duplicada', correlated.length === 3 && correlated.every((f) => typeof f.id === 'number'));

  const bigPayload = 'z'.repeat(512 * 1024);
  const bigWire = `${JSON.stringify({ id: 99, blob: bigPayload })}\n`;
  const bigChunks = [];
  for (let off = 0; off < bigWire.length; off += 64 * 1024) bigChunks.push(bigWire.slice(off, off + 64 * 1024));
  const bigDecoded = await collectFrames(ipc.parseStream(feedChunked(bigChunks)));
  check('payload grande (>256KB) sobrevive fatiado', bigDecoded.length === 1 && bigDecoded[0].blob.length === bigPayload.length);

  const sink = new PassThrough();
  const written = [];
  sink.on('data', (d) => written.push(d.toString()));
  ipc.writeFrame(sink, { id: 7, method: 'ping' });
  const raw = written.join('');
  check('writeFrame escreve exatamente uma linha JSON', raw.split('\n').filter(Boolean).length === 1 && JSON.parse(raw.trim()).id === 7);

  check('modulo expoe MAX_FRAME_BYTES e FrameOverflowError', typeof ipc.MAX_FRAME_BYTES === 'number' && typeof ipc.FrameOverflowError === 'function');

  const hugeLine = Buffer.alloc(ipc.MAX_FRAME_BYTES + 1024, 'a');
  const overPt = new PassThrough();
  let overflowErr = null;
  const overTx = ipc.parseStream(overPt);
  overTx.on('error', (e) => { overflowErr = e; });
  overTx.resume();
  overPt.write(hugeLine);
  await new Promise((r) => setImmediate(r));
  check('frame acima do teto lanca FrameOverflowError', overflowErr instanceof ipc.FrameOverflowError);
  overPt.destroy();

  console.log('');
  console.log(`  ${pass} passaram · ${fail} falharam`);
}

main().then(() => process.exit(fail ? 1 : 0)).catch((err) => {
  console.error(err);
  process.exit(1);
});