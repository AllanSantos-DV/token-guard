'use strict';
/**
 * daemon-adapters-parity.test.cjs — paridade dos 3 hooks migrados (F3) contra
 * um daemon real de pé, via spawn (processo real, TOKEN_GUARD_SID apontando
 * pro endpoint de teste) comparado ao mesmo hook rodando sem daemon nenhum.
 *
 * DECISION (P2): o plano original apontava para estender test/adapters.test.cjs,
 * test/adapters.prompt.test.cjs e test/adapters.post.test.cjs — mas na prática
 * adapters.test.cjs cobre cursor-hook.cjs/mcp-server.cjs (adapters diferentes),
 * e hook-cmd.cjs não tem nenhuma suíte dedicada hoje. Consolidado aqui, único
 * arquivo, cobrindo os 3 hooks migrados (hook-cmd, prompt-hook, post-hook)
 * contra o daemon real — sem tocar nos arquivos de teste de outros adapters.
 *
 * TOPOLOGIA (fix do hang cross-process, 2026-09-20):
 * O daemon NÃO pode ser `createServer()` in-process + `spawnSync` cliente —
 * `spawnSync` bloqueia o event loop do pai, então o `net.Server` in-process
 * nunca recebe o evento `connection` (reproduzido: `CLIENT: connected` mas
 * `SERVER: got connection` nunca dispara; timeout em 4s). Topologia de
 * produção é daemon `detached` (sibling), cliente `spawnSync`/`spawn` — o
 * pai não precisa bombear o loop do servidor. Este teste replica isso:
 * sobe um daemon `detached` real via `spawn` + `unref`, faz polling com
 * `net.connect` até ficar pronto, depois roda os hooks via `spawn` async
 * (não-bloqueante). Com daemon detached, até `spawnSync` funcionaria
 * (provado empiricamente), mas `spawn` async é usado por uniformidade.
 */

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { defaultLockPath } = require('../adapters/daemon-server.cjs');

const ROOT = path.join(__dirname, '..');
const HOOK_CMD = path.join(ROOT, 'adapters', 'hook-cmd.cjs');
const PROMPT_HOOK = path.join(ROOT, 'adapters', 'prompt-hook.cjs');
const POST_HOOK = path.join(ROOT, 'adapters', 'post-hook.cjs');
const DAEMON_SERVER = path.join(ROOT, 'adapters', 'daemon-server.cjs');

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

function runHookAsync(script, payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    let settled = false;
    const done = (status) => {
      if (settled) return;
      settled = true;
      resolve({ stdout: stdout || '', stderr: stderr || '', status });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
    setTimeout(() => {
      try { child.kill(); } catch { /* noop */ }
      done(null);
    }, 15000).unref?.();
    try {
      if (payload != null) child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch { /* noop */ }
  });
}

const stripTs = (s) => s
  .replace(/\d{13}-[a-z0-9-]+\.txt/gi, '__SAVED__')
  .replace(/[a-z]:[\\/][^"\s]*\.txt/gi, '__SAVED_PATH__');

async function spawnDetachedDaemon(endpoint, env) {
  const child = spawn(process.execPath, [DAEMON_SERVER, endpoint], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, ...(env || {}) },
  });
  child.on('error', () => { /* best-effort */ });
  child.unref();
  // polling até o daemon aceitar conexão (mesmo loop de daemon-faulttolerance)
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const s = net.connect(endpoint);
      s.once('connect', () => { s.destroy(); res(true); });
      s.once('error', () => res(false));
    });
    if (ok) return child;
    await new Promise((r) => setTimeout(r, 50));
  }
  try { process.kill(child.pid); } catch { /* noop */ }
  throw new Error(`daemon não ficou pronto em ${endpoint}`);
}

async function main() {
  const sid = `parity-${process.pid}`;
  // POSIX: isola via XDG_RUNTIME_DIR pra não colidir com daemon do usuário;
  // Windows: named pipe já é isolado por SID.
  let endpoint;
  let daemonEnv = {};
  let tmpBasePosix = null;
  if (process.platform === 'win32') {
    endpoint = `\\\\.\\pipe\\token-guard-${sid}`;
  } else {
    tmpBasePosix = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-daemon-adapters-'));
    daemonEnv = { XDG_RUNTIME_DIR: tmpBasePosix };
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
    endpoint = path.join(tmpBasePosix, `token-guard-${uid}.sock`);
  }

  let daemonChild = null;
  try {
    daemonChild = await spawnDetachedDaemon(endpoint, daemonEnv);
  } catch (e) {
    console.error(`  ✗ falha ao subir daemon detached: ${e.message}`);
    process.exit(1);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-daemon-adapters-root-'));
  fs.writeFileSync(path.join(root, 'contract.md'), '## sempre\n\n- Regra sempre parity.\n', 'utf8');

  console.log('\n  [daemon-adapters-parity · hook-cmd/prompt-hook/post-hook]');

  // env base que os hooks precisam pra convergir no mesmo endpoint do daemon
  const hookEnvBase = process.platform === 'win32'
    ? { TOKEN_GUARD_SID: sid }
    : { XDG_RUNTIME_DIR: tmpBasePosix };

  try {
    // --- hook-cmd (PreToolUse) ---
    {
      const payload = { tool_name: 'Glob', tool_input: { pattern: '**' }, cwd: root, session_id: `${sid}-pre` };
      const payload2 = { ...payload, session_id: `${sid}-pre2` };
      const withDaemon = await runHookAsync(HOOK_CMD, payload, hookEnvBase);
      const withoutDaemon = await runHookAsync(HOOK_CMD, payload2, {});
      check('hook-cmd: stdout byte-igual com/sem daemon', withDaemon.stdout === withoutDaemon.stdout,
        `com=${withDaemon.stdout.slice(0, 120)} sem=${withoutDaemon.stdout.slice(0, 120)}`);
      check('hook-cmd: daemon efetivamente serviu um veredito', withDaemon.stdout.includes('permissionDecision'));
    }

    // --- A2 (backlog): TOKEN_GUARD=off/warn ponta a ponta com daemon real de pé.
    // O daemon é um processo de vida longa com seu próprio env congelado — se
    // a decisão de honrar TOKEN_GUARD=off fosse tomada DENTRO do daemon, ela
    // leria o env do DAEMON (sem TOKEN_GUARD=off), não o do hook que fez a
    // chamada. `hasTokenGuardEnvOverride()` em lib/daemon-client.cjs evita
    // isso: quando o CLIENTE tem TOKEN_GUARD=off/warn no próprio env, ele
    // nunca tenta a RPC — cai direto no `decide()` local, que lê o env
    // correto. Prova: mesmo payload/daemon que gera `deny` na baseline vira
    // `allow` (stdout vazio) só setando TOKEN_GUARD=off no processo do hook,
    // sem precisar derrubar nem reconfigurar o daemon.
    {
      const denyPayload = { tool_name: 'Glob', tool_input: { pattern: '**' }, cwd: root, session_id: `${sid}-off-baseline` };
      const baseline = await runHookAsync(HOOK_CMD, denyPayload, hookEnvBase);
      check('A2 baseline: processo sai sem erro', baseline.status === 0, `status=${baseline.status} stderr=${baseline.stderr}`);
      check('A2 baseline: daemon real nega o payload de broadScan', baseline.stdout.includes('"permissionDecision":"deny"'), baseline.stdout.slice(0, 200));

      const offPayload = { ...denyPayload, session_id: `${sid}-off` };
      const withOff = await runHookAsync(HOOK_CMD, offPayload, { ...hookEnvBase, TOKEN_GUARD: 'off' });
      check('A2: TOKEN_GUARD=off — processo sai sem erro', withOff.status === 0, `status=${withOff.status} stderr=${withOff.stderr}`);
      check('A2: TOKEN_GUARD=off no cliente bypassa o daemon e permite (stdout vazio)', withOff.stdout === '', JSON.stringify(withOff.stdout));

      const warnPayload = { ...denyPayload, session_id: `${sid}-warn` };
      const withWarn = await runHookAsync(HOOK_CMD, warnPayload, { ...hookEnvBase, TOKEN_GUARD: 'warn' });
      check('A2: TOKEN_GUARD=warn — processo sai sem erro', withWarn.status === 0, `status=${withWarn.status} stderr=${withWarn.stderr}`);
      // Asserção positiva e específica (não "não contém deny"): TOKEN_GUARD=warn
      // faz decide() local retornar decision:'ask' (lib/decide.cjs:55-60) — é
      // esse veredito exato que prova que hasTokenGuardEnvOverride() desviou do
      // daemon (que serviria o 'deny' cacheado da baseline), não um efeito
      // colateral de stdout vazio/crash.
      check('A2: TOKEN_GUARD=warn no cliente vira "ask" local (não usa o veredito deny cacheado do daemon)', withWarn.stdout.includes('"permissionDecision":"ask"'), withWarn.stdout.slice(0, 200));
    }

    // --- prompt-hook (UserPromptSubmit) ---
    {
      const payload = { cwd: root, session_id: `${sid}-prompt` };
      const payload2 = { cwd: root, session_id: `${sid}-prompt2` };
      const withDaemon = await runHookAsync(PROMPT_HOOK, payload, hookEnvBase);
      const withoutDaemon = await runHookAsync(PROMPT_HOOK, payload2, {});
      check('prompt-hook: stdout byte-igual com/sem daemon', withDaemon.stdout === withoutDaemon.stdout,
        `com=${withDaemon.stdout.slice(0, 160)} sem=${withoutDaemon.stdout.slice(0, 160)}`);
      check('prompt-hook: injeta a seção sempre', withDaemon.stdout.includes('Regra sempre parity'));
    }

    // --- post-hook (PostToolUse) ---
    {
      const payload = { tool_name: 'Grep', tool_input: {}, tool_response: 'x'.repeat(30000), cwd: root, session_id: `${sid}-post` };
      const payload2 = { ...payload, session_id: `${sid}-post2` };
      const withDaemon = stripTs((await runHookAsync(POST_HOOK, payload, hookEnvBase)).stdout);
      const withoutDaemon = stripTs((await runHookAsync(POST_HOOK, payload2, {})).stdout);
      check('post-hook: stdout estrutura-igual com/sem daemon (após normalizar timestamp)',
        withDaemon === withoutDaemon,
        `com=${withDaemon.slice(0, 160)} sem=${withoutDaemon.slice(0, 160)}`);
      check('post-hook: bigResult trunca com additionalContext', withDaemon.includes('bigResult'));
    }

    // --- fail-open: daemon caído nunca bloqueia/derruba a sessão ---
    {
      const payload = { tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: root, session_id: `${sid}-failopen` };
      const failEnv = process.platform === 'win32'
        ? { TOKEN_GUARD_SID: `${sid}-endpoint-inexistente` }
        : { XDG_RUNTIME_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'tg-failopen-')) };
      const res = await runHookAsync(HOOK_CMD, payload, failEnv);
      check('hook-cmd: endpoint de daemon inexistente não derruba o hook (exit 0)', res.status === 0, `status=${res.status} stderr=${res.stderr}`);
      if (failEnv.XDG_RUNTIME_DIR) { try { fs.rmSync(failEnv.XDG_RUNTIME_DIR, { recursive: true, force: true }); } catch { /* noop */ } }
    }
  } finally {
    if (daemonChild) {
      try { process.kill(daemonChild.pid); } catch { /* noop */ }
      // dá tempo do daemon liberar o handle antes de limpar o lock
      await new Promise((r) => setTimeout(r, 300));
      try { fs.rmSync(defaultLockPath(endpoint), { force: true }); } catch { /* noop */ }
    }
    if (tmpBasePosix) { try { fs.rmSync(tmpBasePosix, { recursive: true, force: true }); } catch { /* noop */ } }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* melhor esforço */ }
  }

  console.log('');
  console.log(`  ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}

main();
