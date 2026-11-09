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
  defaultEndpoint, defaultWindowsSid, scheduleIdleShutdown, idleTimeoutFromEnv,
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
    let timeoutCb = null;
    let armedFor = null;
    let armedCount = 0;
    let exitedWith = null;
    let unlinkedPath = null;
    const fakeServer = { ctx: { lastActivity: now }, close: (cb) => { if (cb) cb(); } };
    const deps = {
      nowFn: () => now,
      setTimeoutFn: (cb, ms) => { timeoutCb = cb; armedFor = ms; armedCount++; return 'fake-timer'; },
      unlinkFn: (p) => { unlinkedPath = p; },
      exitFn: (code) => { exitedWith = code; },
    };

    const timer = scheduleIdleShutdown(fakeServer, '/tmp/fake.lock', 5000, deps);
    check('scheduleIdleShutdown agenda um único timer', timer === 'fake-timer' && armedCount === 1);
    check('o primeiro despertar é no instante em que a ociosidade venceria, não num intervalo fixo', armedFor === 5000, armedFor);

    // Atividade no meio da janela: acorda, não encerra e reagenda só o que falta.
    now += 3000;
    fakeServer.ctx.lastActivity = now;
    now += 2000;
    timeoutCb();
    check('não encerra enquanto está dentro da janela de atividade', exitedWith === null);
    check('reagenda para o que falta da janela, sem polling', armedCount === 2 && armedFor === 3000, { armedCount, armedFor });

    // Avança o tempo além do idle timeout: deve encerrar.
    now += 6000;
    timeoutCb();
    check('encerra após exceder o idle timeout', exitedWith === 0);
    check('não reagenda ao encerrar', armedCount === 2);
    check('remove o lockfile antes de encerrar', unlinkedPath === '/tmp/fake.lock');
  }

  {
    const timer = scheduleIdleShutdown({ ctx: { lastActivity: Date.now() } }, '/tmp/fake.lock', 0, {});
    check('idleTimeoutMs <= 0 desativa o mecanismo (retorna null)', timer === null);
  }

  // TOKEN_GUARD_DAEMON_IDLE_MS: "0" desativa (SECURITY.md) — não pode cair no padrão.
  check('env "0" desativa o autoencerramento', idleTimeoutFromEnv('0') === 0);
  check('env ausente usa 10 min', idleTimeoutFromEnv(undefined) === 600000);
  check('env vazio usa 10 min', idleTimeoutFromEnv('') === 600000);
  check('env inválido usa 10 min', idleTimeoutFromEnv('abc') === 600000);
  check('env numérico vale', idleTimeoutFromEnv('5000') === 5000);

  console.log(`\n  daemon-endpoint-and-idle: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}

main();
