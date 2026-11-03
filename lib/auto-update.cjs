'use strict';
/**
 * auto-update.cjs — atualiza a instalação de máquina quando sai versão nova.
 *
 * Disparado pelo SessionStart do Claude Code num processo destacado e oculto
 * (a sessão não espera rede nem npm). Reaproveita a checagem de versão do
 * `status` (lib/update-check.cjs, cache de 24 h) e, havendo versão nova,
 * reexecuta o instalador DA VERSÃO NOVA com os mesmos alvos da última
 * instalação (~/.token-guard/install-state.json, gravado pelo install.cjs):
 * runtime, hooks/MCP do Claude Code e demais alvos saem atualizados juntos.
 *
 * Fail-loud: o resultado (ok ou falha, com o log) fica em
 * ~/.token-guard/auto-update.json e o próximo SessionStart o mostra ao
 * usuário (systemMessage) uma vez. Desliga com TOKEN_GUARD_AUTO_UPDATE=off
 * (ou TOKEN_GUARD_UPDATE_CHECK=off, que já desliga a checagem).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PKG = '@allansantos-dev/token-guard';
const MACHINE_TARGETS = ['copilot', 'claude', 'codex', 'cursor', 'mcp'];
const RETRY_AFTER_FAILURE_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 15 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

const dir = () => path.join(os.homedir(), '.token-guard');
const installStatePath = () => path.join(dir(), 'install-state.json');
const resultPath = () => path.join(dir(), 'auto-update.json');
const logPath = () => path.join(dir(), 'auto-update.log');
const lockPath = () => path.join(dir(), 'auto-update.lock');

function enabled() {
  return process.env.TOKEN_GUARD_AUTO_UPDATE !== 'off' && process.env.TOKEN_GUARD_UPDATE_CHECK !== 'off';
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

const { writeJsonAtomic: writeJson } = require('../adapters/daemon-http.cjs');

/** Alvos de máquina da última instalação; null = nunca instalado pelo install.cjs. */
function readInstallState() {
  const s = readJson(installStatePath());
  const targets = s && Array.isArray(s.targets) ? s.targets.filter((t) => MACHINE_TARGETS.includes(t)) : [];
  return targets.length ? { targets, commandHooks: s.commandHooks === true } : null;
}

/** Chamado pelo install.cjs: soma os alvos de máquina desta execução aos já registrados. */
function recordInstall({ targets, commandHooks, version }) {
  const prev = readInstallState() || { targets: [], commandHooks: false };
  const machine = targets.filter((t) => MACHINE_TARGETS.includes(t));
  if (!machine.length) return;
  writeJson(installStatePath(), {
    targets: MACHINE_TARGETS.filter((t) => prev.targets.includes(t) || machine.includes(t)),
    commandHooks: machine.includes('claude') ? Boolean(commandHooks) : prev.commandHooks,
    version,
  });
}

/** Comando do instalador da versão nova. Só entra versão semver e alvo conhecido (vai a um shell no Windows). */
function buildCommand(version, state) {
  const { SEMVER_RE } = require('./update-check.cjs');
  if (!SEMVER_RE.test(String(version))) throw new Error(`versão inválida: ${version}`);
  if (!state || !state.targets.length || state.targets.some((t) => !MACHINE_TARGETS.includes(t))) {
    throw new Error(`alvos inválidos: ${JSON.stringify(state && state.targets)}`);
  }
  const args = ['--yes', `${PKG}@${version}`, 'init', '--target', state.targets.join(',')];
  if (state.commandHooks) args.push('--command-hooks');
  return { cmd: 'npx', args };
}

/**
 * Comando para atualizar à mão: os mesmos alvos da última instalação, porque `init` sem `--target`
 * cai no alvo `repo` e copiaria `.github/` para a pasta atual em vez de atualizar a máquina.
 */
function manualCommand(version, fallbackTarget) {
  const state = readInstallState();
  const target = state ? state.targets.join(',') + (state.commandHooks ? ' --command-hooks' : '') : fallbackTarget;
  return `npx --yes ${PKG}@${version} init --target ${target}`;
}

/** Não insiste na mesma versão que acabou de falhar (no máximo uma tentativa por dia). */
function shouldAttempt(last, latest, now) {
  if (!last || last.to !== latest || last.status !== 'failed') return true;
  return now - (last.at || 0) >= RETRY_AFTER_FAILURE_MS;
}

/** Mensagem do último resultado ainda não mostrado ao usuário (marca como mostrado). */
function takeReport() {
  const r = readJson(resultPath());
  if (!r || r.reported) return null;
  try { writeJson(resultPath(), { ...r, reported: true }); } catch { /* sem marcar, repete no próximo início — melhor que calar */ }
  if (r.status === 'ok') return `token-guard atualizado automaticamente: ${r.from} → ${r.to} (vale nas próximas sessões). Novidades: ${require('./update-check.cjs').SITE_URL}`;
  return `token-guard: o auto-update ${r.from} → ${r.to} FALHOU: ${r.error}. ` +
    `Log: ${logPath()}. Atualize à mão: npx ${(r.command || []).join(' ')}`;
}

const updateCachePath = () => path.join(dir(), 'update-check.json');

/**
 * Aviso de versão nova no npm, lido só do cache (sem rede: roda no hook síncrono
 * do SessionStart). O cache é renovado pelo processo destacado do auto-update.
 * Não depende de o auto-update estar ligado: com ele desligado, é o único sinal.
 */
function availableNotice(localVersion) {
  if (process.env.TOKEN_GUARD_UPDATE_CHECK === 'off') return null;
  const UC = require('./update-check.cjs');
  const cache = UC.REAL_DEPS.readCache(updateCachePath());
  if (!cache || UC.compareVersions(localVersion, cache.latestVersion) >= 0) return null;
  const manual = manualCommand(cache.latestVersion, 'claude');
  let how;
  if (!enabled()) how = `auto-update desligado — atualize à mão: ${manual}`;
  else if (!readInstallState()) how = `esta cópia não tem registro de instalação, então não se atualiza sozinha — rode uma vez: ${manual}`;
  else how = 'atualizando em segundo plano (vale nas próximas sessões).';
  return `token-guard ${cache.latestVersion} disponível no npm (você usa ${localVersion}): ${how} Novidades: ${UC.SITE_URL}`;
}

function acquireLock(now) {
  fs.mkdirSync(dir(), { recursive: true });
  try {
    fs.writeFileSync(lockPath(), String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    try {
      if (now - fs.statSync(lockPath()).mtimeMs < LOCK_STALE_MS) return false;
      fs.rmSync(lockPath(), { force: true });
      fs.writeFileSync(lockPath(), String(process.pid), { flag: 'wx' });
      return true;
    } catch { return false; }
  }
}

/**
 * Pergunta ao próprio npm onde fica o cache, do mesmo diretório em que o instalador roda: assim valem
 * `cache=` do .npmrc do usuário, do global e do embutido, que um palpite por plataforma não enxerga.
 * @returns {string|null} caminho absoluto, ou null se o npm não respondeu
 */
function askNpmCache() {
  try {
    // No Windows o npm é npm.cmd e só roda via shell; comando numa string só, sem args (DEP0190).
    const opts = { cwd: os.homedir(), encoding: 'utf8', timeout: 20000, windowsHide: true };
    const r = process.platform === 'win32'
      ? spawnSync('npm config get cache', { ...opts, shell: true })
      : spawnSync('npm', ['config', 'get', 'cache'], opts);
    const out = r.status === 0 ? String(r.stdout || '').trim().split(/\r?\n/).pop().trim() : '';
    return out && path.isAbsolute(out) ? out : null;
  } catch { return null; }
}

/** Pasta de cache do npm (onde o npx guarda cada versão baixada em _npx/<hash>). */
function npmCacheDir(ask = askNpmCache) {
  const fromEnv = process.env.npm_config_cache || process.env.NPM_CONFIG_CACHE;
  if (fromEnv) return fromEnv;
  const fromNpm = ask();
  if (fromNpm) return fromNpm;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'npm-cache');
  return path.join(os.homedir(), '.npm');
}

/**
 * Cada `npx --yes pkg@X.Y.Z` deixa uma pasta própria em _npx/ que o npm nunca limpa: sem isto, cada
 * auto-update acumula mais uma cópia do pacote. Remove as pastas do token-guard de outras versões.
 * Só toca pasta cujo único pacote pedido é o nosso (cache de outro pacote nunca é apagado) e nunca a
 * versão `keepVersion`. Melhor esforço: erro aqui não invalida a atualização já feita.
 * @returns {string[]} pastas removidas
 */
function pruneOldNpxVersions(keepVersion, cacheDir = npmCacheDir()) {
  const root = path.join(cacheDir, '_npx');
  const removed = [];
  let entries;
  try { entries = fs.readdirSync(root); } catch { return removed; }
  for (const name of entries) {
    const base = path.join(root, name);
    try {
      const pj = readJson(path.join(base, 'package.json'));
      const wanted = pj && pj._npx && Array.isArray(pj._npx.packages) ? pj._npx.packages : [];
      // `pkg@X` (versão fixa ou tag) e `pkg` sem versão: os dois são pedidos só do token-guard.
      if (wanted.length !== 1 || !(wanted[0] === PKG || wanted[0].startsWith(`${PKG}@`))) continue;
      const installed = readJson(path.join(base, 'node_modules', ...PKG.split('/'), 'package.json'));
      if (installed && installed.version === keepVersion) continue;
      fs.rmSync(base, { recursive: true, force: true });
      removed.push(base);
    } catch { /* pasta em uso ou sem permissão: fica para a próxima atualização */ }
  }
  return removed;
}

/** Chave do cacache para o tarball do nosso pacote: o grupo 1 é a versão. */
const TARBALL_KEY = /\/@allansantos-dev\/token-guard\/-\/token-guard-(\d[^/]*?)\.tgz$/;

/** Caminho do conteúdo de uma integridade `sha512-<base64>` no cacache (content-v2). */
function cacacheContentPath(cacheDir, integrity) {
  const m = /^sha512-([A-Za-z0-9+/=]+)$/.exec(String(integrity || ''));
  if (!m) return null;
  const hex = Buffer.from(m[1], 'base64').toString('hex');
  return hex.length > 4 ? path.join(cacheDir, '_cacache', 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4)) : null;
}

/**
 * O npx também deixa em _cacache/ o tarball de cada versão baixada (centenas de KB por versão). Remove
 * os tarballs do token-guard de outras versões: o conteúdo e a linha do índice que aponta para ele.
 * Só toca entrada cuja chave é o tarball do nosso pacote; o resto do cache nunca é apagado.
 * @returns {string[]} conteúdos removidos
 */
function pruneOldCacache(keepVersion, cacheDir = npmCacheDir()) {
  const removed = [];
  const index = path.join(cacheDir, '_cacache', 'index-v5');
  const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
  for (const a of ls(index)) {
    for (const b of ls(path.join(index, a))) {
      for (const name of ls(path.join(index, a, b))) {
        const file = path.join(index, a, b, name);
        try {
          const raw = fs.readFileSync(file, 'utf8');
          if (!raw.includes(PKG)) continue;
          let dropped = false;
          const kept = [];
          for (const line of raw.split('\n')) {
            const tab = line.indexOf('\t');
            let entry = null;
            if (tab > 0) { try { entry = JSON.parse(line.slice(tab + 1)); } catch { /* linha ilegível: fica como está */ } }
            const m = entry && typeof entry.key === 'string' ? TARBALL_KEY.exec(entry.key) : null;
            if (!m || m[1] === keepVersion) { if (line) kept.push(line); continue; }
            const content = cacacheContentPath(cacheDir, entry.integrity);
            if (content) {
              // Conteúdo que não saiu (em uso) mantém a linha: sem ela o tarball viraria órfão que o npm não enxerga.
              try { fs.rmSync(content, { force: true }); removed.push(content); } catch { kept.push(line); continue; }
            }
            dropped = true;
          }
          if (!dropped) continue;
          // O npm pode ter gravado neste bucket durante a poda: se mudou, deixa para a próxima atualização.
          if (fs.readFileSync(file, 'utf8') !== raw) continue;
          if (kept.length) fs.writeFileSync(file, '\n' + kept.join('\n'), 'utf8'); else fs.rmSync(file, { force: true });
        } catch { /* arquivo em uso ou sem permissão: fica para a próxima atualização */ }
      }
    }
  }
  return removed;
}

const REAL_DEPS = {
  pruneOldVersions: (keepVersion) => {
    const cacheDir = npmCacheDir();
    pruneOldNpxVersions(keepVersion, cacheDir);
    pruneOldCacache(keepVersion, cacheDir);
  },
  checkForUpdate: (localVersion) => require('./update-check.cjs').checkForUpdate({
    localVersion, cacheFile: path.join(dir(), 'update-check.json'),
  }),
  runInstaller: ({ cmd, args }) => spawnSync(cmd, args, {
    cwd: os.homedir(),
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
    windowsHide: true,
    // npx é npx.cmd no Windows: desde o Node 18.20/20.12 um .cmd só roda via shell.
    shell: process.platform === 'win32',
  }),
  now: () => Date.now(),
};

/**
 * Uma rodada: checa, instala se preciso, registra o resultado.
 * @returns {Promise<{status:'skipped', reason:string} | {status:'ok'|'failed', from:string, to:string}>}
 */
async function run(depsOverride) {
  const deps = { ...REAL_DEPS, ...depsOverride };
  if (!enabled()) {
    // Só o auto-update desligado: segue checando, para o aviso de versão nova continuar valendo.
    if (process.env.TOKEN_GUARD_UPDATE_CHECK !== 'off') {
      try { await deps.checkForUpdate(require('../package.json').version); } catch { /* sem rede: o aviso usa o cache anterior */ }
    }
    return { status: 'skipped', reason: 'desligado' };
  }
  const localVersion = require('../package.json').version;
  const state = readInstallState();
  if (!state) {
    // Sem registro de instalação não há o que reinstalar, mas o aviso de versão nova precisa do cache.
    try { await deps.checkForUpdate(localVersion); } catch { /* sem rede: o aviso usa o cache anterior */ }
    return { status: 'skipped', reason: 'sem install-state' };
  }
  const check = await deps.checkForUpdate(localVersion);
  if (!check || !check.checked || !check.updateAvailable) return { status: 'skipped', reason: 'em dia ou offline' };
  const now = deps.now();
  const last = readJson(resultPath());
  if (last && last.status === 'ok' && last.to === check.latestVersion) {
    // Instalou "com sucesso" e a versão local não mudou: reinstalar a cada sessão esconderia isso.
    const result = { ...last, status: 'failed', at: now, reported: false, error: `instalou ${last.to}, mas a versão em uso continua ${localVersion}` };
    writeJson(resultPath(), result);
    return result;
  }
  if (!shouldAttempt(last, check.latestVersion, now)) return { status: 'skipped', reason: 'falhou há pouco' };
  if (!acquireLock(now)) return { status: 'skipped', reason: 'outra sessão já está atualizando' };
  try {
    const command = buildCommand(check.latestVersion, state);
    const r = deps.runInstaller(command);
    const ok = r && r.status === 0 && !r.error;
    try { fs.writeFileSync(logPath(), `$ ${command.cmd} ${command.args.join(' ')}\n${r.stdout || ''}\n${r.stderr || ''}`, 'utf8'); } catch { /* o resultado abaixo ainda registra */ }
    // Só depois de instalar com sucesso: instalação que falhou nunca apaga o que funciona.
    if (ok) { try { deps.pruneOldVersions(check.latestVersion); } catch { /* limpeza é melhor esforço */ } }
    const result = {
      status: ok ? 'ok' : 'failed',
      from: localVersion,
      to: check.latestVersion,
      at: now,
      command: command.args,
      error: ok ? undefined : (r && r.error ? r.error.message : `instalador saiu com ${r && r.status}`),
    };
    writeJson(resultPath(), result);
    return result;
  } finally {
    try { fs.rmSync(lockPath(), { force: true }); } catch { /* lock velho expira sozinho */ }
  }
}

if (require.main === module) {
  run().catch((err) => {
    try { writeJson(resultPath(), { status: 'failed', from: require('../package.json').version, to: '?', at: Date.now(), error: err.message }); } catch { /* nada a fazer */ }
  });
}

module.exports = {
  enabled, readInstallState, recordInstall, buildCommand, manualCommand, shouldAttempt, takeReport, availableNotice, run, pruneOldNpxVersions, pruneOldCacache, npmCacheDir,
  installStatePath, resultPath, logPath, lockPath, MACHINE_TARGETS,
};
