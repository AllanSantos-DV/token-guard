'use strict';
/**
 * auto-update.test.cjs — versão nova reinstala os mesmos alvos, sem rede no teste.
 *
 * Invariantes:
 *   · o install.cjs registra os alvos de máquina (repo fica de fora) e soma execuções;
 *   · o comando só aceita versão semver e alvo conhecido (vai a um shell no Windows);
 *   · havendo versão nova, roda o instalador DA VERSÃO NOVA com os alvos registrados;
 *   · resultado (ok ou falha) é relatado uma vez ao usuário; falha não é repetida
 *     na mesma versão antes de 24 h; duas sessões não atualizam ao mesmo tempo.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const AU = require('../lib/auto-update.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

const LOCAL = require('../package.json').version;
const NEXT = '99.0.0';
const newer = async () => ({ checked: true, updateAvailable: true, latestVersion: NEXT, localVersion: LOCAL });
const reset = () => [AU.installStatePath(), AU.resultPath(), AU.logPath(), AU.lockPath()].forEach((f) => fs.rmSync(f, { force: true }));

(async () => {
  console.log('\n  [auto-update]');
  reset();

  // install.cjs grava o estado (mcp é o alvo de máquina mais leve)
  const inst = spawnSync(process.execPath, [path.join(__dirname, '..', 'install.cjs'), '--target', 'mcp'], { encoding: 'utf8', timeout: 60000 });
  check('install --target mcp sai 0', inst.status === 0, inst.stderr);
  check('install registra os alvos de máquina', JSON.stringify(AU.readInstallState()) === '{"targets":["mcp"],"commandHooks":false}', AU.readInstallState());
  const dry = spawnSync(process.execPath, [path.join(__dirname, '..', 'install.cjs'), '--target', 'claude', '--dry-run'], { encoding: 'utf8', timeout: 60000 });
  check('--dry-run não grava estado', dry.status === 0 && AU.readInstallState().targets.join() === 'mcp', AU.readInstallState());

  AU.recordInstall({ targets: ['claude', 'repo'], commandHooks: true, version: LOCAL });
  check('soma alvos, ignora repo, guarda --command-hooks',
    JSON.stringify(AU.readInstallState()) === '{"targets":["claude","mcp"],"commandHooks":true}', AU.readInstallState());

  // comando
  const cmd = AU.buildCommand(NEXT, AU.readInstallState());
  check('comando usa o instalador da versão nova com os mesmos alvos',
    cmd.cmd === 'npx' && cmd.args.join(' ') === `--yes @allansantos-dev/token-guard@${NEXT} init --target claude,mcp --command-hooks`, cmd);
  let threw = null;
  try { AU.buildCommand('1.0.0 & calc', { targets: ['claude'] }); } catch (e) { threw = e; }
  check('versão fora do semver é recusada (nada vai ao shell)', threw && /versão inválida/.test(threw.message), threw && threw.message);
  threw = null;
  try { AU.buildCommand(NEXT, { targets: ['claude&calc'] }); } catch (e) { threw = e; }
  check('alvo desconhecido é recusado', threw && /alvos inválidos/.test(threw.message), threw && threw.message);

  // rodada com sucesso
  let ran = null;
  let r = await AU.run({ checkForUpdate: newer, runInstaller: (c) => { ran = c; return { status: 0, stdout: 'ok', stderr: '' }; } });
  check('versão nova → instala e registra ok', r.status === 'ok' && r.from === LOCAL && r.to === NEXT && ran && ran.args.includes(`@allansantos-dev/token-guard@${NEXT}`), r);
  const okMsg = AU.takeReport();
  check('sucesso é relatado ao usuário uma vez', /atualizado automaticamente/.test(okMsg || '') && AU.takeReport() === null, okMsg);
  check('lock liberado ao fim', !fs.existsSync(AU.lockPath()));

  // em dia
  ran = null;
  r = await AU.run({ checkForUpdate: async () => ({ checked: true, updateAvailable: false, latestVersion: LOCAL }), runInstaller: (c) => { ran = c; return { status: 0 }; } });
  check('em dia → não instala', r.status === 'skipped' && ran === null, r);

  // "instalou" mas a versão em uso não mudou: falha visível, sem reinstalar a cada sessão
  r = await AU.run({ checkForUpdate: newer, runInstaller: (c) => { ran = c; return { status: 0 }; } });
  check('update ok sem efeito → vira falha relatada, sem reinstalar', r.status === 'failed' && /continua/.test(r.error) && ran === null, r);
  check('essa falha chega ao usuário', /FALHOU.*continua/.test(AU.takeReport() || ''));

  // falha: relatada alto, sem repetir na mesma versão
  fs.rmSync(AU.resultPath(), { force: true });
  r = await AU.run({ checkForUpdate: newer, runInstaller: () => ({ status: 1, stdout: '', stderr: 'npm ERR! 404' }) });
  check('instalador falhou → registra failed', r.status === 'failed' && /saiu com 1/.test(r.error), r);
  const failMsg = AU.takeReport();
  check('falha relatada com o log e o comando manual', /FALHOU/.test(failMsg || '') && failMsg.includes(AU.logPath()) && failMsg.includes(`token-guard@${NEXT}`), failMsg);
  check('log do instalador gravado', /npm ERR! 404/.test(fs.readFileSync(AU.logPath(), 'utf8')));
  ran = null;
  r = await AU.run({ checkForUpdate: newer, runInstaller: (c) => { ran = c; return { status: 0 }; } });
  check('mesma versão que falhou há pouco → não insiste', r.status === 'skipped' && ran === null, r);
  r = await AU.run({ checkForUpdate: newer, now: () => Date.now() + 25 * 3600 * 1000, runInstaller: () => ({ status: 0 }) });
  check('passadas 24 h → tenta de novo', r.status === 'ok', r);

  // concorrência
  fs.rmSync(AU.resultPath(), { force: true });
  fs.writeFileSync(AU.lockPath(), '1');
  ran = null;
  r = await AU.run({ checkForUpdate: newer, runInstaller: (c) => { ran = c; return { status: 0 }; } });
  check('outra sessão atualizando (lock) → pula', r.status === 'skipped' && ran === null, r);
  fs.rmSync(AU.lockPath(), { force: true });

  // aviso de versão nova (só cache, sem rede)
  const cacheFile = path.join(path.dirname(AU.installStatePath()), 'update-check.json');
  fs.rmSync(cacheFile, { force: true });
  check('sem cache → sem aviso', AU.availableNotice(LOCAL) === null);
  fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: NEXT, checkedAt: Date.now() }));
  const note = AU.availableNotice(LOCAL);
  check('cache com versão nova → aviso visível, auto-update em curso',
    new RegExp(`${NEXT} disponível no npm \\(você usa ${LOCAL.replace(/\./g, '\\.')}\\).*atualizando em segundo plano`).test(note || ''), note);
  fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: LOCAL, checkedAt: Date.now() }));
  check('em dia → sem aviso', AU.availableNotice(LOCAL) === null);
  fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: NEXT, checkedAt: Date.now() }));

  // desligado
  process.env.TOKEN_GUARD_AUTO_UPDATE = 'off';
  let checked = 0;
  r = await AU.run({ checkForUpdate: async () => { checked++; return newer(); }, runInstaller: () => ({ status: 0 }) });
  check('TOKEN_GUARD_AUTO_UPDATE=off → desligado, mas segue checando a versão', r.status === 'skipped' && r.reason === 'desligado' && checked === 1, { r, checked });
  const noteOff = AU.availableNotice(LOCAL);
  check('auto-update off → aviso manda atualizar à mão', /desligado — atualize à mão: npx .*token-guard@99\.0\.0 init/.test(noteOff || ''), noteOff);
  delete process.env.TOKEN_GUARD_AUTO_UPDATE;
  process.env.TOKEN_GUARD_UPDATE_CHECK = 'off';
  check('UPDATE_CHECK=off → sem aviso', AU.availableNotice(LOCAL) === null);
  delete process.env.TOKEN_GUARD_UPDATE_CHECK;
  fs.rmSync(cacheFile, { force: true });

  reset();
  console.log(`\n  auto-update: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
