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
