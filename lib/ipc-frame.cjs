#!/usr/bin/env node
'use strict';

const { Transform } = require('stream');

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

class FrameOverflowError extends Error {
  constructor(bytes) {
    super(`frame excede teto de ${bytes} bytes`);
    this.name = 'FrameOverflowError';
  }
}

function encodeFrame(msg) {
  return JSON.stringify(msg) + '\n';
}

function parseStream(readable) {
  let buf = '';
  const decoder = new TextDecoder();
  const tx = new Transform({
    readableObjectMode: true,
    writableObjectMode: false,
    transform(chunk, _enc, cb) {
      buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        this.push(msg);
      }
      if (buf.length > MAX_FRAME_BYTES) {
        buf = '';
        cb(new FrameOverflowError(MAX_FRAME_BYTES));
        return;
      }
      cb();
    },
    flush(cb) {
      const tail = buf.trim();
      buf = '';
      if (tail && tail.length <= MAX_FRAME_BYTES) {
        try {
          this.push(JSON.parse(tail));
        } catch {
          /* lixo sem newline final: descarta em silencio */
        }
      }
      cb();
    },
  });
  readable.pipe(tx);
  return tx;
}

function writeFrame(writable, msg) {
  writable.write(encodeFrame(msg));
}

module.exports = { encodeFrame, parseStream, writeFrame, MAX_FRAME_BYTES, FrameOverflowError };