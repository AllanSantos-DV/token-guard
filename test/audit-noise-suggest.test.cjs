'use strict';
/**
 * audit-noise-suggest.test.cjs — o audit sugere `noiseDirsExtra` só como texto.
 *
 * Invariantes:
 *   · diretório de topo pesado, com muitos arquivos e nenhum código-fonte é sugerido;
 *   · diretório com código-fonte, diretório já tratado como ruído, diretório leve e poucos arquivos não são;
 *   · a sugestão sai impressa com o trecho do config e o aviso de que nada foi alterado;
 *   · sem candidato, o relatório não ganha a seção;
 *   · rodar o audit não grava config nem altera o repositório medido.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const AUDIT = require('../lib/audit.cjs');
const CFG = require('../lib/config.cjs');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : ''}`);
}

function put(root, rel, bytes) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(bytes));
}

function many(root, dir, count, bytes, ext) {
  for (let i = 0; i < count; i++) put(root, `${dir}/f${i}${ext}`, bytes);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-audit-suggest-'));
many(root, 'gerado', 30, 4000, '.dat');
many(root, 'src', 30, 500, '.js');
many(root, 'misto', 30, 4000, '.dat');
put(root, 'misto/um.js', 10);
many(root, 'node_modules', 30, 4000, '.dat');
many(root, 'poucos', 3, 90000, '.dat');
many(root, 'leve', 25, 10, '.dat');

const cfg = CFG.load(root, 'claude');
const result = AUDIT.scan(root, cfg);
const dirs = result.noiseSuggestions.map((s) => s.dir);

check('sugere o diretório pesado sem código-fonte', dirs.includes('gerado'), dirs);
check('não sugere diretório com código-fonte', !dirs.includes('src'), dirs);
check('não sugere diretório com um só arquivo de código-fonte entre os dados', !dirs.includes('misto'), dirs);
check('não sugere o que já é ruído por padrão', !dirs.includes('node_modules'), dirs);
check('não sugere diretório com poucos arquivos', !dirs.includes('poucos'), dirs);
check('não sugere diretório leve', !dirs.includes('leve'), dirs);
check('a sugestão traz contagem e volume', result.noiseSuggestions[0].files === 30 && result.noiseSuggestions[0].bytes === 120000, result.noiseSuggestions[0]);

const text = AUDIT.renderText(result, cfg);
check('o texto traz a seção de sugestão', /SUGESTÃO — diretórios pesados sem código-fonte/.test(text));
check('o texto traz o trecho do config pronto', text.includes('"noiseDirsExtra": ["gerado"]'), text.slice(-700));
check('o texto avisa que nada foi alterado', /nada foi alterado/.test(text));

const applied = AUDIT.scan(root, CFG.load(root, 'claude'));
check('sem opção de aplicar: o scan seguinte ainda sugere', applied.noiseSuggestions.some((s) => s.dir === 'gerado'));
check('o audit não grava token-guard.config.json no repositório', !fs.existsSync(path.join(root, CFG.CONFIG_NAME)));

const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-audit-quiet-'));
many(quiet, 'src', 30, 500, '.js');
const quietCfg = CFG.load(quiet, 'claude');
const quietResult = AUDIT.scan(quiet, quietCfg);
check('sem candidato: lista vazia', quietResult.noiseSuggestions.length === 0, quietResult.noiseSuggestions);
check('sem candidato: o relatório não ganha a seção', !/SUGESTÃO/.test(AUDIT.renderText(quietResult, quietCfg)));

const markdown = AUDIT.renderMarkdown(result, cfg);
check('o markdown segue válido (tabela de diretórios intacta)', /\| `gerado` \|/.test(markdown));

fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(quiet, { recursive: true, force: true });

console.log(`\n  audit-noise-suggest: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
