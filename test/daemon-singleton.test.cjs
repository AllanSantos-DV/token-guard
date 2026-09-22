'use strict';

require('./bootstrap.cjs');

const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
const DL = require('../lib/daemon-lifecycle.cjs');

let pass = 0;
let fail = 0;

function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
}

/** Filesystem mockado em memória — prova a lógica pura sem tocar disco/pipe real. */
function mockDeps(initialFiles) {
  const store = { ...(initialFiles || {}) };
  const alive = new Set();
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(store, p),
    readFile: (p) => {
      if (!(p in store)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return store[p];
    },
    writeFile: (p, s) => { store[p] = s; },
    mkdirp: () => {},
    isAlive: (pid) => alive.has(pid),
    _store: store,
    _alive: alive,
  };
}

(async () => {
  // --- acquireLock: lock ausente -> adquire livre ---
  {
    const deps = mockDeps();
    const r = DL.acquireLock({ lockFile: '/lock', pid: 111, protocolVersion: 1, packageVersion: '2.3.0' }, deps);
    check('lock ausente: acquired=true', r.acquired === true);
    check('lock ausente: reclaimedStale=false', r.reclaimedStale === false);
    check('lock ausente: grava o record', JSON.parse(deps._store['/lock']).pid === 111);
  }

  // --- acquireLock: segunda start concorrente com pid vivo -> recusa ---
  {
    const deps = mockDeps({ '/lock': JSON.stringify({ pid: 999, protocolVersion: 1, packageVersion: '2.3.0' }) });
    deps._alive.add(999);
    const r = DL.acquireLock({ lockFile: '/lock', pid: 222, protocolVersion: 1, packageVersion: '2.3.0' }, deps);
    check('pid vivo: acquired=false', r.acquired === false);
    check('pid vivo: reason=alive', r.reason === 'alive');
    check('pid vivo: existing.pid preservado', r.existing.pid === 999);
    check('pid vivo: NÃO sobrescreve o lock', JSON.parse(deps._store['/lock']).pid === 999);
  }

  // --- acquireLock: lock de daemon morto -> reclama como stale ---
  {
    const deps = mockDeps({ '/lock': JSON.stringify({ pid: 888, protocolVersion: 1, packageVersion: '2.3.0' }) });
    // pid 888 NÃO está em deps._alive -> isAlive() retorna false
    const r = DL.acquireLock({ lockFile: '/lock', pid: 333, protocolVersion: 1, packageVersion: '2.3.0' }, deps);
    check('pid morto: acquired=true', r.acquired === true);
    check('pid morto: reclaimedStale=true', r.reclaimedStale === true);
    check('pid morto: sobrescreve com o novo pid', JSON.parse(deps._store['/lock']).pid === 333);
  }

  // --- readLockRecord: corrupção/campos ausentes -> recuperação silenciosa (null) ---
  {
    const deps = mockDeps({ '/bad1': 'isto não é json', '/bad2': JSON.stringify({ pid: 1 }) });
    check('JSON corrompido: retorna null', DL.readLockRecord('/bad1', deps) === null);
    check('campos ausentes: retorna null', DL.readLockRecord('/bad2', deps) === null);
    check('arquivo inexistente: retorna null', DL.readLockRecord('/nope', deps) === null);
  }

  // --- checkHandshake ---
  {
    const expected = { protocolVersion: 1, packageVersion: '2.3.0' };
    check('handshake ok: versões batem', DL.checkHandshake({ protocolVersion: 1, packageVersion: '2.3.0' }, expected).ok === true);
    const protoMismatch = DL.checkHandshake({ protocolVersion: 2, packageVersion: '2.3.0' }, expected);
    check('handshake protocolo diferente: ok=false', protoMismatch.ok === false);
    check('handshake protocolo diferente: reason correto', protoMismatch.reason === 'protocol-mismatch');
    const verMismatch = DL.checkHandshake({ protocolVersion: 1, packageVersion: '2.2.2' }, expected);
    check('handshake versão diferente: ok=false', verMismatch.ok === false);
    check('handshake versão diferente: reason correto', verMismatch.reason === 'version-mismatch');
    const noReply = DL.checkHandshake(null, expected);
    check('handshake sem resposta: ok=false', noReply.ok === false);
    check('handshake sem resposta: reason correto', noReply.reason === 'no-reply');
  }

  // --- isSingletonConflict ---
  {
    check('EADDRINUSE é conflito de singleton', DL.isSingletonConflict({ code: 'EADDRINUSE' }) === true);
    check('EACCES NÃO é conflito de singleton', DL.isSingletonConflict({ code: 'EACCES' }) === false);
    check('erro sem code NÃO é conflito', DL.isSingletonConflict({}) === false);
    check('null/undefined NÃO é conflito', DL.isSingletonConflict(null) === false && DL.isSingletonConflict(undefined) === false);
  }

  // --- Live: dois listeners reais no MESMO endpoint -> segundo falha com o
  // código que isSingletonConflict reconhece. Prova a suposição real desta
  // máquina/plataforma, não só a lógica pura acima. ---
  {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-singleton-'));
    const endpoint = process.platform === 'win32'
      ? `\\\\.\\pipe\\token-guard-singleton-test-${process.pid}`
      : path.join(tmpBase, 'test.sock');

    const s1 = net.createServer();
    await new Promise((res, rej) => { s1.once('error', rej); s1.listen(endpoint, res); });

    const s2 = net.createServer();
    const conflictErr = await new Promise((res) => {
      s2.once('error', (err) => res(err));
      s2.listen(endpoint, () => res(null));
    });

    check('segundo listen no mesmo endpoint falha', conflictErr !== null, conflictErr ? '' : 'segundo listen teve sucesso inesperadamente');
    check('erro real reconhecido por isSingletonConflict', conflictErr ? DL.isSingletonConflict(conflictErr) : false, conflictErr ? `code=${conflictErr.code}` : '');

    s1.close();
    try { s2.close(); } catch { /* pode já estar fechado */ }
    if (process.platform !== 'win32') { try { fs.unlinkSync(endpoint); } catch { /* noop */ } }
    try { fs.rmdirSync(tmpBase); } catch { /* noop */ }
  }

  // --- Live (POSIX): socket órfão SEM lock-record correspondente (cenário do
  // achado CRITICAL da revisão independente F4 — lock apagado/corrompido mas
  // o arquivo de socket de um daemon morto sobrevive). Prova que `start()`
  // sonda com uma conexão real, confirma que não há ninguém do outro lado, e
  // reclama o socket em vez de desistir com um falso "já em execução"
  // permanente. Roda num processo filho pra não arriscar que um
  // `process.exit()` de dentro de `start()` mascare uma falha como sucesso. ---
  if (process.platform !== 'win32') {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-orphan-'));
    const endpoint = path.join(tmpBase, 'orphan.sock');
    fs.writeFileSync(endpoint, ''); // arquivo órfão: existe, mas ninguém escuta nele

    const daemonServerPath = path.join(__dirname, '..', 'adapters', 'daemon-server.cjs');
    const script = `
      const DS = require(${JSON.stringify(daemonServerPath)});
      const server = DS.start(${JSON.stringify(endpoint)});
      if (!server) { console.log('FAIL:no-server'); process.exit(1); }
      server.once('listening', () => { console.log('OK:listening'); server.close(() => process.exit(0)); });
      setTimeout(() => { console.log('FAIL:timeout'); process.exit(1); }, 3000);
    `;
    // Nenhum listener de 'error' extra aqui — de propósito. \`start()\` já
    // trata 'error' internamente com retry ASSÍNCRONO (probe via
    // net.connect); um listener adicional no MESMO server receberia o
    // primeiro EADDRINUSE (transitório, esperado) e chamaria process.exit()
    // ANTES do retry assíncrono da produção rodar — matando o processo cedo
    // e mascarando o mecanismo real de reclaim como se tivesse falhado
    // (achado da rodada 8 de revisão independente F4). Replica exatamente
    // como o entrypoint real invoca start() (linha `if (require.main ===
    // module) start();`): sem listener concorrente algum.
    let out = '';
    try {
      out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
    } catch (err) {
      // Só stdout real do filho — nunca err.message: o texto-fonte do script
      // `-e` (que contém literalmente a string 'OK:listening') pode vazar
      // pro err.message do Node em alguns formatos de diagnóstico, dando
      // falso-positivo mesmo quando o filho morreu sem nunca ter escutado
      // de verdade (achado da rodada 8).
      out = err.stdout || '';
    }
    check('socket órfão sem lock-record: reclama e escuta', out.includes('OK:listening'), out.trim());

    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* noop */ }
  }

  // --- Live (POSIX): DOIS processos disputando o reclaim do MESMO socket
  // órfão ao mesmo tempo — a race exata encontrada pela rodada 2 de revisão
  // independente F4 sobre o fix acima (um mutex de arquivo `wx` serializa o
  // trecho crítico). Prova empiricamente que só um vira daemon vivo. ---
  if (process.platform !== 'win32') {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-orphan-race-'));
    const endpoint = path.join(tmpBase, 'race.sock');
    fs.writeFileSync(endpoint, '');

    const daemonServerPath = path.join(__dirname, '..', 'adapters', 'daemon-server.cjs');
    const raceScript = `
      const DS = require(${JSON.stringify(daemonServerPath)});
      const server = DS.start(${JSON.stringify(endpoint)});
      if (!server) { process.exit(1); }
      server.once('listening', () => {
        console.log('OK:listening');
        // Linger antes de fechar: fechar na hora recria o mesmo socket órfão
        // que este teste está tentando reclamar, dando ao irmão mais lento uma
        // janela pra reclamar de novo "legitimamente" (ele já morreu de
        // verdade) e imprimir OK:listening também — 2 vencedores sem que a
        // lógica de produção tenha corrido errado. O daemon real nunca fecha
        // sozinho assim; este atraso só reproduz esse fato no teste.
        setTimeout(() => server.close(() => process.exit(0)), 800);
      });
      setTimeout(() => process.exit(1), 3000);
    `;
    // Sem listener de 'error' extra — mesma razão do teste acima: deixa o
    // retry assíncrono interno de start() rodar até o fim (rodada 8).
    const runChild = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', raceScript]);
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });

    const [r1, r2] = await Promise.all([runChild(), runChild()]);
    const winners = [r1, r2].filter((r) => r.out.includes('OK:listening'));
    check('corrida de reclaim: exatamente um vencedor vira daemon', winners.length === 1, `vencedores=${winners.length} (out1=${r1.out.trim()}, out2=${r2.out.trim()})`);
    check('corrida de reclaim: ambos processos saem sem crash (código 0)', r1.code === 0 && r2.code === 0, `codes=${r1.code},${r2.code}`);

    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* noop */ }
  }

  // --- Live (POSIX): corrida no caminho de ROUBO de mutex órfão (não no de
  // criação `wx` livre) — o achado da rodada 4 de revisão independente F4.
  // Pré-popula `${endpoint}.reclaim` com um pid MORTO (nunca existiu de
  // verdade), então sobe DOIS processos concorrentes contra o mesmo socket
  // órfão: ambos vão bater no branch de "dono morto, posso roubar" a partir
  // do mesmo snapshot — exatamente o cenário que expôs o TOCTOU (revalidação
  // do conteúdo antes do unlink corrige). Sem essa revalidação, os dois
  // podiam concluir sucesso e entrar juntos na seção crítica. ---
  if (process.platform !== 'win32') {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-orphan-steal-'));
    const endpoint = path.join(tmpBase, 'steal.sock');
    fs.writeFileSync(endpoint, '');
    // pid improvável de estar vivo nesta máquina: garante isAlive()===false
    // sem depender de nenhum processo real ter morrido de propósito.
    const deadPid = 999999;
    fs.writeFileSync(`${endpoint}.reclaim`, String(deadPid));

    const daemonServerPath = path.join(__dirname, '..', 'adapters', 'daemon-server.cjs');
    const stealScript = `
      const DS = require(${JSON.stringify(daemonServerPath)});
      const server = DS.start(${JSON.stringify(endpoint)});
      if (!server) { process.exit(1); }
      server.once('listening', () => {
        console.log('OK:listening');
        // Mesmo linger do teste de corrida acima e pelo mesmo motivo: sem
        // isto, o vencedor fecha rápido demais e o irmão mais lento reclama
        // de novo um socket que só ficou órfão porque o teste, não a
        // produção, derrubou o vencedor cedo demais.
        setTimeout(() => server.close(() => process.exit(0)), 800);
      });
      setTimeout(() => process.exit(1), 3000);
    `;
    // Sem listener de 'error' extra — mesma razão dos dois testes acima.
    const runStealChild = () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', stealScript]);
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });

    const [s1, s2] = await Promise.all([runStealChild(), runStealChild()]);
    const stealWinners = [s1, s2].filter((r) => r.out.includes('OK:listening'));
    check('corrida de roubo de mutex morto: exatamente um vencedor vira daemon', stealWinners.length === 1, `vencedores=${stealWinners.length} (out1=${s1.out.trim()}, out2=${s2.out.trim()})`);
    check('corrida de roubo de mutex morto: ambos processos saem sem crash (código 0)', s1.code === 0 && s2.code === 0, `codes=${s1.code},${s2.code}`);

    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* noop */ }
  }

  console.log(`\n  daemon-singleton: ${pass} passaram · ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
