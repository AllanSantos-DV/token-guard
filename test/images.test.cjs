'use strict';
/**
 * images.test.cjs — imagem nunca é barrada nem alterada pelo guard.
 *
 * Reprodução do relato "o token-guard trava JPEG, PNG e GIF abaixo de 50 KB":
 * o arquivo cabe no limite do blindRead, mas o base64 do resultado passa de
 * resultCharsWithoutTrim, e as versões ≤ 2.5.0 trocavam a imagem por um stub
 * (post-hook). Desde a 2.6.0 o base64 fica fora da medida. Este teste roda os
 * DOIS hooks reais (pré e pós) sobre imagens de 10/45/49 KB e de 300 KB, em
 * vários formatos e formas de resposta do Read e de MCP.
 */

require('./bootstrap.cjs');

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.error(`  ✗ ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''}`);
}

const ADAPTERS = path.join(__dirname, '..', 'adapters');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-images-'));
const MAGIC = {
  png: ['89504e470d0a1a0a', 'image/png'],
  jpg: ['ffd8ffe0', 'image/jpeg'],
  jpeg: ['ffd8ffe0', 'image/jpeg'],
  gif: ['474946383961', 'image/gif'],
  webp: ['52494646', 'image/webp'],
};
const SIZES = [10 * 1024, 45 * 1024, 49 * 1024, 300 * 1024];

let seq = 0;
function hook(file, payload) {
  // sessão nova a cada chamada: a regra do scout (8 leituras seguidas) é conselho, não é o que se testa aqui
  return spawnSync(process.execPath, [path.join(ADAPTERS, file)], {
    input: JSON.stringify({ cwd: WORK, session_id: `img-${seq++}`, ...payload }), encoding: 'utf8', timeout: 30000,
  });
}

console.log('\n  [imagens]');
for (const [ext, [magic, mime]] of Object.entries(MAGIC)) {
  for (const size of SIZES) {
    const file = path.join(WORK, `img-${size}.${ext}`);
    const buf = Buffer.concat([Buffer.from(magic, 'hex'), crypto.randomBytes(size - magic.length / 2)]);
    fs.writeFileSync(file, buf);
    const tag = `${ext} ${Math.round(size / 1024)} KB`;
    const b64 = buf.toString('base64');

    const pre = hook('hook-cmd.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file } });
    check(`${tag}: Read não é barrado`, pre.status === 0 && !/"deny"/.test(pre.stdout || ''), pre.stdout);

    const shapes = {
      'Read (type:image, file.base64)': { tool_name: 'Read', tool_response: { type: 'image', file: { base64: b64, type: mime, originalSize: size } } },
      'Read (bloco image/source)': { tool_name: 'Read', tool_response: [{ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }] },
      'MCP (image/data)': { tool_name: 'mcp__x__screenshot', tool_response: { content: [{ type: 'image', data: b64, mimeType: mime }] } },
      'MCP (texto + image)': { tool_name: 'mcp__x__screenshot', tool_response: { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: b64, mimeType: mime }] } },
    };
    for (const [shape, extra] of Object.entries(shapes)) {
      const post = hook('post-hook.cjs', { hook_event_name: 'PostToolUse', tool_input: { file_path: file }, ...extra });
      check(`${tag}: ${shape} sai intacto`, post.status === 0 && (post.stdout || '').trim() === '', post.stdout);
    }
  }
}

fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\n  imagens: ${pass} passaram · ${fail} falharam`);
process.exit(fail ? 1 : 0);
