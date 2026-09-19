'use strict';
/**
 * daemon-client.cjs — helper único usado pelos três hooks (F3) pra tentar o
 * daemon-único antes do caminho efêmero local. QUALQUER falha de conexão,
 * timeout ou protocolo devolve {ok:false} — nunca lança. Não sobe o daemon
 * (isso é F5, fora de escopo aqui): só tenta um endpoint que já esteja de pé.
 */

const net = require('net');
const { encodeFrame, parseStream } = require('./ipc-frame.cjs');
const { defaultEndpoint } = require('../adapters/daemon-server.cjs');

let reqId = 0;

/**
 * TOKEN_GUARD=off é o escape hatch de emergência (lib/config.cjs:169-173) —
 * lido do env do PROCESSO CHAMADOR. O daemon roda num processo residente
 * separado, com seu próprio env congelado no boot: se o RPC seguisse pro
 * daemon mesmo assim, `CFG.load()` leria o TOKEN_GUARD do daemon (provavelmente
 * ausente/ligado), não o do chamador, e o escape hatch pararia de funcionar
 * pros hooks que passam pelo daemon. Corta ANTES de conectar: com a var
 * setada pra off, nunca tenta o daemon — cai direto no caminho local, que já
 * lê o env correto.
 */
function isTokenGuardOff() {
  const env = String(process.env.TOKEN_GUARD || '').toLowerCase();
  return env === 'off' || env === '0' || env === 'false';
}

/**
 * @param {string} method
 * @param {object} params
 * @param {{timeoutMs?: number, endpoint?: string}} [opts]
 * @returns {Promise<{ok:true, result:object}|{ok:false}>}
 */
function tryDaemon(method, params, opts) {
  if (isTokenGuardOff()) return Promise.resolve({ ok: false });
  const { timeoutMs = 200, endpoint } = opts || {};
  return new Promise((resolve) => {
    let settled = false;
    const finish = (out) => {
      if (settled) return;
      settled = true;
      resolve(out);
    };

    let sock;
    try {
      sock = net.connect(endpoint || defaultEndpoint());
    } catch {
      finish({ ok: false });
      return;
    }

    const timer = setTimeout(() => {
      try { sock.destroy(); } catch { /* noop */ }
      finish({ ok: false });
    }, timeoutMs);
    timer.unref?.();

    sock.on('error', () => {
      clearTimeout(timer);
      finish({ ok: false });
    });

    sock.on('connect', () => {
      const id = ++reqId;
      const frames = parseStream(sock);
      frames.on('data', (msg) => {
        if (!msg || msg.id !== id) return;
        clearTimeout(timer);
        try { sock.end(); } catch { /* noop */ }
        if (msg.error || !msg.result) finish({ ok: false });
        else finish({ ok: true, result: msg.result });
      });
      frames.on('error', () => {
        clearTimeout(timer);
        try { sock.destroy(); } catch { /* noop */ }
        finish({ ok: false });
      });
      try {
        sock.write(encodeFrame({ id, method, params }));
      } catch {
        clearTimeout(timer);
        finish({ ok: false });
      }
    });
  });
}

module.exports = { tryDaemon };
