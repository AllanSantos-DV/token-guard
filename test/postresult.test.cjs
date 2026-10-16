#!/usr/bin/env node
'use strict';
/**
 * postresult.test.cjs — a camada de saída: truncar SEM perder o destino.
 *
 * Invariantes provados aqui:
 *   · acima do limite → trunca, salva o integral em disco e ensina;
 *   · abaixo do limite / desligada / falha → null (passa intacto);
 *   · fail-open absoluto: objeto circular, root impossível — nunca lança.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');

const PR = require('../lib/postresult.cjs');

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

function cfg(over = {}) {
  return {
    rules: { bigResult: true },
    limits: { resultCharsWithoutTrim: 1000, resultTrimKeepChars: 400 },
    ...over,
  };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-post-'));

console.log('\n  [bigResult]');

{
  const big = 'x'.repeat(5000);
  const r = PR.postProcess({ name: 'Grep', input: {}, result: big, root: TMP, cfg: cfg() });

  check('resultado acima do limite é truncado',
    Boolean(r) && r.modifiedResult.length < 2000);
  check('cabeça E cauda preservadas no corte',
    r.modifiedResult.startsWith('xxx') && r.modifiedResult.endsWith('xxx'));
  check('texto integral gravado em disco',
    fs.existsSync(r.savedTo) && fs.statSync(r.savedTo).size === 5000);
  check('mensagem ensina a alternativa da família (grep)',
    /files_with_matches|head_limit/.test(r.additionalContext) && /PT-BR/.test(r.additionalContext));
}

{
  const r = PR.postProcess({ name: 'Bash', input: {}, result: 'x'.repeat(5000), root: TMP, cfg: cfg() });
  check('shell recebe dica de pipe/redirect', /\| head -50|Select-Object/.test(r.additionalContext));
}

{
  check('resultado pequeno passa intacto',
    PR.postProcess({ name: 'View', input: {}, result: 'curto', root: TMP, cfg: cfg() }) === null);
  check('null/undefined passa intacto',
    PR.postProcess({ name: 'View', input: {}, result: null, root: TMP, cfg: cfg() }) === null);
  check('regra desligada passa intacto',
    PR.postProcess({ name: 'View', input: {}, result: 'x'.repeat(5000), root: TMP,
      cfg: { rules: { bigResult: false }, limits: {} } }) === null);

  /* Config lixo NÃO pode ligar o truncamento universal (regressão do gate):
     limite inválido cai no default; bigResult em string "false" desliga. */
  const garbage = PR.postProcess({ name: 'View', input: {}, result: 'curto',
    root: TMP, cfg: { rules: { bigResult: true },
      limits: { resultCharsWithoutTrim: 'abc', resultTrimKeepChars: -4 } } });
  check('limite de config inválido cai no default (não trunca tudo)',
    garbage === null);
  const strOff = PR.postProcess({ name: 'View', input: {}, result: 'x'.repeat(50000),
    root: TMP, cfg: { rules: { bigResult: 'false' }, limits: {} } });
  check('bigResult:"false" (string) desliga a regra', strOff === null);
}

{
  /* cfg SEM limits nenhum: defaults garantem que a regra FUNCIONA
     (antes: TypeError engolido = regra silenciosamente morta). */
  const r = PR.postProcess({ name: 'Grep', input: {}, result: 'x'.repeat(40000),
    root: TMP, cfg: { rules: { bigResult: true } } });
  check('cfg sem limits usa defaults e trunca', Boolean(r) &&
    r.modifiedResult.length < 40000);
}

{
  const circular = {};
  circular.self = circular;
  let threw = false;
  let r;
  try {
    r = PR.postProcess({ name: 'Bash', input: {}, result: circular, root: TMP, cfg: cfg() });
  } catch {
    threw = true;
  }
  check('objeto circular não lança (fail-open)', !threw && r === null);
}

{
  let threw = false;
  try {
    PR.postProcess({ name: 'View', input: {}, result: 'x'.repeat(5000),
      root: path.join(TMP, 'no', 'such', 'dir'), cfg: {} }); // sem limits: usa defaults
  } catch {
    threw = true;
  }
  check('root inexistente não lança (cria árvore ou falha aberta)', !threw);
}

{
  // Resultado-objeto (formato SDK): stub com preview + caminho do integral.
  const r = PR.postProcess({
    name: 'grep_search', input: {},
    result: { matches: Array.from({ length: 800 }, (_, i) => ({ line: i, text: 'y'.repeat(20) })) },
    root: TMP, cfg: cfg(),
  });
  check('resultado-objeto vira stub com preview e caminho',
    Boolean(r) && r.modifiedResult.token_guard_truncated === true &&
    typeof r.modifiedResult.full_output_file === 'string' &&
    fs.existsSync(r.modifiedResult.full_output_file));
}

{
  // Read de imagem no Claude Code: o base64 não é texto que entra na janela
  // (o modelo recebe a imagem). Medir os bytes dele era o B4.
  const b64 = 'A'.repeat(400000);
  const r = PR.postProcess({
    name: 'Read', input: { file_path: 'x.png' },
    result: { type: 'image', file: { base64: b64, type: 'image/png', originalSize: 300000 } },
    root: TMP, cfg: cfg(),
  });
  check('imagem (base64) não dispara bigResult', r === null, r && r.additionalContext);
}

{
  // Copilot: toolResult é SEMPRE ToolResultObject. A substituição tem de
  // continuar válida (textResultForLlm + resultType) e preservar o binário.
  const bin = [{ type: 'image', mimeType: 'image/png', data: 'B'.repeat(400000) }];
  const small = PR.postProcess({
    name: 'view', input: {},
    result: { textResultForLlm: 'ok', binaryResultsForLlm: bin, resultType: 'success' },
    root: TMP, cfg: cfg(),
  });
  check('Copilot: binário grande com texto curto não dispara', small === null,
    small && small.additionalContext);

  const big = PR.postProcess({
    name: 'grep', input: {},
    result: { textResultForLlm: 'z'.repeat(5000), binaryResultsForLlm: bin, resultType: 'success' },
    root: TMP, cfg: cfg(),
  });
  const m = big && big.modifiedResult;
  check('Copilot: texto grande vira ToolResultObject válido (texto truncado, binário e resultType preservados)',
    Boolean(m) && typeof m.textResultForLlm === 'string' && m.textResultForLlm.length < 2000 &&
    m.resultType === 'success' && m.binaryResultsForLlm === bin,
    JSON.stringify(m && Object.keys(m)));
  check('Copilot: integral salvo é o texto, não o JSON com base64',
    Boolean(big) && fs.readFileSync(big.savedTo, 'utf8') === 'z'.repeat(5000));
}

{
  // Objeto que o harness não substitui (Bash no Claude Code devolve
  // {stdout,...}): a mensagem não pode afirmar que truncou.
  const r = PR.postProcess({
    name: 'Bash', input: {},
    result: { stdout: 'w'.repeat(5000), stderr: '', interrupted: false },
    root: TMP, cfg: cfg(),
  });
  check('objeto não substituível: mensagem não diz "Truncated"',
    Boolean(r) && !/Truncated|truncada/.test(r.additionalContext) && fs.existsSync(r.savedTo),
    r && r.additionalContext.slice(0, 160));
}

{
  // Edit/Write: o tool_response traz o arquivo original inteiro, mas o modelo
  // só recebe a confirmação curta — não é saída que entra na janela.
  const r = PR.postProcess({
    name: 'Edit', input: { file_path: 'a.cjs' },
    result: { filePath: 'a.cjs', oldString: 'a', newString: 'b', originalFile: 'o'.repeat(40000), structuredPatch: [] },
    root: TMP, cfg: cfg(),
  });
  const w = PR.postProcess({
    name: 'Write', input: { file_path: 'b.cjs' },
    result: { type: 'create', filePath: 'b.cjs', content: 'c'.repeat(40000) },
    root: TMP, cfg: cfg(),
  });
  check('Edit/Write com arquivo grande não disparam bigResult', r === null && w === null,
    (r || w || {}).additionalContext);
}

{
  // Bash do Claude Code: bashEditDiff (diff dos arquivos que o comando editou)
  // só aparece na interface; o modelo recebe stdout/stderr.
  const r = PR.postProcess({
    name: 'Bash', input: { command: 'python edit.py' },
    result: { stdout: 'ok', stderr: '', interrupted: false, isImage: false,
      bashEditDiff: { files: [{ path: 'a.md', diff: 'd'.repeat(40000) }] } },
    root: TMP, cfg: cfg(),
  });
  check('bashEditDiff (só interface) não dispara bigResult', r === null, r && r.additionalContext);
}

{
  // Shell: erro no MEIO de log longo precisa sobreviver ao corte (início + fim
  // + linhas-sinal); Read e MCP continuam com o corte início+fim.
  const noise = (n) => Array.from({ length: n }, (_, i) => `step ${i} ok`).join('\n');
  const log = noise(400) + '\nnot ok 7 - parser quebra com entrada vazia\n' +
    '  Error: expected 3 got 4\n' + noise(400) + '\nFAIL test/b.test.js\n' + noise(10) + '\nfim do log';
  const c = cfg({ limits: { resultCharsWithoutTrim: 1000, resultTrimKeepChars: 2000 } });
  const sh = PR.postProcess({ name: 'Bash', input: {}, result: log, root: TMP, cfg: c });
  const m = sh && sh.modifiedResult;
  check('shell: erro no meio do log sobrevive ao corte',
    Boolean(m) && m.includes('not ok 7 - parser quebra') && m.includes('Error: expected 3 got 4') &&
    m.includes('FAIL test/b.test.js'));
  check('shell: início e fim preservados, com marcador de trecho omitido',
    m.startsWith('step 0 ok') && m.endsWith('fim do log') && /caracteres omitidos/.test(m));
  check('shell: respeita o teto de tamanho', m.length <= 2000 + 400, `${m.length} chars`);
  const rd = PR.postProcess({ name: 'Read', input: {}, result: log, root: TMP, cfg: c });
  check('Read mantém o corte início+fim (sem linhas-sinal)',
    Boolean(rd) && !rd.modifiedResult.includes('not ok 7') && /truncados/.test(rd.modifiedResult));
  const clean = PR.shellTruncate(noise(2000), 2000);
  check('shell sem sinais: só início+fim', clean.length < 2000 && !/linhas de erro/.test(clean));
  const many = PR.shellTruncate(noise(50) + '\n' + Array.from({ length: 200 }, (_, i) => `Error: falha ${i}`).join('\n') + '\n' + noise(500), 2000);
  check('shell: sinais além do orçamento são contados, não despejados',
    many.length <= 2000 + 200 && /\+\d+ linhas de erro\/falha/.test(many), `${many.length} chars`);
}

{
  // Bloco de imagem MCP (screenshot): o data base64 não entra na janela.
  const b64 = 'A'.repeat(400000);
  const shots = [
    [{ type: 'image', data: b64, mimeType: 'image/png' }],
    [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }],
    { content: [{ type: 'image', data: b64 }, { type: 'text', text: 'ok' }] },
  ];
  check('imagem MCP (data base64) não dispara bigResult',
    shots.every((x) => PR.postProcess({ name: 'mcp__computer-use__screenshot', input: {}, result: x, root: TMP, cfg: cfg() }) === null));
  const txt = PR.postProcess({ name: 'mcp__x__tool', input: {}, result: [{ type: 'text', data: 'z'.repeat(5000) }], root: TMP, cfg: cfg() });
  check('campo data de bloco NÃO-imagem continua medido', Boolean(txt));
}

{
  // .token-guard/results não cresce sem limite.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-post-cap-'));
  for (let i = 0; i < PR.MAX_SAVED_RESULTS + 15; i++) {
    PR.postProcess({ name: 'Grep', input: {}, result: `${i}-` + 'q'.repeat(5000), root, cfg: cfg() });
  }
  const files = fs.readdirSync(path.join(root, '.token-guard', 'results'));
  check(`results/ guarda no máximo ${PR.MAX_SAVED_RESULTS} arquivos`,
    files.length === PR.MAX_SAVED_RESULTS, `${files.length} arquivos`);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('');
console.log(`  ${pass} passaram · ${fail} falharam`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
