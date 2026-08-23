#!/usr/bin/env node
'use strict';
/**
 * contract.test.cjs — bateria do contrato de saída.
 *
 * O que precisa ser provado aqui não é o texto das regras (isso é editorial),
 * e sim as duas invariantes do mecanismo: cada seção entra no máximo uma vez
 * por sessão, e o gatilho vem de evidência acumulada — nunca da frase do
 * usuário. Uma sessão de prosa não pode receber regra de código.
 *
 * Node puro, sem framework, pelo mesmo motivo do resto do projeto: zero deps.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const CT = require('../lib/contract.cjs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-contract-'));
const ROOT = path.join(__dirname, '..');

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

const SAMPLE = `
# Cabeçalho que não é seção

Prosa solta, que não vira regra.

## sempre

- Primeira regra sempre.
- Regra que continua
  na linha seguinte.

## quando: codigo

- Regra de código.

## subagente

- Regra de subagente.

## Como editar

- Isto está numa seção sem gatilho e não deve virar regra.
`;

/* ================== parsing ================== */

console.log('\n  [parsing]');
{
  const c = CT.parse(SAMPLE);

  check('seções com gatilho viram regras', c.order.join(',') === 'sempre,codigo,subagente',
    `order = ${c.order.join(',')}`);
  check('seção sem gatilho é ignorada', !('como editar' in c.rules));
  check('prosa fora de item não vira regra', c.rules.sempre.length === 2,
    `sempre = ${JSON.stringify(c.rules.sempre)}`);
  check('item quebrado em várias linhas é reunido',
    c.rules.sempre[1] === 'Regra que continua na linha seguinte.',
    c.rules.sempre[1]);
  check('markdown vazio não quebra', CT.parse('').order.length === 0);
  check('entrada nula não quebra', CT.parse(null).order.length === 0);
}

/* ================== evidência ================== */

console.log('\n  [evidência]');
{
  check('nenhum arquivo tocado não gera gatilho', CT.triggersFor([]).length === 0);
  check('fonte gera codigo', CT.triggersFor(['lib/x.cjs']).join(',') === 'codigo');
  check('markdown gera docs', CT.triggersFor(['README.md']).join(',') === 'docs');

  const t = CT.triggersFor(['test/x.test.cjs']);
  check('arquivo de teste é teste E código', t.includes('teste') && t.includes('codigo'),
    t.join(','));
  check('pasta de teste conta mesmo sem sufixo', CT.triggersFor(['tests/helper.js']).includes('teste'));
  check('selftest.cjs na raiz conta como teste', CT.triggersFor(['selftest.cjs']).includes('teste'));

  check('caminho Windows é reconhecido',
    CT.triggersFor(['C:\\proj\\test\\a.cjs']).includes('teste'));
  check('extensão desconhecida não gera gatilho', CT.triggersFor(['dados.csv']).length === 0);
  check('caminho vazio é descartado', CT.triggersFor(['', null, undefined]).length === 0);
  check('lista de extensões pode ser trocada pelo chamador',
    CT.triggersFor(['a.zig'], { sourceExt: ['.zig'] }).join(',') === 'codigo');
}

/* ================== decisão ================== */

console.log('\n  [decisão]');
{
  const c = CT.parse(SAMPLE);

  const t1 = CT.decide({ contract: c });
  check('turno sem evidência recebe só a camada sempre', t1.triggers.join(',') === 'sempre');

  const t2 = CT.decide({ contract: c, touched: ['lib/a.cjs'], injected: t1.triggers });
  check('evidência de código traz a seção de código', t2.triggers.join(',') === 'codigo');

  const t3 = CT.decide({
    contract: c,
    touched: ['lib/a.cjs'],
    injected: [...t1.triggers, ...t2.triggers],
  });
  check('seção já injetada não volta', t3.triggers.length === 0 && t3.text === '');

  check('subagente nunca entra na sessão principal',
    !CT.decide({ contract: c, touched: ['lib/a.cjs'] }).triggers.includes('subagente'));

  /* O caso que motivou o desenho: tarefa de prosa não pode receber regra de código. */
  const prosa = CT.decide({ contract: c, touched: [] });
  check('sessão de prosa não recebe regra de código',
    !prosa.text.includes('Regra de código.'), prosa.text);

  check('contrato vazio decide nada',
    CT.decide({ contract: { rules: {}, order: [] } }).triggers.length === 0);
  check('chamada sem argumento não quebra', CT.decide().triggers.length === 0);
}

/* ================== render ================== */

console.log('\n  [render]');
{
  const c = CT.parse(SAMPLE);
  const text = CT.render(c, ['sempre', 'codigo']);

  check('render abre com afirmação, não com ordem',
    text.split('\n')[0] === 'Convenções de saída em vigor neste repositório:',
    text.split('\n')[0]);
  check('render respeita a ordem do contrato, não a do pedido',
    CT.render(c, ['codigo', 'sempre']) === text);
  check('render de gatilho inexistente é vazio', CT.render(c, ['inexistente']) === '');
  check('subagente rende separado', CT.subagentText(c).includes('Regra de subagente.'));

  /* Regra escrita como ordem imperativa vaza: o modelo mostra o texto em vez de seguir. */
  const imperativos = (CT.load(ROOT).rules.codigo || [])
    .filter((r) => /^(nunca|sempre|não |nao |jamais|evite|proíbo)/i.test(r));
  check('o contrato padrão não abre regra em modo imperativo',
    imperativos.length === 0, imperativos.join(' | '));
}

/* ================== carga ================== */

console.log('\n  [carga]');
{
  const base = CT.load(ROOT);
  check('contrato padrão do projeto carrega', base.order.includes('sempre') && base.order.includes('codigo'),
    base.order.join(','));
  check('a seção subagente existe no padrão', base.order.includes('subagente'));

  const proj = path.join(TMP, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'contract.md'), '## quando: codigo\n\n- Só a minha regra.\n', 'utf8');

  const over = CT.load(proj);
  check('contract.md do projeto substitui a seção inteira',
    over.rules.codigo.length === 1 && over.rules.codigo[0] === 'Só a minha regra.',
    JSON.stringify(over.rules.codigo));
  check('seção não mencionada continua vindo do padrão',
    (over.rules.sempre || []).length > 1);
  check('a fonte carregada é reportada', String(over._source).endsWith('contract.md'));

  fs.writeFileSync(path.join(proj, 'contract.md'), '# Só prosa, sem seção\n', 'utf8');
  check('contract.md sem seção cai para o padrão sem quebrar',
    (CT.load(proj).rules.codigo || []).length > 1);

  const antes = process.env.TOKEN_GUARD;
  process.env.TOKEN_GUARD = 'off';
  check('TOKEN_GUARD=off zera o contrato', CT.load(ROOT).order.length === 0);
  if (antes === undefined) delete process.env.TOKEN_GUARD; else process.env.TOKEN_GUARD = antes;
}

/* ================== estado ================== */

console.log('\n  [estado]');
{
  const root = path.join(TMP, 'estado');
  fs.mkdirSync(root, { recursive: true });

  check('sessão desconhecida começa sem nada injetado',
    CT.readState(root, 'nova').injected.length === 0);

  CT.writeState(root, 'sess-1', { injected: ['sempre'] });
  check('estado sobrevive à ida ao disco',
    CT.readState(root, 'sess-1').injected.join(',') === 'sempre');

  check('sessões não se misturam', CT.readState(root, 'sess-2').injected.length === 0);

  /* O id vem do IDE: tratar como caminho confiável colocaria o estado fora do repo. */
  CT.writeState(root, '../../fuga', { injected: ['sempre'] });
  const dir = path.join(root, '.token-guard', 'sessions');
  check('id de sessão não escapa do diretório de estado',
    fs.readdirSync(dir).every((f) => !/[\/]/.test(f)) && !fs.existsSync(path.join(root, '..', 'fuga.json')),
    fs.readdirSync(dir).join(','));

  /* ids distintos sanitizados para o MESMO nome não podem compartilhar estado */
  CT.writeState(root, 'sess/1', { injected: ['sempre'] });
  const colisao = CT.readState(root, 'sess:1');
  check('ids diferentes com mesma sanitização NÃO colidem',
    !fs.existsSync(path.join(root, '.token-guard', 'sessions', 'sess_1.json')) ||
    colisao.injected.length === 0,
    `sess:1 leu ${JSON.stringify(colisao)}`);

  const podre = path.join(dir, 'antiga.json');
  fs.writeFileSync(podre, '{"injected":["sempre"]}', 'utf8');
  const velho = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.utimesSync(podre, velho / 1000, velho / 1000);
  CT.pruneState(dir);
  check('estado de sessão velha é podado', !fs.existsSync(podre));
  check('estado recente sobrevive à poda', fs.existsSync(path.join(dir, 'sess-1.json')));

  fs.writeFileSync(path.join(dir, 'corrompido.json'), '{ não é json', 'utf8');
  check('estado corrompido é tratado como vazio',
    CT.readState(root, 'corrompido').injected.length === 0);
}

/* ================================================================== */

console.log('');
console.log('  ' + '─'.repeat(72));
console.log(`  ${pass} passaram · ${fail} falharam`);
console.log('');

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

process.exit(fail ? 1 : 0);
