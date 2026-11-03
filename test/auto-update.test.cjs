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

  // poda do cache do npx: atualizar não acumula versões antigas
  const cacheDir = process.env.npm_config_cache;
  const mkNpx = (hash, packages, version, depName = '@allansantos-dev/token-guard') => {
    const base = path.join(cacheDir, '_npx', hash);
    fs.mkdirSync(path.join(base, 'node_modules', ...depName.split('/')), { recursive: true });
    fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({ _npx: { packages } }));
    fs.writeFileSync(path.join(base, 'node_modules', ...depName.split('/'), 'package.json'), JSON.stringify({ name: depName, version }));
    return base;
  };
  const PK = '@allansantos-dev/token-guard';
  const oldA = mkNpx('aaa', [`${PK}@2.14.1`], '2.14.1');
  const oldB = mkNpx('bbb', [`${PK}@2.15.0`], '2.15.0');
  const cur = mkNpx('ccc', [`${PK}@${NEXT}`], NEXT);
  const other = mkNpx('ddd', ['@allansantos-dev/smart-tool@0.9.1'], '0.9.1', '@allansantos-dev/smart-tool');
  const shared = mkNpx('eee', [`${PK}@2.0.0`, 'cowsay@1.0.0'], '2.0.0');
  const gone = AU.pruneOldNpxVersions(NEXT, cacheDir);
  check('poda remove as versões antigas do token-guard', !fs.existsSync(oldA) && !fs.existsSync(oldB) && gone.length === 2, gone);
  check('poda mantém a versão atual', fs.existsSync(cur));
  check('poda nunca toca cache de outro pacote nem pasta compartilhada', fs.existsSync(other) && fs.existsSync(shared));
  check('sem pasta _npx → nada a podar, sem erro', AU.pruneOldNpxVersions(NEXT, path.join(cacheDir, 'nao-existe')).length === 0);

  // run(): poda só depois de instalar com sucesso
  const oldC = mkNpx('fff', [`${PK}@2.15.0`], '2.15.0');
  fs.rmSync(AU.resultPath(), { force: true });
  let pruned = null;
  r = await AU.run({ checkForUpdate: newer, runInstaller: () => ({ status: 1, stderr: 'npm ERR!' }), pruneOldVersions: (v) => { pruned = v; } });
  check('instalação que falhou não poda nada', r.status === 'failed' && pruned === null, { r, pruned });
  fs.rmSync(AU.resultPath(), { force: true });
  r = await AU.run({ checkForUpdate: newer, runInstaller: () => ({ status: 0 }), pruneOldVersions: (v) => { pruned = v; } });
  check('instalação ok poda mantendo a versão nova', r.status === 'ok' && pruned === NEXT, { r, pruned });
  fs.rmSync(AU.resultPath(), { force: true });
  r = await AU.run({ checkForUpdate: newer, runInstaller: () => ({ status: 0 }) });
  check('poda real no run(): remove a antiga, guarda a atual', r.status === 'ok' && !fs.existsSync(oldC) && fs.existsSync(cur), r);
  fs.rmSync(AU.resultPath(), { force: true });
  r = await AU.run({ checkForUpdate: newer, runInstaller: () => ({ status: 0 }), pruneOldVersions: () => { throw new Error('boom'); } });
  check('erro na poda não derruba a atualização', r.status === 'ok', r);

  // B3: pedido sem versão (`npx pkg`) também é do token-guard e é podado; o da versão atual fica
  const bare = mkNpx('ggg', [PK], '2.0.0');
  const bareCur = mkNpx('hhh', [PK], NEXT);
  const bareOther = mkNpx('iii', ['cowsay'], '1.0.0', 'cowsay');
  AU.pruneOldNpxVersions(NEXT, cacheDir);
  check('pedido sem versão de uma versão antiga é podado', !fs.existsSync(bare));
  check('pedido sem versão da versão atual e de outro pacote ficam', fs.existsSync(bareCur) && fs.existsSync(bareOther));

  // B4: tarballs do token-guard em _cacache de outras versões saem (conteúdo + linha do índice)
  const crypto = require('crypto');
  const cacache = path.join(cacheDir, '_cacache');
  const content = (txt) => {
    const hex = crypto.createHash('sha512').update(txt).digest('hex');
    const file = path.join(cacache, 'content-v2', 'sha512', hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, txt);
    return { file, integrity: 'sha512-' + Buffer.from(hex, 'hex').toString('base64') };
  };
  const entry = (name, key, c) => {
    const file = path.join(cacache, 'index-v5', name.slice(0, 2), name.slice(2, 4), name.slice(4));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return { file, line: '\n' + 'h'.repeat(40) + '\t' + JSON.stringify({ key, integrity: c.integrity, time: 1, size: 1 }) };
  };
  const TB = (v) => `make-fetch-happen:request-cache:https://registry.npmjs.org/${PK}/-/token-guard-${v}.tgz`;
  const cOld = content('tarball 2.14.1');
  const cCur = content('tarball ' + NEXT);
  const cOther = content('tarball de outro pacote');
  const cPack = content('packument');
  const eOld = entry('aa11bbbbbb', TB('2.14.1'), cOld);
  const eCur = entry('cc22dddddd', TB(NEXT), cCur);
  const eOther = entry('ee33ffffff', 'make-fetch-happen:request-cache:https://registry.npmjs.org/cowsay/-/cowsay-1.0.0.tgz', cOther);
  const ePack = entry('0044aaaaaa', 'make-fetch-happen:request-cache:https://registry.npmjs.org/' + PK.replace('/', '%2f'), cPack);
  const eMix = entry('1155bbbbbb', TB('2.13.1'), content('tarball 2.13.1'));
  fs.writeFileSync(eOld.file, eOld.line);
  fs.writeFileSync(eCur.file, eCur.line);
  fs.writeFileSync(eOther.file, eOther.line);
  fs.writeFileSync(ePack.file, ePack.line);
  fs.writeFileSync(eMix.file, eMix.line + eCur.line.replace(/^\n/, '\n')); // bucket com uma entrada antiga e uma atual
  const gone4 = AU.pruneOldCacache(NEXT, cacheDir);
  check('cacache: conteúdo do tarball antigo é removido', !fs.existsSync(cOld.file) && gone4.length === 2, gone4);
  check('cacache: linha do índice só com a versão antiga some junto', !fs.existsSync(eOld.file));
  check('cacache: tarball da versão atual fica (conteúdo e índice)', fs.existsSync(cCur.file) && fs.existsSync(eCur.file));
  check('cacache: bucket misto perde só a linha antiga', fs.readFileSync(eMix.file, 'utf8').includes(TB(NEXT)) && !fs.readFileSync(eMix.file, 'utf8').includes(TB('2.13.1')));
  check('cacache: outro pacote e o packument do token-guard ficam intactos',
    fs.existsSync(cOther.file) && fs.existsSync(eOther.file) && fs.existsSync(cPack.file) && fs.existsSync(ePack.file));
  check('cacache ausente → nada a podar, sem erro', AU.pruneOldCacache(NEXT, path.join(cacheDir, 'nao-existe')).length === 0);
  fs.writeFileSync(eOld.file, eOld.line); // reaparece o tarball antigo; o conteúdo já se foi: a poda segue sem erro
  check('cacache: índice apontando para conteúdo já removido não quebra a poda', Array.isArray(AU.pruneOldCacache(NEXT, cacheDir)) && !fs.existsSync(eOld.file));

  // Conteúdo que não pode ser removido (aqui: um diretório no lugar do arquivo) mantém a linha do índice.
  const cStuck = content('tarball preso');
  fs.rmSync(cStuck.file); fs.mkdirSync(cStuck.file);
  const eStuck = entry('2266cccccc', TB('2.12.0'), cStuck);
  fs.writeFileSync(eStuck.file, eStuck.line);
  AU.pruneOldCacache(NEXT, cacheDir);
  check('cacache: conteúdo que não saiu mantém a linha do índice (sem órfão)', fs.existsSync(eStuck.file) && fs.readFileSync(eStuck.file, 'utf8').includes(TB('2.12.0')));

  // Bucket que o npm alterou durante a poda não é reescrito por cima.
  const cRace = content('tarball corrida');
  const eRace = entry('3377dddddd', TB('2.11.0'), cRace);
  fs.writeFileSync(eRace.file, eRace.line);
  const realRm = fs.rmSync;
  fs.rmSync = (p, o) => { realRm(p, o); if (p === cRace.file) fs.appendFileSync(eRace.file, '\nnova-linha-do-npm'); };
  try { AU.pruneOldCacache(NEXT, cacheDir); } finally { fs.rmSync = realRm; }
  check('cacache: bucket alterado durante a poda não é sobrescrito', fs.readFileSync(eRace.file, 'utf8').includes('nova-linha-do-npm'));

  // B2: o cache vem do npm (cache= do .npmrc), não de um palpite por plataforma
  check('npmCacheDir: variável de ambiente vence', AU.npmCacheDir(() => '/do-npm') === cacheDir);
  const savedCache = process.env.npm_config_cache;
  delete process.env.npm_config_cache;
  check('npmCacheDir: sem variável, usa o que o npm respondeu', AU.npmCacheDir(() => '/do-npm') === '/do-npm');
  check('npmCacheDir: npm mudo → cai no padrão da plataforma, sem lançar', typeof AU.npmCacheDir(() => null) === 'string' && AU.npmCacheDir(() => null).length > 0);
  const custom = path.join(path.dirname(cacheDir), 'cache-do-npmrc');
  fs.writeFileSync(path.join(process.env.HOME, '.npmrc'), 'cache=' + custom.replace(/\\/g, '/') + '\n');
  check('npmCacheDir: cache= do .npmrc do usuário é respeitado (npm real)', path.resolve(AU.npmCacheDir()) === path.resolve(custom), AU.npmCacheDir());
  const customOld = path.join(custom, '_npx', 'zzz');
  fs.mkdirSync(path.join(customOld, 'node_modules', '@allansantos-dev', 'token-guard'), { recursive: true });
  fs.writeFileSync(path.join(customOld, 'package.json'), JSON.stringify({ _npx: { packages: [PK + '@2.15.0'] } }));
  fs.writeFileSync(path.join(customOld, 'node_modules', '@allansantos-dev', 'token-guard', 'package.json'), JSON.stringify({ version: '2.15.0' }));
  fs.rmSync(AU.resultPath(), { force: true });
  r = await AU.run({ checkForUpdate: newer, runInstaller: () => ({ status: 0 }) });
  check('run(): com cache customizado no .npmrc, a poda limpa a pasta certa', r.status === 'ok' && !fs.existsSync(customOld), r);
  fs.rmSync(path.join(process.env.HOME, '.npmrc'), { force: true });
  fs.rmSync(custom, { recursive: true, force: true });
  process.env.npm_config_cache = savedCache;

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
  check('auto-update off → aviso manda atualizar à mão com os alvos registrados (init sem --target cairia no alvo repo)',
    /desligado — atualize à mão: npx --yes @allansantos-dev\/token-guard@99\.0\.0 init --target claude,mcp --command-hooks /.test(noteOff || ''), noteOff);
  check('comando manual sem registro usa o alvo de reserva', (() => {
    const saved = fs.readFileSync(AU.installStatePath(), 'utf8');
    fs.rmSync(AU.installStatePath(), { force: true });
    const m = AU.manualCommand(NEXT, 'all');
    fs.writeFileSync(AU.installStatePath(), saved);
    return m === `npx --yes @allansantos-dev/token-guard@${NEXT} init --target all`;
  })());
  delete process.env.TOKEN_GUARD_AUTO_UPDATE;

  // cópia sem install-state: segue checando (alimenta o aviso) e o aviso diz como se atualizar
  fs.rmSync(AU.installStatePath(), { force: true });
  checked = 0;
  r = await AU.run({ checkForUpdate: async () => { checked++; return newer(); }, runInstaller: () => { throw new Error('não instala sem estado'); } });
  check('sem install-state → pula, mas renova o cache da versão', r.status === 'skipped' && r.reason === 'sem install-state' && checked === 1, { r, checked });
  const noteNoState = AU.availableNotice(LOCAL);
  check('sem install-state → aviso manda rodar init uma vez (não diz "atualizando")',
    /não se atualiza sozinha — rode uma vez: npx --yes .*token-guard@99\.0\.0 init --target claude/.test(noteNoState || '') && !/atualizando em segundo plano/.test(noteNoState), noteNoState);
  // o link do aviso é o Pages (leitor humano), nunca README nem blob do repositório
  const SITE = 'https://allansantos-dv.github.io/token-guard/';
  const linkOk = (n) => !!n && n.includes(SITE) && !/README|\/blob\//i.test(n)
    && (n.match(/https?:\/\/\S+/g) || []).every((u) => u === SITE);
  process.env.TOKEN_GUARD_AUTO_UPDATE = 'off';
  const noteOffLink = AU.availableNotice(LOCAL);
  delete process.env.TOKEN_GUARD_AUTO_UPDATE;
  check('aviso (sem install-state) linka o Pages, sem README//blob/', linkOk(noteNoState), noteNoState);
  check('aviso (auto-update off) linka o Pages, sem README//blob/', linkOk(noteOffLink), noteOffLink);
  fs.writeFileSync(AU.installStatePath(), JSON.stringify({ targets: ['claude'], runs: 1 }));
  check('aviso (atualizando em segundo plano) linka o Pages, sem README//blob/', linkOk(AU.availableNotice(LOCAL)), AU.availableNotice(LOCAL));
  fs.rmSync(AU.installStatePath(), { force: true });
  check('SITE_URL é o Pages', require('../lib/update-check.cjs').SITE_URL === SITE);

  process.env.TOKEN_GUARD_UPDATE_CHECK = 'off';
  check('UPDATE_CHECK=off → sem aviso', AU.availableNotice(LOCAL) === null);
  delete process.env.TOKEN_GUARD_UPDATE_CHECK;
  fs.rmSync(cacheFile, { force: true });

  reset();
  console.log(`\n  auto-update: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
