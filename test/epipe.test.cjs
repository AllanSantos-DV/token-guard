#!/usr/bin/env node
'use strict';
/**
 * epipe.test.cjs — o harness pode fechar o stdout antes de o hook escrever.
 * O hook tem que morrer calmo: exit 0, stderr sem stack, sem exceção não
 * tratada. (Regressão do gate: EPIPE derrubava os hooks novos.)
 *
 * Node puro, spawn async — sync não deixa fechar o pipe no meio.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-epipe-'));
fs.mkdirSync(path.join(TMP, '.token-guard'), { recursive: true });
fs.writeFileSync(path.join(TMP, '.token-guard', 'repo-stats.json'),
  JSON.stringify({ totalFiles: 215112, pathChars: 215112 * 125 }));

/** Roda o hook com stdin cheio e fecha o stdout assim que o filho nascer.
 *  Destruir ANTES do evento 'spawn' derruba o próprio spawn no Windows
 *  (libuv cancela os pipes e o child nem chega a nascer: ENOENT fantasma). */
function runWithClosedStdout(script, payload) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd: TMP,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    let spawnOk = false;
    child.on('error', (err) => {
      resolve({ code: -1, stderr: stderr + '\n[spawn error] ' + err.message });
    });
    child.on('spawn', () => {
      spawnOk = true;
      child.stdout.destroy(); // agora sim: a janela morre com o filho vivo
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end(payload);
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: -1, stderr: stderr + '\n[timeout]' });
    }, 10000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!spawnOk && code === undefined) code = -1;
      resolve({ code, stderr });
    });
  });
}

async function main() {
  console.log('\n  [epipe · hooks sobrevivem a stdout fechado]');

  const bigPayload = JSON.stringify({
    cwd: TMP,
    session_id: 'epipe-1',
    tool_name: 'Grep',
    tool_response: 'match '.repeat(6000), // >25k chars: caminho do truncamento+escrita
  });

  for (const script of ['adapters/post-hook.cjs', 'adapters/prompt-hook.cjs']) {
    // prompt-hook precisa de contrato: roda a partir do repo real
    const abs = path.join(__dirname, '..', script);
    const r = await runWithClosedStdout(abs, bigPayload);
    check(`${script}: exit 0 com stdout fechado`,
      r.code === 0 || r.code === null, `code=${r.code} stderr=${r.stderr.slice(0, 200)}`);
    check(`${script}: nenhuma stack trace em stderr`, !/\n\s+at\s/.test(r.stderr));
  }

  console.log('');
  console.log(`  ${pass} passaram · ${fail} falharam`);
}

main().then(() => {
  // Cleanup SÓ após os spawns: cwd inexistente viraria ENOENT fantasma
  // apontando para o executável (Windows), mascarando o teste real.
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail ? 1 : 0);
});
