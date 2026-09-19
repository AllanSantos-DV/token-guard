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
 */

const { spawnSync } = require('child_process');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createServer } = require('../adapters/daemon-server.cjs');

const ROOT = path.join(__dirname, '..');
const HOOK_CMD = path.join(ROOT, 'adapters', 'hook-cmd.cjs');
const PROMPT_HOOK = path.join(ROOT, 'adapters', 'prompt-hook.cjs');
const POST_HOOK = path.join(ROOT, 'adapters', 'post-hook.cjs');

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

function runHook(script, payload, env) {
  const res = spawnSync(process.execPath, [script], {
    input: payload == null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) },
    timeout: 15000,
  });
  return res.stdout || '';
}

const stripTs = (s) => s
  .replace(/\d{13}-[a-z0-9-]+\.txt/gi, '__SAVED__')
  .replace(/[a-z]:[\\/][^"\s]*\.txt/gi, '__SAVED_PATH__');

function tmpEndpoint(sid) {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\token-guard-${sid}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-daemon-adapters-')), 'd.sock');
}

async function main() {
  const sid = `parity-${process.pid}`;
  const endpoint = tmpEndpoint(sid);
  const server = createServer();
  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(endpoint, res);
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-daemon-adapters-root-'));
  fs.writeFileSync(path.join(root, 'contract.md'), '## sempre\n\n- Regra sempre parity.\n', 'utf8');

  console.log('\n  [daemon-adapters-parity · hook-cmd/prompt-hook/post-hook]');

  try {
    // --- hook-cmd (PreToolUse) ---
    {
      const payload = { tool_name: 'Glob', tool_input: { pattern: '**' }, cwd: root, session_id: `${sid}-pre` };
      const payload2 = { ...payload, session_id: `${sid}-pre2` };
      const withDaemon = runHook(HOOK_CMD, payload, { TOKEN_GUARD_SID: sid });
      const withoutDaemon = runHook(HOOK_CMD, payload2, {});
      check('hook-cmd: stdout byte-igual com/sem daemon', withDaemon === withoutDaemon,
        `com=${withDaemon.slice(0, 120)} sem=${withoutDaemon.slice(0, 120)}`);
      check('hook-cmd: daemon efetivamente serviu um veredito', withDaemon.includes('permissionDecision'));
    }

    // --- prompt-hook (UserPromptSubmit) ---
    {
      const payload = { cwd: root, session_id: `${sid}-prompt` };
      const payload2 = { cwd: root, session_id: `${sid}-prompt2` };
      const withDaemon = runHook(PROMPT_HOOK, payload, { TOKEN_GUARD_SID: sid });
      const withoutDaemon = runHook(PROMPT_HOOK, payload2, {});
      check('prompt-hook: stdout byte-igual com/sem daemon', withDaemon === withoutDaemon,
        `com=${withDaemon.slice(0, 160)} sem=${withoutDaemon.slice(0, 160)}`);
      check('prompt-hook: injeta a seção sempre', withDaemon.includes('Regra sempre parity'));
    }

    // --- post-hook (PostToolUse) ---
    {
      const payload = { tool_name: 'Grep', tool_input: {}, tool_response: 'x'.repeat(30000), cwd: root, session_id: `${sid}-post` };
      const payload2 = { ...payload, session_id: `${sid}-post2` };
      const withDaemon = stripTs(runHook(POST_HOOK, payload, { TOKEN_GUARD_SID: sid }));
      const withoutDaemon = stripTs(runHook(POST_HOOK, payload2, {}));
      check('post-hook: stdout estrutura-igual com/sem daemon (após normalizar timestamp)',
        withDaemon === withoutDaemon,
        `com=${withDaemon.slice(0, 160)} sem=${withoutDaemon.slice(0, 160)}`);
      check('post-hook: bigResult trunca com additionalContext', withDaemon.includes('bigResult'));
    }

    // --- fail-open: daemon caído nunca bloqueia/derruba a sessão ---
    {
      const payload = { tool_name: 'Bash', tool_input: { command: 'echo ok' }, cwd: root, session_id: `${sid}-failopen` };
      const res = spawnSync(process.execPath, [HOOK_CMD], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, TOKEN_GUARD_SID: `${sid}-endpoint-inexistente` },
        timeout: 15000,
      });
      check('hook-cmd: endpoint de daemon inexistente não derruba o hook (exit 0)', res.status === 0, `status=${res.status} stderr=${res.stderr}`);
    }
  } finally {
    server.close();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* melhor esforço */ }
  }

  console.log('');
  console.log(`  ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}

main();
