#!/usr/bin/env node
'use strict';
/**
 * statedir.test.cjs — o estado só nasce no projeto de origem da sessão; pasta visitada fica vazia.
 */

const { ISOLATED_HOME } = require('./bootstrap.cjs');

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SD = require('../lib/statedir.cjs');
const CT = require('../lib/contract.cjs');
const DUP = require('../lib/dupread.cjs');
const SCOUT = require('../lib/scout.cjs');
const CW = require('../lib/ctxwatch.cjs');
const AUDIT = require('../lib/audit.cjs');
const CFG = require('../lib/config.cjs');
const { postProcess } = require('../lib/postresult.cjs');

const POST = path.join(__dirname, '..', 'adapters', 'post-hook.cjs');

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass += 1; console.log(`  ok    ${label}`); } else {
    fail += 1;
    console.log(`  FALHA ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

function listAll(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(path.relative(dir, p));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-statedir-'));
const mk = (p, ...marks) => {
  fs.mkdirSync(p, { recursive: true });
  for (const m of marks) fs.mkdirSync(path.join(p, m), { recursive: true });
  return p;
};
const BIG = 'x'.repeat(40000);
const cfg = CFG.load(TMP);

/** Aciona cada escritor de estado com `root` e a sessão dada. */
function touchEveryWriter(root, sid) {
  CT.writeState(root, sid, { injected: ['sempre'] });
  CT.noteTouched(root, sid, { file_path: 'a.js' });
  DUP.dedupe({ name: 'Read', input: { file_path: path.join(TMP, 'a.txt') }, result: 'y'.repeat(4000), root, sessionId: sid, cfg });
  SCOUT.withBurst(null, { name: 'Read', input: { file_path: 'a' }, root, sessionId: sid, cfg });
  const transcript = path.join(TMP, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ message: { role: 'assistant', model: 'm', usage: { input_tokens: 900000 } } }) + '\n');
  CW.check({ root, sessionId: sid, transcriptPath: transcript });
  postProcess({ name: 'Grep', input: {}, result: BIG, root, cfg, target: 'claude', sessionId: sid });
}

console.log('\n  [resolvedor]');
{
  const desktop = mk(path.join(ISOLATED_HOME, 'Desktop'));
  const proj = mk(path.join(TMP, 'proj'), '.git');
  const sub = mk(path.join(proj, 'src', 'deep'));
  const loose = mk(path.join(TMP, 'solta'));
  fs.writeFileSync(path.join(ISOLATED_HOME, 'package.json'), '{}');

  check('projeto com .git guarda o estado em <projeto>/.token-guard',
    SD.stateDir(proj) === path.join(proj, '.token-guard'));
  check('subpasta do projeto cai no mesmo estado do projeto',
    SD.stateDir(sub) === path.join(proj, '.token-guard'));
  check('pasta solta sem marcador vai para a pasta de dados', SD.stateDir(loose).startsWith(SD.dataHome()));
  check('Área de Trabalho vai para a pasta de dados', SD.stateDir(desktop).startsWith(SD.dataHome()));
  check('marcador na home não faz da home um projeto',
    SD.projectRoot(desktop) === null && SD.projectRoot(ISOLATED_HOME) === null);
  check('pasta sob AppData ou node_modules nunca é projeto',
    SD.projectRoot(mk(path.join(TMP, 'x', 'node_modules', 'pkg'), '.git')) === null);
  check('raiz do disco nunca é projeto', SD.projectRoot(path.parse(TMP).root) === null);
  check('pastas distintas sem marcador não dividem estado', SD.stateDir(loose) !== SD.stateDir(desktop));
}

console.log('\n  [pasta visitada fica vazia]');
{
  const visited = mk(path.join(ISOLATED_HOME, 'Documents', 'visitada'));
  touchEveryWriter(visited, 'sess-visita');
  const again = listAll(visited).length;
  touchEveryWriter(visited, 'sess-visita');
  check('nenhum escritor cria entrada na pasta que não é projeto', listAll(visited).length === 0, listAll(visited).join(','));
  check('segunda rodada não cria nada novo', again === 0 && listAll(visited).length === 0);
  const data = SD.stateDir(visited);
  check('o estado foi para a pasta de dados', fs.existsSync(path.join(data, 'sessions')) && fs.existsSync(path.join(data, 'results')),
    fs.existsSync(data) ? listAll(data).join(',') : 'pasta de dados ausente');
  check('repo-stats de auditoria fora de projeto também vai para a pasta de dados',
    AUDIT.writeCache(visited, { stats: { a: 1 }, derived: {} }) && fs.existsSync(path.join(SD.stateDir(visited), 'repo-stats.json'))
      && listAll(visited).length === 0);
}

console.log('\n  [sessão nascida no projeto]');
{
  const proj = mk(path.join(TMP, 'origem'), '.git');
  const other = mk(path.join(TMP, 'outro-projeto'), '.git');
  const visited = mk(path.join(ISOLATED_HOME, 'Desktop', 'visitada'));
  touchEveryWriter(proj, 'sess-nasceu');
  touchEveryWriter(other, 'sess-nasceu');
  touchEveryWriter(visited, 'sess-nasceu');
  check('depois de navegar para outro projeto, o estado segue no de origem',
    !fs.existsSync(path.join(other, '.token-guard')), listAll(other).join(','));
  check('depois de navegar para pasta solta, ela fica vazia e o estado segue na origem',
    listAll(visited).length === 0 && fs.existsSync(path.join(proj, '.token-guard', 'sessions', 'sess-nasceu.json')));
  check('subagente (id~agente) usa a origem do pai', SD.stateDir(other, 'sess-nasceu~ag1') === path.join(proj, '.token-guard'));
  check('sessão diferente não herda a origem', SD.stateDir(other, 'sess-outra') === path.join(other, '.token-guard'));
}

console.log('\n  [hook real com cwd mudando]');
{
  const proj = mk(path.join(TMP, 'real'), '.git');
  const visited = mk(path.join(ISOLATED_HOME, 'Desktop', 'C++'));
  const run = (cwd, sid) => spawnSync(process.execPath, [POST], {
    input: JSON.stringify({ cwd, session_id: sid, tool_name: 'Grep', tool_input: { pattern: 'a' }, tool_response: BIG }),
    encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  const r1 = run(proj, 'sess-real');
  const r2 = run(visited, 'sess-real');
  check('post-hook responde nas duas chamadas', r1.status === 0 && r2.status === 0, r1.stderr + r2.stderr);
  check('a pasta visitada pelo agente continua vazia depois do post-hook', listAll(visited).length === 0, listAll(visited).join(','));
  check('o resultado integral foi para o projeto de origem',
    fs.existsSync(path.join(proj, '.token-guard', 'results')) && fs.readdirSync(path.join(proj, '.token-guard', 'results')).length >= 2);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n  ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
