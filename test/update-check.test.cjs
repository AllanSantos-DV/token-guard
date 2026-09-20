#!/usr/bin/env node
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FALHA ${label}${detail ? '\n        ' + detail : ''}`); }
}

let UC;
try { UC = require(path.join(__dirname, '..', 'lib', 'update-check.cjs')); }
catch (e) { console.log(`  FALHA módulo: ${e.message.split('\n')[0]}`); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-upd-'));
const originalEnv = process.env.TOKEN_GUARD_UPDATE_CHECK;
delete process.env.TOKEN_GUARD_UPDATE_CHECK;

async function main() {
  console.log('\n  [camada A · núcleo puro]');

  // A1 compareVersions
  {
    check('A1a: igual', UC.compareVersions('2.3.2', '2.3.2') === 0);
    check('A1b: local menor (patch)', UC.compareVersions('2.3.1', '2.3.2') < 0);
    check('A1c: local maior (patch)', UC.compareVersions('2.3.2', '2.3.1') > 0);
    check('A1d: minor diferente', UC.compareVersions('2.2.9', '2.3.0') < 0);
    check('A1e: major diferente', UC.compareVersions('1.9.9', '2.0.0') < 0);
    // A1f-j (backlog A10): precedência de pre-release/build por semver.org #11
    check('A1f: release > pre-release da mesma versão', UC.compareVersions('2.4.0', '2.4.0-beta.1') > 0);
    check('A1g: pre-release < release da mesma versão', UC.compareVersions('2.4.0-beta.1', '2.4.0') < 0);
    check('A1h: pre-release alfanumérico > pre-release numérico no mesmo campo', UC.compareVersions('2.4.0-beta', '2.4.0-1') > 0);
    check('A1i: pre-release numérico compara por valor, não lexicograficamente', UC.compareVersions('2.4.0-9', '2.4.0-10') < 0);
    check('A1j: pre-release com mais campos > prefixo idêntico com menos campos', UC.compareVersions('2.4.0-alpha.1', '2.4.0-alpha') > 0);
    check('A1k: pre-release lexicográfico entre alfanuméricos', UC.compareVersions('2.4.0-alpha', '2.4.0-beta') < 0);
    check('A1l: build metadata (+...) ignorado na precedência', UC.compareVersions('2.4.0+build1', '2.4.0+build2') === 0);
    check('A1m: pre-release idêntica é igual (0), não maior nem menor', UC.compareVersions('2.4.0-beta.1', '2.4.0-beta.1') === 0);
  }

  // A2 isStale
  {
    const now = 1_000_000;
    check('A2a: cache ausente → stale', UC.isStale(null, now, 1000) === true);
    check('A2b: cache dentro do TTL → não-stale', UC.isStale({ checkedAt: now - 500 }, now, 1000) === false);
    check('A2c: cache expirado → stale', UC.isStale({ checkedAt: now - 2000 }, now, 1000) === true);
  }

  console.log('\n  [camada A2b · extractVersion pura]');

  // A3 extractVersion
  {
    check('A3a: status 200 + JSON válido → version', UC.extractVersion(200, '{"version":"2.4.0"}') === '2.4.0');
    check('A3b: status != 200 → null', UC.extractVersion(404, '{"version":"2.4.0"}') === null);
    check('A3c: corpo malformado (JSON inválido) → null', UC.extractVersion(200, 'não é json') === null);
    check('A3d: version ausente → null', UC.extractVersion(200, '{}') === null);
    check('A3e: version com tipo errado → null', UC.extractVersion(200, '{"version":123}') === null);
    check('A3f: version fora do formato semver (payload malicioso) → null', UC.extractVersion(200, '{"version":"\\u001b[31mPWNED\\u001b[0m"}') === null);
    check('A3g: version semver com pre-release/build → aceita', UC.extractVersion(200, '{"version":"2.4.0-beta.1"}') === '2.4.0-beta.1');
    check('A3h: version semver com metadata +build → aceita', UC.extractVersion(200, '{"version":"2.4.0+20260920"}') === '2.4.0+20260920');
    // bypass da rodada 3: prefixo numérico válido + sufixo malicioso no pre-release
    check('A3i: prefixo N.N.N válido + sufixo pre-release malicioso (ANSI) → null', UC.extractVersion(200, JSON.stringify({ version: '2.4.0-\u001b[31mPWNED\u001b[0m' })) === null);
    check('A3j: prefixo N.N.N válido + sufixo build malicioso (ANSI) → null', UC.extractVersion(200, JSON.stringify({ version: '2.4.0+\u001b[31mPWNED\u001b[0m' })) === null);
    // A3o-r (backlog A9): regex semver oficial rejeita zero à esquerda
    check('A3o: major com zero à esquerda → null', UC.extractVersion(200, '{"version":"01.2.3"}') === null);
    check('A3p: minor com zero à esquerda → null', UC.extractVersion(200, '{"version":"1.02.3"}') === null);
    check('A3q: pre-release puramente numérico com zero à esquerda → null', UC.extractVersion(200, '{"version":"1.2.3-01"}') === null);
    check('A3r: patch "0" (sem zero à esquerda de verdade) → aceita', UC.extractVersion(200, '{"version":"1.2.0"}') === '1.2.0');
  }

  // A3k: buildRegistryUrl — codifica corretamente pacote com escopo (@ e /)
  {
    const url = UC.buildRegistryUrl('@allansantos-dev/token-guard');
    check('A3k: buildRegistryUrl codifica nome de pacote com escopo', url === 'https://registry.npmjs.org/%40allansantos-dev%2Ftoken-guard/latest', url);
  }

  console.log('\n  [camada A2c · fetchVersionFromUrl contra servidor http local]');

  // A4 fetchVersionFromUrl — servidor local real (sem TLS), exercita timeout/error/status/corpo real
  {
    function withServer(handler) {
      return new Promise((resolve, reject) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => resolve(srv));
        srv.on('error', reject);
      });
    }

    // A4a: 200 + corpo válido
    {
      const srv = await withServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"version":"2.4.0"}'); });
      const { port } = srv.address();
      const v = await UC.fetchVersionFromUrl(`http://127.0.0.1:${port}/pkg/latest`, 2000);
      await new Promise((r) => srv.close(r));
      check('A4a: 200 + corpo válido → version', v === '2.4.0');
    }

    // A4b: status != 200
    {
      const srv = await withServer((req, res) => { res.writeHead(404); res.end('not found'); });
      const { port } = srv.address();
      const v = await UC.fetchVersionFromUrl(`http://127.0.0.1:${port}/pkg/latest`, 2000);
      await new Promise((r) => srv.close(r));
      check('A4b: status 404 → null', v === null);
    }

    // A4c: corpo malformado
    {
      const srv = await withServer((req, res) => { res.writeHead(200); res.end('{ isto não fecha'); });
      const { port } = srv.address();
      const v = await UC.fetchVersionFromUrl(`http://127.0.0.1:${port}/pkg/latest`, 2000);
      await new Promise((r) => srv.close(r));
      check('A4c: corpo malformado → null', v === null);
    }

    // A4d: timeout (servidor nunca responde dentro do timeoutMs)
    {
      const srv = await withServer((req, res) => { /* nunca chama res.end() */ });
      const { port } = srv.address();
      const v = await UC.fetchVersionFromUrl(`http://127.0.0.1:${port}/pkg/latest`, 150);
      await new Promise((r) => srv.close(r));
      check('A4d: timeout → null', v === null);
    }

    // A4e: erro de conexão (porta fechada, ninguém escutando)
    {
      const srv = await withServer((req, res) => { res.writeHead(200); res.end('{"version":"9.9.9"}'); });
      const { port } = srv.address();
      await new Promise((r) => srv.close(r));
      const v = await UC.fetchVersionFromUrl(`http://127.0.0.1:${port}/pkg/latest`, 2000);
      check('A4e: conexão recusada (porta fechada) → null', v === null);
    }

    // A4f: corpo maior que o teto (16KB) → aborta, não acumula indefinidamente
    {
      const srv = await withServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"version":"');
        // manda bem mais que o teto em pedaços, sem nunca fechar sozinho
        const chunk = 'a'.repeat(4096);
        let sent = 0;
        const iv = setInterval(() => {
          if (sent >= 6 || res.destroyed) { clearInterval(iv); return; }
          res.write(chunk);
          sent++;
        }, 5);
        res.on('close', () => clearInterval(iv));
      });
      const { port } = srv.address();
      const v = await UC.fetchVersionFromUrl(`http://127.0.0.1:${port}/pkg/latest`, 2000);
      await new Promise((r) => srv.close(r));
      check('A4f: corpo acima do teto de bytes → null (não trava)', v === null);
    }

    // A4g: deadline absoluto — servidor "slow-drip" mantém socket ativo (nunca ocioso) mas nunca termina
    {
      const srv = await withServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        const iv = setInterval(() => { if (!res.destroyed) res.write('x'); }, 20);
        res.on('close', () => clearInterval(iv));
      });
      const { port } = srv.address();
      const start = Date.now();
      const v = await UC.fetchVersionFromUrl(`http://127.0.0.1:${port}/pkg/latest`, 150);
      const elapsed = Date.now() - start;
      await new Promise((r) => srv.close(r));
      check('A4g: slow-drip (socket nunca ocioso) ainda resolve via deadline absoluto', v === null && elapsed < 1000, `elapsed=${elapsed}ms`);
    }

    // A4h (backlog A12): branch https: contra um servidor HTTP PURO real (sem TLS) —
    // distingue de fato a seleção do módulo. Se `fetchVersionFromUrl` selecionasse
    // (por bug) o módulo `http` para uma URL `https:`, a requisição chegaria pura
    // no servidor de teste e teria SUCESSO (200 + version válido). Como o código
    // correto escolhe `https`, o cliente tenta handshake TLS contra um servidor que
    // fala HTTP puro e falha no protocolo — prova observável de que o branch https:
    // foi de fato exercitado, não apenas "conexão recusada" (que seria indistinguível
    // do branch http: com porta fechada).
    {
      const srv = await withServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"version":"9.9.9"}'); });
      const { port } = srv.address();
      const v = await UC.fetchVersionFromUrl(`https://127.0.0.1:${port}/pkg/latest`, 2000);
      await new Promise((r) => srv.close(r));
      check('A4h: branch https: contra servidor HTTP puro → falha no handshake TLS (não usa http: por engano) → null', v === null, `v=${v}`);
    }

    // A4i: fetchLatestReal (= REAL_DEPS.fetchLatest em produção) — composição
    // real pkgName → buildRegistryUrl → fetchVersionFromUrl → version, contra
    // um servidor http local que confere o path/query recebido (prova que o
    // pkgName é de fato codificado e propagado até a requisição real, não só
    // testado em isolamento por A3k/A4a-h separadamente).
    {
      let receivedPath = null;
      const srv = await withServer((req, res) => {
        receivedPath = req.url;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"version":"3.1.4"}');
      });
      const { port } = srv.address();
      const v = await UC.fetchLatestReal('@allansantos-dev/token-guard', 2000, `http://127.0.0.1:${port}`);
      await new Promise((r) => srv.close(r));
      check('A4i: fetchLatestReal resolve version via composição real', v === '3.1.4', v);
      check('A4i: fetchLatestReal propaga pkgName codificado na URL', receivedPath === '/%40allansantos-dev%2Ftoken-guard/latest', receivedPath);
    }
  }

  console.log('\n  [camada B · checkForUpdate com deps mockadas]');

  const cacheFile = path.join(TMP, 'update-check.json');

  // B1: sem cache, fetch retorna versão nova
  {
    fs.rmSync(cacheFile, { force: true });
    let fetchCalls = 0;
    const r = await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile },
      { fetchLatest: async () => { fetchCalls++; return '2.4.0'; } }
    );
    const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    check('B1a: updateAvailable true', r.checked === true && r.updateAvailable === true && r.latestVersion === '2.4.0');
    check('B1b: fetch chamado 1x e cache gravado', fetchCalls === 1 && written.latestVersion === '2.4.0');
  }

  // B2: cache válido com versão igual à local — não bate rede
  {
    fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: '2.3.2', checkedAt: Date.now() }));
    let fetchCalls = 0;
    const r = await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile, ttlMs: 86400000 },
      { fetchLatest: async () => { fetchCalls++; return '9.9.9'; } }
    );
    check('B2a: fetch NÃO chamado (cache fresco)', fetchCalls === 0);
    check('B2b: updateAvailable false', r.checked === true && r.updateAvailable === false);
  }

  // B3: cache expirado, fetch retorna igual à local
  {
    fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: '2.3.0', checkedAt: Date.now() - 999999999 }));
    const r = await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile, ttlMs: 1000 },
      { fetchLatest: async () => '2.3.2' }
    );
    const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    check('B3: cache expirado revalida e reescreve', r.updateAvailable === false && written.latestVersion === '2.3.2');
  }

  // B4: cache em disco com shape inválido (JSON válido, campos errados) → REAL_DEPS.readCache trata como ausente
  {
    fs.writeFileSync(cacheFile, JSON.stringify({ foo: 'bar' }));
    let fetchCalls = 0;
    const r = await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile },
      { fetchLatest: async () => { fetchCalls++; return '2.4.0'; } }
    );
    check('B4a: shape inválido → readCache real devolve null, dispara fetch', fetchCalls === 1);
    check('B4b: resultado ainda coerente', r.checked === true && r.updateAvailable === true);
  }
  {
    fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: 123, checkedAt: 'ontem' }));
    let fetchCalls = 0;
    await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile },
      { fetchLatest: async () => { fetchCalls++; return '2.4.0'; } }
    );
    check('B4c: latestVersion/checkedAt com tipo errado → também tratado como ausente', fetchCalls === 1);
  }
  {
    // B4d: cache em disco com latestVersion string mas fora do formato semver (adulterado/malicioso) → tratado como ausente
    fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: '2.4.0-\u001b[31mPWNED\u001b[0m', checkedAt: Date.now() }));
    let fetchCalls = 0;
    await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile },
      { fetchLatest: async () => { fetchCalls++; return '2.4.0'; } }
    );
    check('B4d: latestVersion do cache fora do formato semver → readCache real rejeita, dispara fetch', fetchCalls === 1);
  }

  // B5 (backlog A13): REAL_DEPS.writeCache real (não mockado) contra um diretório
  // pai genuinamente inexistente — prova que o mkdirSync recursivo funciona de
  // verdade, não só a suposição de que ele funcionaria.
  {
    const nestedCacheFile = path.join(TMP, 'nested', 'does', 'not', 'exist', 'update-check.json');
    check('B5a: diretório pai realmente não existe antes da escrita', !fs.existsSync(path.dirname(nestedCacheFile)));
    const r = await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile: nestedCacheFile },
      { fetchLatest: async () => '2.4.0' }
    );
    check('B5b: checkForUpdate com REAL_DEPS.writeCache cria os diretórios aninhados', fs.existsSync(nestedCacheFile));
    const written = JSON.parse(fs.readFileSync(nestedCacheFile, 'utf8'));
    check('B5c: conteúdo gravado é o esperado', written.latestVersion === '2.4.0' && r.updateAvailable === true);
    fs.rmSync(path.join(TMP, 'nested'), { recursive: true, force: true });
  }

  // C1: fetch falha (null), sem cache prévio
  {
    fs.rmSync(cacheFile, { force: true });
    const r = await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile },
      { fetchLatest: async () => null }
    );
    check('C1: sem rede e sem cache → checked:false reason:offline', r.checked === false && r.reason === 'offline');
  }

  // C2: fetch falha, mas há cache válido anterior (best-effort)
  {
    fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: '2.5.0', checkedAt: 0 }));
    const r = await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile, ttlMs: 1000 },
      { fetchLatest: async () => null }
    );
    check('C2: rede falha mas cache antigo é usado best-effort', r.checked === true && r.updateAvailable === true && r.latestVersion === '2.5.0');
    const stillOnDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    check('C2b: checkedAt do cache em disco NÃO é reescrito quando o fetch falha (best-effort, sem debounce)', stillOnDisk.checkedAt === 0, JSON.stringify(stillOnDisk));
  }

  // C3 (backlog A14): fetchLatest REJEITA (não apenas retorna null) — exercita o
  // catch em torno de `deps.fetchLatest(...)` dentro de checkForUpdate, que antes
  // não tinha nenhum teste cobrindo o caminho de rejeição real (timeout/DNS real
  // rejeitam a Promise, REAL_DEPS.fetchLatest só resolve null por contrato, mas o
  // catch existe justamente para proteger contra deps customizadas/futuras que rejeitem).
  {
    fs.rmSync(cacheFile, { force: true });
    let threw = false;
    let r = null;
    try {
      r = await UC.checkForUpdate(
        { localVersion: '2.3.2', cacheFile },
        { fetchLatest: async () => { throw new Error('ECONNRESET simulado'); } }
      );
    } catch (e) { threw = true; }
    check('C3a: fetchLatest rejeitando não derruba checkForUpdate', !threw);
    check('C3b: sem cache prévio → checked:false reason:offline (mesmo tratamento de fetch=null)', r && r.checked === false && r.reason === 'offline', JSON.stringify(r));
  }
  {
    // C3c: fetchLatest rejeita, mas há cache válido anterior → usa o cache (best-effort)
    fs.writeFileSync(cacheFile, JSON.stringify({ latestVersion: '2.5.0', checkedAt: 0 }));
    const r = await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile, ttlMs: 1000 },
      { fetchLatest: async () => { throw new Error('timeout simulado'); } }
    );
    check('C3c: fetchLatest rejeita mas cache antigo é usado best-effort', r.checked === true && r.updateAvailable === true && r.latestVersion === '2.5.0', JSON.stringify(r));
  }

  // D1: escape hatch — nem fs nem rede são tocados
  {
    process.env.TOKEN_GUARD_UPDATE_CHECK = 'off';
    let fetchCalls = 0, cacheCalls = 0;
    const r = await UC.checkForUpdate(
      { localVersion: '2.3.2', cacheFile },
      {
        fetchLatest: async () => { fetchCalls++; return '2.4.0'; },
        readCache: () => { cacheCalls++; return null; },
        writeCache: () => { cacheCalls++; },
      }
    );
    delete process.env.TOKEN_GUARD_UPDATE_CHECK;
    check('D1a: checked:false reason:disabled', r.checked === false && r.reason === 'disabled');
    check('D1b: zero I/O (fetch e cache nunca chamados)', fetchCalls === 0 && cacheCalls === 0);
  }

  // E1: readCache/writeCache lançando erro não derrubam checkForUpdate
  {
    let threw = false;
    let r = null;
    try {
      r = await UC.checkForUpdate(
        { localVersion: '2.3.2', cacheFile },
        {
          readCache: () => { throw new Error('disco cheio'); },
          writeCache: () => { throw new Error('permissão negada'); },
          fetchLatest: async () => '2.4.0',
        }
      );
    } catch (e) { threw = true; }
    check('E1: deps de I/O lançando erro não derrubam checkForUpdate', !threw && r && r.checked === true, JSON.stringify(r));
  }

  console.log('\n  [camada F · wiring real de cli.cjs status/--version (E2E, sem rede)]');

  // F1/F2: com TOKEN_GUARD_UPDATE_CHECK=off, o processo real spawnado nunca deveria
  // imprimir a linha de aviso — determinístico, sem depender do registry real.
  {
    const cliPath = path.join(__dirname, '..', 'cli.cjs');
    const pkgVersion = require(path.join(__dirname, '..', 'package.json')).version;

    const statusOut = spawnSync(process.execPath, [cliPath, 'status'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, TOKEN_GUARD_UPDATE_CHECK: 'off' },
      encoding: 'utf8',
    });
    check('F1a: cli status sai com código 0', statusOut.status === 0, `status=${statusOut.status} stderr=${statusOut.stderr}`);
    check('F1b: cli status não imprime aviso de atualização (escape hatch)', !/disponível/.test(statusOut.stdout));
    check('F1c: cli status ainda imprime o bloco normal', /token-guard ·/.test(statusOut.stdout));

    const versionOut = spawnSync(process.execPath, [cliPath, '--version'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, TOKEN_GUARD_UPDATE_CHECK: 'off' },
      encoding: 'utf8',
    });
    check('F2a: cli --version sai com código 0', versionOut.status === 0, `status=${versionOut.status} stderr=${versionOut.stderr}`);
    check('F2b: cli --version imprime só a versão local (sem aviso)', versionOut.stdout.trim() === pkgVersion, JSON.stringify(versionOut.stdout));

    // F3: caminho POSITIVO (updateAvailable:true) — cache fresco pré-populado num HOME
    // falso (mesmo padrão de test/install.test.cjs), então checkForUpdate nunca bate
    // rede (cache dentro do TTL) e o texto exato do aviso é 100% determinístico.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-upd-home-'));
    fs.mkdirSync(path.join(fakeHome, '.token-guard'), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, '.token-guard', 'update-check.json'),
      JSON.stringify({ latestVersion: '9.9.9', checkedAt: Date.now() })
    );
    const fakeEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
    delete fakeEnv.TOKEN_GUARD_UPDATE_CHECK;

    const statusOn = spawnSync(process.execPath, [cliPath, 'status'], {
      cwd: path.join(__dirname, '..'),
      env: fakeEnv,
      encoding: 'utf8',
    });
    check('F3a: cli status sai com código 0 (caminho positivo)', statusOn.status === 0, `status=${statusOn.status} stderr=${statusOn.stderr}`);
    check(
      'F3b: cli status imprime o texto exato do aviso de atualização',
      statusOn.stdout.includes(`  atualização:     v9.9.9 disponível (você está na v${pkgVersion}) — npm i -g @allansantos-dev/token-guard`),
      JSON.stringify(statusOn.stdout)
    );

    const versionOn = spawnSync(process.execPath, [cliPath, '--version'], {
      cwd: path.join(__dirname, '..'),
      env: fakeEnv,
      encoding: 'utf8',
    });
    check('F3c: cli --version sai com código 0 (caminho positivo)', versionOn.status === 0, `status=${versionOn.status} stderr=${versionOn.stderr}`);
    check(
      'F3d: cli --version imprime o texto exato do aviso de atualização',
      versionOn.stdout.trim() === `${pkgVersion} (nova versão disponível: 9.9.9 — npm i -g @allansantos-dev/token-guard)`,
      JSON.stringify(versionOn.stdout)
    );

    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  }

  if (originalEnv === undefined) delete process.env.TOKEN_GUARD_UPDATE_CHECK;
  else process.env.TOKEN_GUARD_UPDATE_CHECK = originalEnv;

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log('');
  console.log(`  ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
}

main();
