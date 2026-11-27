'use strict';
/**
 * daemon-status.cjs — o daemon e o hook http estão de pé? (A25)
 *
 * Só OBSERVA: não sobe daemon, não reaponta settings. "Hook http não bloqueia"
 * tem causas distintas e cada uma sai com um rótulo próprio: daemon fora do ar,
 * porta ocupada por outro processo, token divergente, settings apontando para
 * outra porta ou sem hook registrado.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { connectOnce } = require('./daemon-client.cjs');
const { PACKAGE_VERSION } = require('../adapters/daemon-server.cjs');
const H = require('../adapters/daemon-http.cjs');

const TG_URL_RE = /^http:\/\/127\.0\.0\.1:(\d+)\/token-guard\//;

/** GET /health com o token do dono. Nunca lança. */
function probeHealth(port, token, timeoutMs = 800) {
  return new Promise((resolve) => {
    if (!port) return resolve({ state: 'down', detail: `nenhuma porta registrada em ${H.endpointPath()}` });
    const req = http.get({
      host: '127.0.0.1', port, path: H.HEALTH, timeout: timeoutMs,
      headers: token ? { 'x-token-guard': token } : {},
    }, (res) => {
      res.resume();
      if (res.statusCode === 200) resolve({ state: 'ok' });
      else if (res.statusCode === 401) resolve({ state: 'token', detail: 'responde, mas recusa o token (outro dono ou token regravado)' });
      else resolve({ state: 'foreign', detail: `HTTP ${res.statusCode} — não é o daemon do token-guard` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ state: 'timeout', detail: 'sem resposta' }); });
    req.on('error', (e) => resolve({ state: 'down', detail: e.code || e.message }));
  });
}

/** Portas dos hooks http do token-guard no settings.json do Claude Code. */
function registeredPorts(settingsFile) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const ports = new Set();
    for (const entries of Object.values((settings && settings.hooks) || {})) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        for (const h of Array.isArray(entry && entry.hooks) ? entry.hooks : []) {
          const m = h && h.type === 'http' && typeof h.url === 'string' ? TG_URL_RE.exec(h.url) : null;
          if (m) ports.add(Number(m[1]));
        }
      }
    }
    return { ports: [...ports] };
  } catch (err) {
    return err.code === 'ENOENT' ? { ports: [] } : { ports: [], error: err.message };
  }
}

/**
 * @returns {Promise<{ipc:{ok:boolean,version?:string}, http:{port:number,state:string,detail?:string},
 *   settings:{ports:number[],error?:string}, verdict:string}>}
 */
async function inspect({ settingsFile = H.claudeSettingsPath() } = {}) {
  const hello = await connectOnce('hello', {}, { timeoutMs: 500 });
  const ipc = hello.ok ? { ok: true, version: hello.result.packageVersion } : { ok: false };
  const port = H.httpPort();
  const httpState = await probeHealth(port, H.readToken());
  const settings = registeredPorts(settingsFile);

  let verdict;
  if (!settings.ports.length) verdict = 'sem hook http registrado em ~/.claude/settings.json (o Claude Code usa o hook de comando, se houver)';
  else if (!port) verdict = `o daemon não registrou a porta do hook http (${H.endpointPath()} ausente): rode init ou reabra a sessão para ele subir`;
  else if (!settings.ports.includes(port)) verdict = `settings aponta para ${settings.ports.join(',')} mas o daemon usa ${port}: reabra a sessão ou rode init`;
  else if (httpState.state !== 'ok') verdict = `hook http registrado na ${port}, mas o daemon não atende (${httpState.state}): conexão recusada = fail-open, nada é barrado`;
  else verdict = 'hook http registrado e respondendo';
  return { ipc, http: { port, ...httpState }, settings, packageVersion: PACKAGE_VERSION, verdict };
}


/**
 * O scout só funciona completo com o hook SubagentStart registrado e o agente em ~/.claude/agents.
 * Diz o que falta; nunca lança.
 * @returns {{hook:boolean, agent:boolean, verdict:string}}
 */
function inspectScout({ settingsFile = H.claudeSettingsPath() } = {}) {
  let hook = false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    hook = (Array.isArray(settings?.hooks?.SubagentStart) ? settings.hooks.SubagentStart : [])
      .some((e) => (Array.isArray(e?.hooks) ? e.hooks : []).some((h) => /token-guard.*subagent-start\.cjs/.test(String(h?.command || ''))));
  } catch { /* settings ausente ou ilegível: hook = false */ }
  const dir = path.join(path.dirname(settingsFile), 'agents');
  const agent = ['scout.agent.md', 'scout.md'].some((f) => fs.existsSync(path.join(dir, f)));
  const missing = [hook ? null : 'hook SubagentStart', agent ? null : 'agente em ~/.claude/agents'].filter(Boolean);
  const verdict = missing.length ? `incompleto: falta ${missing.join(' e ')} (rode init)` : 'hook SubagentStart e agente instalados';
  return { hook, agent, verdict };
}

/**
 * O Codex só passa pelo guard se o hooks.json tem o hook mcp_tool do token-guard E o config.toml tem a tabela do servidor
 * que ele chama. Outro programa que reescreve o config.toml pode tirar a tabela: o hook então aponta para um servidor
 * inexistente e a chamada segue sem guard. Só observa; nunca lança.
 * @param {{codexHome?: string, installed: boolean}} opts `installed`: o Codex está entre os alvos instalados.
 * @returns {{installed:boolean, hook:boolean, server:boolean, port:number|null, trusted:boolean, ok:boolean, verdict:string}}
 */
function inspectCodex({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), installed }) {
  let hook = false;
  let hookError = null;
  let slot = null;
  const hooksFile = path.join(codexHome, 'hooks.json');
  try {
    const pre = JSON.parse(fs.readFileSync(hooksFile, 'utf8'))?.hooks?.PreToolUse;
    (Array.isArray(pre) ? pre : []).forEach((e, i) => (Array.isArray(e?.hooks) ? e.hooks : []).forEach((h, j) => {
      if (slot === null && h?.type === 'mcp_tool' && h?.server === 'token-guard') slot = `${i}:${j}`;
    }));
    hook = slot !== null;
  } catch (err) { if (err.code !== 'ENOENT') hookError = err.message; }

  let server = false;
  let port = null;
  let trusted = false;
  try {
    const toml = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
    const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
    const wanted = slot === null ? null : `${norm(hooksFile)}:pre_tool_use:${slot}`;
    for (const m of toml.matchAll(/^\s*\[hooks\.state\.'([^']+)'\]\s*\r?\n((?:(?!\s*\[).*(?:\r?\n|$))*)/gm)) {
      if (wanted && norm(m[1]) === wanted && /^\s*trusted_hash\s*=/m.test(m[2])) trusted = true;
    }
    const table = /^\s*\[mcp_servers\.(?:"token-guard"|token-guard)\]\s*\r?\n((?:(?!\s*\[).*(?:\r?\n|$))*)/m.exec(toml);
    if (table) {
      server = true;
      const m = /^\s*url\s*=\s*"http:\/\/127\.0\.0\.1:(\d+)\//m.exec(table[1]);
      port = m ? Number(m[1]) : null;
    }
  } catch { /* sem config.toml: server fica false */ }

  if (!installed && !hook) return { installed: false, hook, server, port, trusted, ok: true, verdict: 'Codex não está entre os alvos instalados' };
  let verdict = 'hook e servidor MCP do token-guard registrados e aprovados no Codex';
  if (hookError) verdict = `hooks.json do Codex ilegível (${hookError}): rode init --target codex`;
  else if (!hook) verdict = 'hooks.json do Codex sem o hook do token-guard: rode init --target codex';
  else if (!server) verdict = 'o hook do Codex chama o servidor MCP token-guard, que não está no config.toml (outro programa o reescreveu): rode init --target codex';
  else if (!trusted) verdict = `o Codex não aprovou o hook do token-guard (posição ${slot} sem trusted_hash no config.toml; a aprovação é por posição e muda quando outro programa insere hooks antes): abra o Codex e aprove em /hooks, senão a chamada passa sem guard`;
  return { installed: Boolean(installed), hook, server, port, trusted, ok: !hookError && hook && server && trusted, verdict };
}

/**
 * Resumo para quem só quer saber se o token-guard está valendo: ativo, ou o motivo de não estar.
 * Só conta o que o dono instalou (alvos), para o problema de um alvo ausente não aparecer como falha.
 * @param {{daemon: object, codex: object, targets: string[]|null}} state
 * @returns {{active:boolean, reason:string|null}}
 */
function activity({ daemon, codex, targets }) {
  const installed = Array.isArray(targets) ? targets : [];
  if (!daemon.ipc.ok && daemon.http.state !== 'ok') {
    return { active: false, reason: `daemon fora do ar${daemon.http.detail ? ` (${daemon.http.detail})` : ''}: sobe na próxima chamada de hook ou no início da sessão` };
  }
  if (installed.includes('claude') && daemon.verdict !== 'hook http registrado e respondendo') return { active: false, reason: daemon.verdict };
  if (installed.includes('codex') && codex && !codex.ok) return { active: false, reason: codex.verdict };
  return { active: true, reason: null };
}

module.exports = { inspect, inspectScout, inspectCodex, activity, probeHealth, registeredPorts };
