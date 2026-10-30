'use strict';
/**
 * ui-launch.cjs — abre a tela de setup (`token-guard setup`).
 *
 * A tela é servida pelo daemon, por http local; então abrir a tela é, antes, garantir um daemon
 * com http de pé. Reusa o que o resto do produto já faz: o token do dono (arquivo no perfil), o
 * bring-up e o shutdown de lib/daemon-client.cjs, a sonda de lib/daemon-status.cjs. Sem token
 * ainda (instalação sem o alvo claude), cria um: ele só vale para este usuário e é o que liga o
 * http do daemon. Daemon vivo sem http é reiniciado, como o SessionStart já faz.
 *
 * Devolve a URL com um bilhete de uso único (60 s); o token do dono não vai para a URL.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const DH = require('../adapters/daemon-http.cjs');
const DC = require('./daemon-client.cjs');
const DS = require('./daemon-status.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Cria o token do dono se ainda não existe. @returns {{token:string, created:boolean}} */
function ensureToken() {
  const existing = DH.readToken();
  if (existing) return { token: existing, created: false };
  const token = crypto.randomBytes(24).toString('base64url');
  const file = DH.httpTokenPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 });
  return { token, created: true };
}

function postTicket(port, token, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/token-guard/ui/ticket', method: 'POST', timeout: timeoutMs,
      headers: { 'x-token-guard': token, 'content-length': 0 },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(raw);
          resolve(res.statusCode === 200 && j.url ? { ok: true, url: j.url } : { ok: false, error: j.error || `HTTP ${res.statusCode}` });
        } catch { resolve({ ok: false, error: `resposta ilegível (HTTP ${res.statusCode})` }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'o daemon não respondeu a tempo' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    req.end();
  });
}

/**
 * Garante daemon com http e devolve a URL de abertura.
 * @param {{bootTimeoutMs?:number}} [opts]
 * @returns {Promise<{ok:true, url:string, notes:string[]}|{ok:false, error:string, notes:string[]}>}
 */
async function prepare(opts = {}) {
  const notes = [];
  const { token, created } = ensureToken();
  if (created) notes.push('criei o token local do daemon (~/.token-guard/daemon-http.token)');

  let health = await DS.probeHealth(DH.httpPort(), token);
  if (health.state !== 'ok') {
    const hello = await DC.connectOnce('hello', {}, { timeoutMs: 500 });
    if (hello.ok) {
      notes.push('o daemon estava de pé sem o http da tela: reiniciei');
      await DC.shutdownDaemon();
      await sleep(300);
    } else {
      notes.push('o daemon estava fora do ar: subi');
    }
    DC.realSpawn(DC.DEFAULT_DAEMON_SERVER_PATH);
    const deadline = Date.now() + (opts.bootTimeoutMs || 8000);
    do {
      await sleep(150);
      health = await DS.probeHealth(DH.httpPort(), token);
    } while (health.state !== 'ok' && Date.now() < deadline);
    if (health.state !== 'ok') {
      return { ok: false, error: `o daemon não subiu o http a tempo (${health.state}${health.detail ? `: ${health.detail}` : ''}). Veja \`token-guard status\``, notes };
    }
  }
  const t = await postTicket(DH.httpPort(), token);
  return t.ok ? { ok: true, url: t.url, notes } : { ok: false, error: t.error, notes };
}

/** Abre a URL no navegador padrão, sem janela de console. */
function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

module.exports = { prepare, openBrowser, ensureToken, postTicket };
