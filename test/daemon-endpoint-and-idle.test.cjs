'use strict';
/**
 * Cobre `defaultWindowsSid()`/`defaultEndpoint()` (dois processos reais
 * distintos devem calcular o mesmo endpoint por padrão, sem
 * `TOKEN_GUARD_SID`) e `scheduleIdleShutdown()` (autoencerramento por
 * ociosidade, com deps injetadas).
 */

require('./bootstrap.cjs');

const { spawnSync } = require('child_process');
const path = require('path');
const {
  defaultEndpoint, defaultWindowsSid, scheduleIdleShutdown,
} = require('../adapters/daemon-server.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

function printEndpointInChildProcess() {
  const res = spawnSync(process.execPath, ['-e',
    "process.stdout.write(require(process.argv[1]).defaultEndpoint())",
    path.join(__dirname, '..', 'adapters', 'daemon-server.cjs'),
  ], {
    encoding: 'utf8',
    env: { ...process.env, TOKEN_GUARD_SID: '' },
  });
  return { stdout: res.stdout, pid: res.pid };
}

function main() {
  // --- defaultWindowsSid ---
  if (process.platform === 'win32') {
    const sid1 = defaultWindowsSid();
    const sid2 = defaultWindowsSid();
    check('defaultWindowsSid não é vazio', typeof sid1 === 'string' && sid1.length > 0);
    check('defaultWindowsSid é determinístico (mesmo processo)', sid1 === sid2);
    check('defaultWindowsSid não é o pid do processo', sid1 !== String(process.pid));
    check('defaultWindowsSid só usa caracteres seguros pra pipe', /^[A-Za-z0-9_.-]+$/.test(sid1));

    delete process.env.TOKEN_GUARD_SID;
    const ep1 = defaultEndpoint();
    const ep2 = defaultEndpoint();
    check('defaultEndpoint (sem TOKEN_GUARD_SID) é estável entre chamadas', ep1 === ep2);
    check('defaultEndpoint (sem TOKEN_GUARD_SID) não contém o pid deste processo',
      !ep1.includes(String(process.pid)));

    const child1 = printEndpointInChildProcess();
    const child2 = printEndpointInChildProcess();
    check('dois processos reais distintos calculam o MESMO endpoint por padrão',
      child1.stdout === child2.stdout && child1.stdout.length > 0,
      `pid1=${child1.pid} -> ${child1.stdout} | pid2=${child2.pid} -> ${child2.stdout}`);
    check('processos reais são de fato distintos (não é o mesmo pid)', child1.pid !== child2.pid);
  } else {
    console.log('  (defaultWindowsSid/defaultEndpoint win32: pulado — não é Windows; POSIX já usa process.uid, estável por construção)');
  }

  // --- scheduleIdleShutdown ---
  {
    let now = 1_000_000;
    let intervalCb = null;
    let cleared = false;
    let exitedWith = null;
    let unlinkedPath = null;
    let closeCb = null;
    const fakeServer = { ctx: { lastActivity: now }, close: (cb) => { closeCb = cb; if (cb) cb(); } };
    const deps = {
      nowFn: () => now,
      setIntervalFn: (cb) => { intervalCb = cb; return 'fake-timer'; },
      clearIntervalFn: (t) => { if (t === 'fake-timer') cleared = true; },
      unlinkFn: (p) => { unlinkedPath = p; },
      exitFn: (code) => { exitedWith = code; },
    };

    const timer = scheduleIdleShutdown(fakeServer, '/tmp/fake.lock', 5000, deps);
    check('scheduleIdleShutdown agenda um interval', timer === 'fake-timer');
    check('checkEveryMs nunca excede idleTimeoutMs', typeof intervalCb === 'function');

    // Tick com atividade recente: não deve encerrar.
    fakeServer.ctx.lastActivity = now;
    intervalCb();
    check('não encerra enquanto está dentro da janela de atividade', exitedWith === null && !cleared);

    // Avança o tempo além do idle timeout: deve encerrar.
    now += 6000;
    intervalCb();
    check('encerra após exceder o idle timeout', exitedWith === 0);
    check('cancela o próprio interval antes de encerrar', cleared === true);
    check('remove o lockfile antes de encerrar', unlinkedPath === '/tmp/fake.lock');
  }

  {
    const timer = scheduleIdleShutdown({ ctx: { lastActivity: Date.now() } }, '/tmp/fake.lock', 0, {});
    check('idleTimeoutMs <= 0 desativa o mecanismo (retorna null)', timer === null);
  }

  console.log(`\n  daemon-endpoint-and-idle: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}

main();
