'use strict';
/**
 * daemon-ui.cjs — a tela de setup e o fluxo de eventos do ícone da bandeja, servidos pelo
 * próprio daemon no mesmo http local dos hooks (127.0.0.1, sem porta nova).
 *
 * Entrada (o navegador não manda o header de token): quem tem o token do dono (CLI `setup`,
 * ícone da bandeja) pede um BILHETE de uso único (POST /token-guard/ui/ticket, header
 * X-Token-Guard, vale 60 s) e abre /token-guard/ui?ticket=…; o daemon troca o bilhete por um
 * cookie de sessão HttpOnly/SameSite=Strict e redireciona para a URL limpa. O token do dono
 * nunca vai para a barra de endereço nem para o histórico.
 *
 * Defesas da tela: Host precisa ser o loopback desta porta (barra DNS rebinding), escrita exige
 * o cookie MAIS um token anti-CSRF no header (o HTML embute o da sessão), Origin presente tem de
 * ser a própria origem, CSP com nonce, sem recurso externo.
 *
 * A tela e a bandeja são EMPURRADAS por SSE: cada bloqueio, cada poupança e cada mudança de config
 * chega como evento (lib/events.cjs `bus` + fs.watch da config); ninguém consulta em laço.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const CFG = require('../lib/config.cjs');
const CE = require('../lib/config-edit.cjs');
const EV = require('../lib/events.cjs');
const CAT = require('../lib/catalog.cjs');

const BASE = '/token-guard';
const TICKET_TTL_MS = 60 * 1000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const HEARTBEAT_MS = 25 * 1000;
const COALESCE_MS = 100;
const MAX_BODY = 16 * 1024;
const COOKIE = 'tg_ui';

const rand = (n = 24) => crypto.randomBytes(n).toString('base64url');

function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Estado do guarda para o ícone e para o selo da tela.
 *   off     — desligado por inteiro (modo geral off, ou TOKEN_GUARD=off)
 *   partial — ligado, mas algum IDE ou alguma regra está desligado
 *   on      — tudo ligado
 */
function guardState(cfg, rulesOn) {
  if (cfg.mode === 'off') return 'off';
  const targetOff = Object.values(cfg.targets || {}).some((m) => m === 'off');
  const ruleOff = CAT.RULES.some((r) => !rulesOn.includes(r.id));
  return targetOff || ruleOff ? 'partial' : 'on';
}

const STATE_LABEL = {
  on: 'Protegendo',
  partial: 'Protegendo em parte',
  off: 'Desligado',
};

/**
 * @param {{token:string, version:string, getPort:()=>number, startedAt?:number, onSaved?:(patch:object)=>void}} opts
 *        onSaved: avisado depois de gravar a config (o daemon sobe o ícone se a tela o religou).
 * @returns {{handle:(req,res,route:string)=>boolean, snapshot:()=>object, close:()=>void}}
 */
function create({ token, version, getPort, startedAt = Date.now(), onSaved }) {
  const tickets = new Map();
  const sessions = new Map();
  const clients = new Set();
  let timer = null;
  let pending = false;
  let heartbeat = null;
  let watcher = null;

  function snapshot() {
    const cfg = CFG.load(os.homedir());
    const rulesOn = CFG.activeRules(cfg);
    const user = CE.readUserConfig();
    const stats = EV.summary();
    const state = guardState(cfg, rulesOn);
    return {
      version,
      pid: process.pid,
      port: getPort(),
      uptimeMs: Date.now() - startedAt,
      state,
      stateLabel: STATE_LABEL[state],
      platform: process.platform,
      config: {
        mode: cfg.mode,
        envOff: ['off', '0', 'false'].includes(String(process.env.TOKEN_GUARD || '').toLowerCase()),
        targets: cfg.targets || {},
        rules: Object.fromEntries(CAT.RULES.map((r) => [r.id, rulesOn.includes(r.id)])),
        tray: cfg.ui.tray,
        file: CE.userConfigPath(),
        fileError: user.ok ? null : user.error,
      },
      stats,
      catalog: { rules: CAT.RULES, targets: CAT.TARGETS },
    };
  }

  /** O que o ícone precisa: estado e dois números do dia. Pequeno, para empurrar a cada evento. */
  function trayOf(s) {
    return {
      state: s.state, label: s.stateLabel, version: s.version, show: s.config.tray,
      blocksToday: s.stats.today.blocks, tokensToday: s.stats.today.tokensSaved,
    };
  }
  const trayView = () => trayOf(snapshot());

  function send(res, event, data) {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* cliente caiu: o close remove */ }
  }

  function pushAll() {
    if (!clients.size) return;
    const snap = snapshot();
    const tray = trayOf(snap);
    for (const c of clients) send(c.res, c.kind === 'tray' ? 'tray' : 'snapshot', c.kind === 'tray' ? tray : snap);
  }

  /** Vários eventos em rajada viram um empurrão só. */
  function schedulePush() {
    if (pending) return;
    pending = true;
    timer = setTimeout(() => { pending = false; try { pushAll(); } catch { /* o próximo evento empurra de novo */ } }, COALESCE_MS);
    if (timer.unref) timer.unref();
  }

  EV.bus.on('event', schedulePush);

  try {
    const dir = path.dirname(CE.userConfigPath());
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, { persistent: false }, (_t, name) => {
      if (name === CFG.CONFIG_NAME) { CFG.clearMemo(); schedulePush(); }
      // Bloqueio registrado por outro processo (hook sem daemon, plugin do Copilot, Cursor, MCP).
      else if (name === 'events.jsonl') schedulePush();
    });
    watcher.on('error', () => {});
  } catch { /* sem watch, a tela ainda atualiza quando ela mesma grava */ }

  heartbeat = setInterval(() => { for (const c of clients) { try { c.res.write(': ping\n\n'); } catch { /* idem */ } } }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  function hostOk(req) {
    const port = getPort();
    return [`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host || '').toLowerCase());
  }

  function originOk(req) {
    const o = req.headers.origin;
    if (!o) return true;
    const port = getPort();
    return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
  }

  function sessionOf(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const s = sid && sessions.get(sid);
    if (!s) return null;
    if (Date.now() - s.at > SESSION_TTL_MS) { sessions.delete(sid); return null; }
    return s;
  }

  function newSession() {
    for (const [k, v] of sessions) if (Date.now() - v.at > SESSION_TTL_MS) sessions.delete(k);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const sid = rand(32);
    sessions.set(sid, { csrf: rand(24), at: Date.now() });
    return sid;
  }

  function json(res, status, body, extra) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(body));
  }

  function openStream(req, res, kind) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const client = { res, kind };
    clients.add(client);
    req.on('close', () => clients.delete(client));
    if (kind === 'tray') send(res, 'tray', trayView());
    else send(res, 'snapshot', snapshot());
  }

  function readBody(req, res, cb) {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { json(res, 413, { ok: false, error: 'pedido grande demais' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return json(res, 400, { ok: false, error: 'JSON inválido' }); }
      cb(body);
    });
  }

  let html = null;
  function page() {
    if (!html) html = fs.readFileSync(path.join(__dirname, 'ui', 'setup.html'), 'utf8');
    return html;
  }

  /** @returns {boolean} true se a rota era da tela (e já foi respondida) */
  function handle(req, res, route) {
    const isUi = route === `${BASE}/ui` || route.startsWith(`${BASE}/ui/`);
    const isTrayStream = route === `${BASE}/stream`;
    if (!isUi && !isTrayStream) return false;

    if (!hostOk(req)) { json(res, 403, { ok: false, error: 'host não permitido' }); return true; }

    // Quem fala com o token do dono (CLI, bandeja): bilhete e fluxo do ícone.
    if (route === `${BASE}/ui/ticket` || isTrayStream) {
      if (!sameToken(req.headers['x-token-guard'], token)) { json(res, 401, { ok: false, error: 'token ausente ou invalido' }); return true; }
      if (isTrayStream) {
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'use GET' }); return true; }
        openStream(req, res, 'tray');
        return true;
      }
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'use POST' }); return true; }
      for (const [k, exp] of tickets) if (exp < Date.now()) tickets.delete(k);
      const ticket = rand(24);
      tickets.set(ticket, Date.now() + TICKET_TTL_MS);
      json(res, 200, { ok: true, ticket, url: `http://127.0.0.1:${getPort()}${BASE}/ui?ticket=${ticket}` });
      return true;
    }

    // Troca de bilhete por sessão.
    const url = new URL(req.url, 'http://x');
    if (route === `${BASE}/ui` && url.searchParams.has('ticket')) {
      const t = url.searchParams.get('ticket');
      const exp = tickets.get(t);
      tickets.delete(t);
      if (!exp || exp < Date.now()) {
        json(res, 401, { ok: false, error: 'bilhete inválido ou vencido: abra a tela de novo pelo ícone ou por `token-guard setup`' });
        return true;
      }
      const sid = newSession();
      res.writeHead(302, {
        location: `${BASE}/ui`,
        'set-cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=${BASE}`,
        'cache-control': 'no-store',
      });
      res.end();
      return true;
    }

    const session = sessionOf(req);
    if (!session) {
      json(res, 401, { ok: false, error: 'sessão ausente: abra a tela pelo ícone da bandeja ou por `token-guard setup`' });
      return true;
    }

    if (route === `${BASE}/ui` && req.method === 'GET') {
      const nonce = rand(16);
      const body = page().replace(/__NONCE__/g, nonce).replace(/__CSRF__/g, session.csrf);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
      res.end(body);
      return true;
    }
    if (route === `${BASE}/ui/api/state` && req.method === 'GET') { json(res, 200, snapshot()); return true; }
    if (route === `${BASE}/ui/stream` && req.method === 'GET') { openStream(req, res, 'ui'); return true; }
    if (route === `${BASE}/ui/api/config` && req.method === 'POST') {
      if (!originOk(req) || !sameToken(req.headers['x-tg-csrf'], session.csrf)) {
        json(res, 403, { ok: false, error: 'pedido recusado (origem ou token anti-CSRF)' });
        return true;
      }
      readBody(req, res, (body) => {
        const r = CE.save(body);
        if (!r.ok) return json(res, 400, { ok: false, error: r.error });
        schedulePush();
        if (onSaved) { try { onSaved(body); } catch { /* aviso é cortesia */ } }
        json(res, 200, { ok: true, snapshot: snapshot() });
      });
      return true;
    }
    json(res, 404, { ok: false, error: 'rota desconhecida' });
    return true;
  }

  function close() {
    EV.bus.removeListener('event', schedulePush);
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    if (watcher) { try { watcher.close(); } catch { /* já fechado */ } }
    for (const c of clients) { try { c.res.end(); } catch { /* idem */ } }
    clients.clear();
  }

  return { handle, snapshot, trayView, close };
}

module.exports = { create, guardState, STATE_LABEL, BASE };
