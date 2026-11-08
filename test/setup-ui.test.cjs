#!/usr/bin/env node
'use strict';
/**
 * setup-ui.test.cjs — a tela de setup e o fluxo do ícone, servidos por um daemon REAL isolado
 * (home temporária, porta própria, SID próprio, bandeja desligada): nenhuma janela, nenhum
 * ícone, nenhum contato com o daemon do usuário.
 *
 * Garantias:
 *   · entrar na tela exige o token do dono → bilhete de uso único (60 s) → cookie de sessão;
 *   · Host fora do loopback, escrita sem token anti-CSRF e Origin estranha são recusados;
 *   · escrever pela tela vale na hora para quem lê a config e é EMPURRADO por SSE (sem consulta);
 *   · o ícone recebe estado e contagem por SSE com o token do dono; religar/desligar o geral muda a cor;
 *   · `token-guard setup --no-open` prepara o daemon e entrega uma URL que abre a tela.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const DH = require('../adapters/daemon-http.cjs');
const UI = require('../adapters/daemon-ui.cjs');
const CFG = require('../lib/config.cjs');
const CE = require('../lib/config-edit.cjs');
const DC = require('../lib/daemon-client.cjs');
const { BIG, TMP } = require('./fixtures/cases.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); }
  else { fail += 1; console.log(`  FALHA ${label}${detail !== undefined ? `\n        ${JSON.stringify(detail).slice(0, 400)}` : ''}`); }
}

const token = `tok-${Math.random().toString(36).slice(2)}`;
const port = 47000 + Math.floor(Math.random() * 2000);

function req(method, route, { headers = {}, body, host } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const h = { ...headers };
    if (host) h.host = host;
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(data); }
    const r = http.request({ host: '127.0.0.1', port, path: route, method, headers: h }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
    });
    r.on('error', (e) => resolve({ status: 0, body: e.code, headers: {} }));
    r.end(data || undefined);
  });
}

/** Abre um SSE e entrega cada evento a `onEvent`. */
function sse(route, headers) {
  const events = [];
  const waiters = [];
  const r = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', headers }, (res) => {
    res.setEncoding('utf8');
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const dat = /^data: (.+)$/m.exec(block);
        if (ev && dat) {
          const e = { event: ev[1], data: JSON.parse(dat[1]) };
          events.push(e);
          for (const w of waiters.splice(0)) w();
        }
      }
    });
    res.on('error', () => {});
  });
  r.on('error', () => {});
  r.end();
  const waitFor = (pred, ms = 3000) => new Promise((resolve) => {
    const t0 = Date.now();
    const look = () => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return resolve(null);
      waiters.push(look);
      setTimeout(look, 50);
    };
    look();
  });
  return { events, waitFor, close: () => r.destroy() };
}

const endpointFor = (s) => (process.platform === 'win32'
  ? `\\\\.\\pipe\\token-guard-${s}` : path.join(process.env.XDG_RUNTIME_DIR || '/tmp', `token-guard-${s}.sock`));
const cookieOf = (res) => /tg_ui=[^;]+/.exec([].concat(res.headers['set-cookie'] || []).join(';'))?.[0];
const csrfOf = (html) => /name="tg-csrf" content="([^"]+)"/.exec(html)?.[1];

(async () => {
  const tokenFile = DH.httpTokenPath();
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token);
  const cfgFile = CE.userConfigPath();
  const sid = `ui-${process.pid}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'adapters', 'daemon-server.cjs')], {
    env: { ...process.env, TOKEN_GUARD_SID: sid, TOKEN_GUARD_HTTP_PORT: String(port), TOKEN_GUARD_TRAY: 'off' },
    stdio: 'ignore', windowsHide: true,
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await new Promise((r) => setTimeout(r, 75));
    up = (await req('GET', DH.HEALTH, { headers: { 'x-token-guard': token } })).status === 200;
  }

  try {
    check('daemon real de pé na porta isolada', up);

    console.log('\n  [estado do guarda]');
    const rulesOn = CFG.activeRules(CFG.load(TMP));
    check('tudo ligado → on', UI.guardState(CFG.load(TMP), rulesOn) === 'on');
    check('regra desligada → partial', UI.guardState(CFG.load(TMP), rulesOn.filter((r) => r !== 'scout')) === 'partial');
    check('IDE desligado → partial', UI.guardState({ mode: 'block', targets: { claude: 'off' } }, rulesOn) === 'partial');
    check('geral desligado → off', UI.guardState({ mode: 'off', targets: {} }, rulesOn) === 'off');

    console.log('\n  [entrada: token do dono → bilhete → cookie]');
    const noTok = await req('POST', '/token-guard/ui/ticket');
    check('bilhete sem token → 401', noTok.status === 401, noTok);
    check('GET na tela sem sessão → 401 (nunca a página)', (await req('GET', '/token-guard/ui')).status === 401);
    check('estado sem sessão → 401', (await req('GET', '/token-guard/ui/api/state')).status === 401);
    const t1 = await req('POST', '/token-guard/ui/ticket', { headers: { 'x-token-guard': token } });
    const ticket = JSON.parse(t1.body);
    check('bilhete com token → URL com bilhete (sem o token do dono)', t1.status === 200 && ticket.url.includes(`127.0.0.1:${port}/token-guard/ui?ticket=`) && !ticket.url.includes(token), t1.body);
    const ex = await req('GET', `/token-guard/ui?ticket=${ticket.ticket}`);
    const cookie = cookieOf(ex);
    check('troca o bilhete por cookie e redireciona para a URL limpa', ex.status === 302 && ex.headers.location === '/token-guard/ui' && Boolean(cookie), ex.headers);
    check('cookie é HttpOnly, SameSite=Strict e restrito ao caminho', /HttpOnly/.test(ex.headers['set-cookie'][0]) && /SameSite=Strict/.test(ex.headers['set-cookie'][0]) && /Path=\/token-guard/.test(ex.headers['set-cookie'][0]));
    check('bilhete é de uso único', (await req('GET', `/token-guard/ui?ticket=${ticket.ticket}`)).status === 401);
    check('bilhete inventado → 401', (await req('GET', '/token-guard/ui?ticket=nada')).status === 401);

    console.log('\n  [a página]');
    const page = await req('GET', '/token-guard/ui', { headers: { cookie } });
    const csrf = csrfOf(page.body);
    check('página de setup com a sessão', page.status === 200 && /<title>token-guard/.test(page.body) && csrf);
    const csp = page.headers['content-security-policy'] || '';
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    check('CSP com nonce, sem recurso externo, sem moldura', Boolean(nonce) && /default-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /connect-src 'self'/.test(csp), csp);
    check('o nonce da CSP está no script e no estilo da página', page.body.includes(`<script nonce="${nonce}">`) && page.body.includes(`<style nonce="${nonce}">`));
    check('a página não puxa nada de fora (nenhum http(s):// carregado)', !/(src|href)=["']https?:/.test(page.body) && !/url\(https?:/.test(page.body));
    check('a página não usa estilo inline (a CSP o barraria)', !/ style="/.test(page.body));
    check('sem cache e sem placeholder sobrando', page.headers['cache-control'] === 'no-store' && !/__NONCE__|__CSRF__/.test(page.body));
    check('a página consulta a rota de custo e mostra o dólar com a conta', /\/token-guard\/ui\/api\/cost\?since=/.test(page.body) && /id="usd-body"/.test(page.body) && /id="cost-body"/.test(page.body) && /data-periodo="24h"/.test(page.body) && /data-periodo="30d"/.test(page.body));

    console.log('\n  [tabela de repositórios: 15 maiores e "mostrar todos"]');
    const vm = require('vm');
    const grab = (name) => new RegExp(`  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`).exec(page.body)?.[0];
    const fns = ['sortRepos', 'visibleRepos'].map(grab);
    check('a página define o recorte dos 15 maiores', fns.every(Boolean) && /var TOP_REPOS = 15;/.test(page.body));
    const sandbox = vm.createContext({});
    vm.runInContext(`var TOP_REPOS = 15;\n${fns.join('\n')}`, sandbox);
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ name: `r${String(i).padStart(2, '0')}`, usd: i + 1 }));
    const sortedMany = vm.runInContext('sortRepos', sandbox)(mk(40));
    const vis = vm.runInContext('visibleRepos', sandbox);
    check('recolhido: só os 15 de maior custo, do maior para o menor', vis(sortedMany, false).length === 15 && vis(sortedMany, false)[0].usd === 40 && vis(sortedMany, false)[14].usd === 26);
    check('expandido: todos os 40, na mesma ordem', vis(sortedMany, true).length === 40 && vis(sortedMany, true)[39].usd === 1);
    check('com 15 ou menos não há o que recolher', vis(vm.runInContext('sortRepos', sandbox)(mk(15)), false).length === 15 && vis(vm.runInContext('sortRepos', sandbox)(mk(3)), false).length === 3);
    check('o controle é um botão com aria-expanded e aria-controls, nos dois rótulos',
      /id: 'repos-toggle', 'aria-expanded': String\(showAllRepos\), 'aria-controls': 'cost-repos'/.test(page.body) && /'Mostrar todos os ' \+ sorted\.length \+ ' repositórios'/.test(page.body) && /'Mostrar só os ' \+ TOP_REPOS \+ ' maiores'/.test(page.body));
    check('o recolhido avisa quanto somam os repositórios escondidos, o total continua o de todos', /Os outros ' \+ rest\.length \+ ' repositórios somam aprox\. '/.test(page.body) && /c\.total\.usd/.test(page.body));

    console.log('\n  [contraste da página, WCAG 1.4.3]');
    const lum = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const block = (re) => Object.fromEntries([...re.exec(page.body)[1].matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]));
    const themes = { claro: block(/:root \{([^}]*)\}/), escuro: block(/prefers-color-scheme: dark\) \{\s*:root \{([^}]*)\}/) };
    const pairs = [['ink', 'bg'], ['ink', 'card'], ['muted', 'bg'], ['muted', 'card'], ['muted', 'alt'], ['on', 'on-bg'], ['partial', 'partial-bg'], ['off', 'off-bg'], ['down', 'down-bg'], ['accent', 'card'], ['partial', 'card'], ['off', 'card']];
    for (const [name, t] of Object.entries(themes)) {
      const low = pairs.map(([f, b]) => [`${f}/${b}`, contrast(t[f], t[b])]).filter(([, r]) => r < 4.5);
      check(`tema ${name}: todo par de texto passa de 4,5:1`, low.length === 0, low.map(([n, r]) => `${n}=${r.toFixed(2)}`).join(' '));
    }
    check('o verde e o âmbar do tema claro são os medidos (#1a7a4b, #8f5a05)', themes.claro.on === '#1a7a4b' && themes.claro.accent === '#1a7a4b' && themes.claro.partial === '#8f5a05');

    const rebind = await req('GET', '/token-guard/ui', { headers: { cookie }, host: `evil.example:${port}` });
    check('Host fora do loopback (DNS rebinding) → 403', rebind.status === 403, rebind.status);
    check('Host localhost da própria porta vale', (await req('GET', '/token-guard/ui/api/state', { headers: { cookie }, host: `localhost:${port}` })).status === 200);

    console.log('\n  [estado e escrita]');
    fs.rmSync(cfgFile, { force: true });
    const st = JSON.parse((await req('GET', '/token-guard/ui/api/state', { headers: { cookie } })).body);
    check('estado traz versão, porta, regras, IDEs e catálogo humano',
      st.version && st.port === port && st.state === 'on' && st.config.mode === 'block' && st.catalog.rules.length === 7 && st.catalog.targets.length === 5, Object.keys(st));
    check('as 7 regras estão ligadas por padrão', Object.values(st.config.rules).every(Boolean) && Object.keys(st.config.rules).length === 7);

    console.log('\n  [custo por repositório]');
    const repoA = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ui-repo-'));
    fs.mkdirSync(path.join(repoA, '.git'));
    fs.mkdirSync(path.join(repoA, 'sub'));
    const projDir = path.join(os.homedir(), '.claude', 'projects', 'p');
    fs.mkdirSync(projDir, { recursive: true });
    const line = (sid, cwd, id, input) => JSON.stringify({ type: 'assistant', sessionId: sid, cwd, timestamp: new Date().toISOString(),
      message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: input, output_tokens: 0 } } });
    fs.writeFileSync(path.join(projDir, 'a1.jsonl'), line('a1', repoA, 'm1', 1000000));
    fs.writeFileSync(path.join(projDir, 'a2.jsonl'), line('a2', path.join(repoA, 'sub'), 'm2', 500000));
    fs.writeFileSync(path.join(projDir, 'b1.jsonl'), line('b1', os.tmpdir(), 'm3', 250000));
    check('custo sem sessão → 401', (await req('GET', '/token-guard/ui/api/cost')).status === 401);
    const badSince = await req('GET', '/token-guard/ui/api/cost?since=ontem', { headers: { cookie } });
    check('janela inválida → 400 com a causa', badSince.status === 400 && /since inválido/.test(badSince.body), badSince.body);
    const costRes = await req('GET', '/token-guard/ui/api/cost?since=1d', { headers: { cookie } });
    const cost = costRes.status === 200 ? JSON.parse(costRes.body) : {};
    const top = (cost.repos || [])[0] || {};
    check('custo agrupa as sessões pela raiz do repositório (raiz e subpasta somam juntas)',
      cost.ok === true && top.root === repoA && top.sessions === 2 && top.calls === 2 && Math.abs(top.usd - 3) < 1e-9, costRes.body);
    check('custo traz o total, a janela, a fonte dos preços e a marca de aproximado',
      cost.total && cost.total.sessions === 3 && Math.abs(cost.total.usd - 3.5) < 1e-9 && cost.since === '1d' &&
      cost.prices.source === 'tabela padrão' && cost.approximate === true && cost.repos.length === 2, costRes.body);
    const cached = JSON.parse((await req('GET', '/token-guard/ui/api/cost?since=1d', { headers: { cookie } })).body);
    check('segunda leitura dentro de 60 s vem do cache (mesmo generatedAt)', cached.generatedAt === cost.generatedAt);

    const noCsrf = await req('POST', '/token-guard/ui/api/config', { headers: { cookie }, body: { mode: 'off' } });
    check('escrever sem o token anti-CSRF → 403 e nada muda', noCsrf.status === 403 && !fs.existsSync(cfgFile), noCsrf);
    const badOrigin = await req('POST', '/token-guard/ui/api/config', { headers: { cookie, 'x-tg-csrf': csrf, origin: 'http://evil.example' }, body: { mode: 'off' } });
    check('escrever com Origin estranha → 403', badOrigin.status === 403 && !fs.existsSync(cfgFile));
    const noCookie = await req('POST', '/token-guard/ui/api/config', { headers: { 'x-tg-csrf': csrf }, body: { mode: 'off' } });
    check('escrever sem cookie → 401', noCookie.status === 401);
    const invalid = await req('POST', '/token-guard/ui/api/config', { headers: { cookie, 'x-tg-csrf': csrf }, body: { targets: { zed: 'off' } } });
    check('pedido inválido → 400 com a causa (fail-loud)', invalid.status === 400 && /IDE desconhecido: zed/.test(invalid.body), invalid.body);

    console.log('\n  [empurrado por SSE: tela e ícone]');
    const screen = sse('/token-guard/ui/stream', { cookie });
    const first = await screen.waitFor((e) => e.event === 'snapshot');
    check('a tela recebe o estado assim que conecta', first && first.data.state === 'on');
    const trayNoTok = await req('GET', '/token-guard/stream');
    check('fluxo do ícone sem token → 401', trayNoTok.status === 401);
    const tray = sse('/token-guard/stream', { 'x-token-guard': token });
    const t0 = await tray.waitFor((e) => e.event === 'tray');
    check('o ícone recebe estado, rótulo e contagem do dia', t0 && t0.data.state === 'on' && t0.data.label === 'Protegendo' && t0.data.blocksToday === 0 && t0.data.show === true, t0);

    const nBefore = screen.events.length;
    const save = await req('POST', '/token-guard/ui/api/config', { headers: { cookie, 'x-tg-csrf': csrf }, body: { targets: { claude: 'off' }, rules: { scout: false } } });
    check('escrita com sessão + anti-CSRF → 200 e grava no arquivo do usuário', save.status === 200 && JSON.parse(fs.readFileSync(cfgFile, 'utf8')).targets.claude === 'off', save.body);
    const pushed = await screen.waitFor((e) => e.event === 'snapshot' && screen.events.indexOf(e) >= nBefore && e.data.config.targets.claude === 'off');
    check('a mudança chega à tela por evento (sem ela perguntar)', pushed && pushed.data.config.rules.scout === false && pushed.data.state === 'partial', pushed && pushed.data.state);
    const trayPartial = await tray.waitFor((e) => e.event === 'tray' && e.data.state === 'partial');
    check('o ícone vira "em parte" (âmbar) na hora', trayPartial && trayPartial.data.label === 'Protegendo em parte');

    const denyBody = { tool_name: 'Read', tool_input: { file_path: BIG }, cwd: TMP, session_id: 'ui-t' };
    const postJson = (route, body) => req('POST', route, { headers: { 'x-token-guard': token }, body });
    const passed = await postJson('/token-guard/pre', denyBody);
    check('com o claude desligado pela tela, o hook http do Claude Code libera', passed.status === 200 && passed.body === '{}', passed.body);
    await req('POST', '/token-guard/ui/api/config', { headers: { cookie, 'x-tg-csrf': csrf }, body: { targets: { claude: null } } });
    const denied = await postJson('/token-guard/pre', denyBody);
    check('voltando a seguir o geral, o mesmo hook volta a barrar', /"deny"/.test(denied.body), denied.body);
    const ev = await screen.waitFor((e) => e.event === 'snapshot' && e.data.stats.today.blocks >= 1);
    check('o bloqueio aparece na tela como evento (IDE, regra, ferramenta)', ev && ev.data.stats.recent[0].rule === 'blindRead' && ev.data.stats.recent[0].target === 'claude' && ev.data.stats.recent[0].tool === 'Read', ev && ev.data.stats.recent[0]);
    const trayCount = await tray.waitFor((e) => e.event === 'tray' && e.data.blocksToday >= 1);
    check('a contagem do dia chega ao ícone', Boolean(trayCount));

    await postJson('/token-guard/post', { tool_name: 'Grep', tool_input: {}, tool_response: 'g'.repeat(90000), cwd: TMP, session_id: 'ui-t' });
    const trim = await screen.waitFor((e) => e.event === 'snapshot' && e.data.stats.total.tokensSaved > 10000);
    check('o corte do bigResult entra nos tokens poupados (medidos)', Boolean(trim), trim && trim.data.stats.total);
    const sv = trim && trim.data.savings;
    check('a tela recebe os tokens poupados em US$, marcados como aproximados, com a conta (modelo, preço de entrada, fonte)',
      sv && sv.approximate === true && sv.model === 'opus-5-5' && sv.inPerMtok === 4 && sv.source === 'tabela padrão' &&
      Math.abs(sv.total - (trim.data.stats.total.tokensSaved * 4) / 1e6) < 1e-9 && Math.abs(sv.today - (trim.data.stats.today.tokensSaved * 4) / 1e6) < 1e-9, sv);

    await req('POST', '/token-guard/ui/api/config', { headers: { cookie, 'x-tg-csrf': csrf }, body: { mode: 'off' } });
    const trayOff = await tray.waitFor((e) => e.event === 'tray' && e.data.state === 'off');
    check('geral desligado: o ícone fica vermelho', trayOff && trayOff.data.label === 'Desligado');
    const offDeny = await postJson('/token-guard/pre', denyBody);
    check('geral desligado pela tela: nada é barrado em nenhum IDE', offDeny.body === '{}', offDeny.body);
    await req('POST', '/token-guard/ui/api/config', { headers: { cookie, 'x-tg-csrf': csrf }, body: { mode: 'block', ui: { tray: false } } });
    const hide = await tray.waitFor((e) => e.event === 'tray' && e.data.show === false);
    check('"ícone na bandeja" desligado na tela: o ícone é avisado para fechar', Boolean(hide));

    // edição por fora (CLI/editor) também é empurrada: o daemon observa o arquivo
    const n2 = screen.events.length;
    CE.save({ ui: { tray: true }, rules: { scout: true } });
    const outside = await screen.waitFor((e) => screen.events.indexOf(e) >= n2 && e.data.config.rules.scout === true && e.data.config.tray === true);
    check('mudança feita por fora do daemon chega à tela', Boolean(outside));

    // bloqueio registrado por OUTRO processo (hook sem daemon, Cursor, Copilot): o daemon observa o arquivo
    const n3 = screen.events.length;
    require('../lib/events.cjs').recordDeny({ rule: 'shellDump' }, 'cursor', { tool_name: 'Bash', tool_input: { command: 'ls -R /x' } });
    const ext = await screen.waitFor((e) => screen.events.indexOf(e) >= n3 && e.data.stats.recent[0] && e.data.stats.recent[0].target === 'cursor');
    check('bloqueio gravado por outro processo chega à tela sem ela perguntar', Boolean(ext && ext.data.stats.recent[0].detail === 'ls -R /x'));
    check('o estado informa a plataforma (a tela desabilita o ícone fora do Windows)', first.data.platform === process.platform);

    screen.close();
    tray.close();

    console.log('\n  [token-guard setup]');
    // O daemon do teste sai e o `setup` precisa subir outro (e criar o token, que removemos).
    try { child.kill(); } catch { /* já saiu */ }
    await new Promise((r) => setTimeout(r, 400));
    fs.rmSync(tokenFile, { force: true });
    const cli = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.cjs'), 'setup', '--no-open'], {
      env: { ...process.env, TOKEN_GUARD_SID: `ui-setup-${process.pid}`, TOKEN_GUARD_HTTP_PORT: String(port), TOKEN_GUARD_TRAY: 'off' }, encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    const url = /(http:\/\/127\.0\.0\.1:\d+\/token-guard\/ui\?ticket=[\w-]+)/.exec(cli.stdout || '')?.[1];
    check('setup --no-open sai 0, cria o token, sobe o daemon e imprime a URL de uso único',
      cli.status === 0 && Boolean(url) && fs.existsSync(tokenFile) && /criei o token/.test(cli.stdout) && /subi/.test(cli.stdout), { out: cli.stdout, err: cli.stderr });
    if (url) {
      const open = await req('GET', url.replace(/^http:\/\/127\.0\.0\.1:\d+/, ''));
      check('a URL do setup abre a tela (troca por cookie)', open.status === 302 && Boolean(cookieOf(open)));
    }
    const again = spawnSync(process.execPath, [path.join(__dirname, '..', 'cli.cjs'), 'setup', '--no-open'], {
      env: { ...process.env, TOKEN_GUARD_SID: `ui-setup-${process.pid}`, TOKEN_GUARD_HTTP_PORT: String(port), TOKEN_GUARD_TRAY: 'off' }, encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    check('rodar setup de novo reaproveita o daemon (nada reiniciado, token mantido)', again.status === 0 && !/subi|reiniciei|criei/.test(again.stdout), again.stdout);
  } finally {
    try { child.kill(); } catch { /* já saiu */ }
    // daemon subido pelo `setup`: o SID dele é próprio; pede para sair pelo pipe do SID
    await DC.shutdownDaemon(endpointFor(`ui-setup-${process.pid}`));
  }

  console.log(`\n  ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
