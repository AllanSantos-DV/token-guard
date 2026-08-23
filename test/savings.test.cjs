#!/usr/bin/env node
'use strict';
/**
 * savings.test.cjs — trava a promessa central: os guards ECONOMIZAM.
 *
 * Se uma mudança futura nas regras fizer a economia líquida virar negativa,
 * zerar escapes em cenário canônico ou introduzir ruído em repo pequeno,
 * esta suíte falha antes do release. Simulação curta e determinística
 * (seed fixa), rodando o decide() REAL — não um modelo dele.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BENCH = path.join(__dirname, '..', 'bench', 'savings.cjs');

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

/* fixture mínimo compartilhado */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sav-test-'));
fs.mkdirSync(path.join(TMP, '.token-guard'), { recursive: true });
fs.writeFileSync(path.join(TMP, '.token-guard', 'repo-stats.json'),
  JSON.stringify({ totalFiles: 215112, pathChars: 215112 * 125 }));
fs.mkdirSync(path.join(TMP, 'src'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'src', 'BigService.java'), 'x'.repeat(200 * 1024));

console.log('\n  [economia líquida]');
{
  const B = require(BENCH);
  const guard = B.makeGuard(TMP);
  const runs = Object.entries(B.LEARN_RATE)
    .map(([name, p]) => ({ name, ...B.runBatch(name, p, { guard }, 60) }));

  for (const r of runs) {
    check(`perfil "${r.name}" tem economia líquida POSITIVA`,
      r.net > 0, `net=${Math.round(r.net)} tok`);
    check(`perfil "${r.name}" não deixa movimento canônico caro escapar`,
      r.passedExpensive === 0, `escapes=${r.passedExpensive}`);
    check(`perfil "${r.name}" overhead dos denies é ruído (<2% do evitado)`,
      r.denyOverhead < r.avoided * 0.02,
      `overhead=${Math.round(r.denyOverhead)} evitado=${Math.round(r.avoided)}`);
  }

  const [teimoso, normal, rapido] = runs;
  check('agente que aprende menos economiza mais (ordem dos perfis)',
    teimoso.net >= normal.net && normal.net >= rapido.net,
    `${Math.round(teimoso.net)} / ${Math.round(normal.net)} / ${Math.round(rapido.net)}`);

  /* repo pequeno: guards de VARREDURA desligados por design (blindRead segue
     ativo — ler 200 KB cego custa caro em qualquer repositório). */
  const SMALL = path.join(TMP, '..', path.basename(TMP) + '-small');
  fs.mkdirSync(path.join(SMALL, '.token-guard'), { recursive: true });
  fs.writeFileSync(path.join(SMALL, '.token-guard', 'repo-stats.json'),
    JSON.stringify({ totalFiles: 300, pathChars: 300 * 125 }));
  fs.mkdirSync(path.join(SMALL, 'src'), { recursive: true });
  fs.writeFileSync(path.join(SMALL, 'src', 'BigService.java'), 'x'.repeat(200 * 1024));
  const smallGuard = B.makeGuard(SMALL);

  check('repo pequeno: broadScan não dispara',
    smallGuard({ tool_name: 'Glob', tool_input: { pattern: '**/*' } }) === null);
  check('repo pequeno: shellDump não dispara',
    smallGuard({ tool_name: 'Bash', tool_input: { command: 'ls -R' } }) === null);
  check('repo pequeno: blindRead segue valendo (custo não depende do tamanho)',
    Boolean(smallGuard({ tool_name: 'View', tool_input: { path: 'src/BigService.java' } })));

  const small = B.runBatch('small', B.LEARN_RATE.normal,
    { root: SMALL, scale: { files: 300, lines: 60000 } }, 30);
  fs.rmSync(SMALL, { recursive: true, force: true });

  check('repo pequeno: nenhum falso positivo',
    small.fpDenied === 0, `fp=${small.fpDenied}`);
  /* Escapar da varredura aqui É o desenho ("abaixo de 400 arquivos o custo é
     irrelevante"): o pior caso inteiro tem que caber numa janela com folga. */
  check('repo pequeno: mesmo sem guard, o pior caso cabe numa janela',
    small.wasted < 200000, `wasted/sessão=${Math.round(small.wasted)} tok`);

  /* sensibilidade a FP: 25% de FPs ainda deixa economia sólida */
  const fp25 = B.runBatch('fp25', B.LEARN_RATE.normal, { guard, fpRate: 0.25 }, 60);
  check('com 25% de falsos positivos a economia segue positiva',
    fp25.net > 0, `net=${Math.round(fp25.net)} tok`);

  /* ganho médio por deny >> custo médio de um deny */
  const gainPerDeny = runs[1].avoided / Math.max(runs[1].deniedTrue, 1);
  check('cada bloqueio paga o próprio custo (ganho/deny > 5× overhead)',
    gainPerDeny > 5 * (900 / 4),
    `ganho=${Math.round(gainPerDeny)} tok`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* noop */ }

console.log('');
console.log(`  ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
