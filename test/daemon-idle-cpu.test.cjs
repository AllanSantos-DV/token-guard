'use strict';
/**
 * daemon-idle-cpu.test.cjs — o daemon ocioso não gasta CPU, nem quando a pasta do perfil some.
 *
 * Regressão da medição de 08/11: dois daemons de teste órfãos (HOME isolado apagado) usavam um núcleo
 * cada. No Windows o `fs.watch` da pasta de config, uma vez apagada a pasta, dispara `rename` em laço.
 * O daemon sobe com http (token no perfil), o perfil é apagado e a CPU do processo é medida parado.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const DAEMON = path.join(__dirname, '..', 'adapters', 'daemon-server.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

/** CPU acumulada do processo, em segundos. */
function cpuSeconds(pid) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds.ToString([cultureinfo]::InvariantCulture)`], { encoding: 'utf8', windowsHide: true });
    return parseFloat(out);
  }
  const out = execFileSync('ps', ['-o', 'times=', '-p', String(pid)], { encoding: 'utf8' });
  return parseFloat(out);
}

(async () => {
  console.log('\n  [daemon-idle-cpu · daemon ocioso sem CPU]');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-idlecpu-home-'));
  fs.mkdirSync(path.join(home, '.token-guard'), { recursive: true });
  fs.writeFileSync(path.join(home, '.token-guard', 'daemon-http.token'), 'tok-idle-cpu\n');
  const d = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, HOME: home, USERPROFILE: home, TOKEN_GUARD_SID: `idlecpu-${process.pid}` },
    stdio: 'ignore',
  });
  try {
    await sleep(3000);
    check('daemon com http subiu', d.exitCode === null);
    fs.rmSync(home, { recursive: true, force: true });
    await sleep(1000);
    const before = cpuSeconds(d.pid);
    await sleep(4000);
    const used = cpuSeconds(d.pid) - before;
    // O laço defeituoso gastava ~4 s de CPU nesta janela; o daemon são fica abaixo de 0,3 s mesmo com a máquina carregada.
    check('perfil apagado: o daemon ocioso não gasta CPU', used < 0.5, { usedSeconds: used });
  } finally {
    try { d.kill(); } catch { /* já saiu */ }
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log(`\n  daemon-idle-cpu: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
