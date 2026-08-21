'use strict';
/**
 * audit.cjs — a medição do custo de contexto, como biblioteca.
 *
 * Fica separada do CLI de propósito: a extensão chama estas funções in-process,
 * sem spawn. (Dentro de um harness empacotado, `process.execPath` aponta para o
 * binário do harness — não para o Node — então subprocesso não é confiável.)
 *
 * Sem dependências. Só Node stdlib.
 */

const fs = require('fs');
const path = require('path');

/* ---------------- varredura ---------------- */

/**
 * Percorre o repositório uma única vez, classificando cada arquivo.
 * @returns {{stats:object, derived:object, topExt:Array, topDir:Array, elapsedMs:number}}
 */
function scan(root, cfg, { top = 10 } = {}) {
  const NOISE = new Set(cfg.noiseDirs);
  const SOURCE = new Set(cfg.sourceExt);
  const CPT = cfg.charsPerToken;
  const WINDOW = cfg.contextWindow;

  const stats = {
    root,
    scannedAt: new Date().toISOString(),
    totalFiles: 0, totalBytes: 0,
    noiseFiles: 0, noiseBytes: 0,
    cleanFiles: 0, cleanBytes: 0,
    sourceFiles: 0, sourceBytes: 0,
    pathChars: 0, unreadable: 0,
  };

  const byExt = new Map();
  const byDir = new Map();

  function bump(map, key, bytes, extra) {
    const e = map.get(key) || { files: 0, bytes: 0, ...(extra || {}) };
    e.files += 1;
    e.bytes += bytes;
    if (extra) Object.assign(e, extra);
    map.set(key, e);
  }

  function walk(dir, topSegment, insideNoise) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      stats.unreadable += 1;
      return;
    }

    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue; // não seguimos links: evita loop e contagem dupla

      if (ent.isDirectory()) {
        walk(full, topSegment || ent.name, insideNoise || NOISE.has(ent.name));
        continue;
      }
      if (!ent.isFile()) continue;

      let size = 0;
      try { size = fs.statSync(full).size; } catch { stats.unreadable += 1; continue; }

      stats.totalFiles += 1;
      stats.totalBytes += size;
      stats.pathChars += full.length + 1; // +1 pela quebra de linha de uma listagem

      const topKey = topSegment || '(raiz)';

      if (insideNoise) {
        stats.noiseFiles += 1;
        stats.noiseBytes += size;
        bump(byDir, topKey, size, { noise: true });
        continue;
      }

      stats.cleanFiles += 1;
      stats.cleanBytes += size;
      bump(byDir, topKey, size, { noise: false });

      const ext = path.extname(ent.name).toLowerCase();
      if (SOURCE.has(ext)) {
        stats.sourceFiles += 1;
        stats.sourceBytes += size;
        bump(byExt, ext || '(sem extensão)', size);
      }
    }
  }

  const t0 = Date.now();
  walk(root, null, false);
  const elapsedMs = Date.now() - t0;

  const w = (b) => b / CPT / WINDOW;
  const derived = {
    totalTokens: Math.round(stats.totalBytes / CPT),
    cleanTokens: Math.round(stats.cleanBytes / CPT),
    sourceTokens: Math.round(stats.sourceBytes / CPT),
    pathTokens: Math.round(stats.pathChars / CPT),
    totalWindows: w(stats.totalBytes),
    cleanWindows: w(stats.cleanBytes),
    sourceWindows: w(stats.sourceBytes),
    pathWindows: w(stats.pathChars),
    noiseShareBytes: stats.totalBytes ? stats.noiseBytes / stats.totalBytes : 0,
    noiseShareFiles: stats.totalFiles ? stats.noiseFiles / stats.totalFiles : 0,
    nonSourceShare: stats.totalBytes ? 1 - stats.sourceBytes / stats.totalBytes : 0,
    contextWindow: WINDOW,
    charsPerToken: CPT,
  };

  return {
    stats, derived, elapsedMs,
    topExt: [...byExt.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top),
    topDir: [...byDir.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top),
  };
}

/** Grava o cache que calibra os guardrails. Falha é silenciosa: cache é otimização. */
function writeCache(root, result) {
  try {
    const dir = path.join(root, '.token-guard');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'repo-stats.json'),
      JSON.stringify({ ...result.stats, ...result.derived }, null, 2),
      'utf8'
    );
    return true;
  } catch { return false; }
}

/* ---------------- formatação ---------------- */

const nf = new Intl.NumberFormat('pt-BR');
const n = (x) => nf.format(Math.round(x));

function bytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(2).replace('.', ',') + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

function makeFmt(cfg) {
  const CPT = cfg.charsPerToken;
  const WINDOW = cfg.contextWindow;
  return {
    tokens(b) {
      const t = b / CPT;
      if (t >= 1e6) return (t / 1e6).toFixed(1).replace('.', ',') + ' M';
      if (t >= 1e3) return (t / 1e3).toFixed(1).replace('.', ',') + ' k';
      return String(Math.round(t));
    },
    win(b) {
      const x = b / CPT / WINDOW;
      if (x < 0.01) return '<0,01';
      if (x < 1) return x.toFixed(2).replace('.', ',');
      return n(x);
    },
  };
}

const pct = (part, whole) =>
  whole > 0 ? ((part / whole) * 100).toFixed(1).replace('.', ',') + '%' : '0%';

function bar(fraction, width = 34) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return '█'.repeat(filled) + '·'.repeat(width - filled);
}

function renderMarkdown(result, cfg) {
  const { stats, derived, topDir } = result;
  const F = makeFmt(cfg);
  const L = [];
  L.push(`# Auditoria de contexto — \`${path.basename(stats.root)}\``);
  L.push('');
  L.push(`Medido em ${new Date().toLocaleString('pt-BR')} · janela de referência: ${n(cfg.contextWindow)} tokens · ${cfg.charsPerToken} car./token`);
  L.push('');
  L.push('| Camada | Arquivos | Volume | Tokens | Janelas de contexto |');
  L.push('|---|---:|---:|---:|---:|');
  L.push(`| Tudo em disco | ${n(stats.totalFiles)} | ${bytes(stats.totalBytes)} | ${F.tokens(stats.totalBytes)} | ${F.win(stats.totalBytes)} |`);
  L.push(`| Sem ruído | ${n(stats.cleanFiles)} | ${bytes(stats.cleanBytes)} | ${F.tokens(stats.cleanBytes)} | ${F.win(stats.cleanBytes)} |`);
  L.push(`| Só código-fonte | ${n(stats.sourceFiles)} | ${bytes(stats.sourceBytes)} | ${F.tokens(stats.sourceBytes)} | ${F.win(stats.sourceBytes)} |`);
  L.push(`| **Só a lista de caminhos** | — | ${bytes(stats.pathChars)} | ${F.tokens(stats.pathChars)} | **${F.win(stats.pathChars)}** |`);
  L.push('');
  L.push(`- Ruído: **${pct(stats.noiseFiles, stats.totalFiles)}** dos arquivos e **${pct(stats.noiseBytes, stats.totalBytes)}** do volume.`);
  L.push(`- Não é código-fonte: **${(derived.nonSourceShare * 100).toFixed(1).replace('.', ',')}%** do volume.`);
  L.push(`- Listar os nomes dos arquivos já custa **${F.win(stats.pathChars)} janela(s)** — antes de ler uma linha.`);
  L.push('');
  L.push('## Diretórios mais pesados');
  L.push('');
  L.push('| Diretório | Arquivos | Volume | Ruído |');
  L.push('|---|---:|---:|:--:|');
  for (const [d, e] of topDir) L.push(`| \`${d}\` | ${n(e.files)} | ${bytes(e.bytes)} | ${e.noise ? 'sim' : '—'} |`);
  return L.join('\n');
}

function renderText(result, cfg, extra = {}) {
  const { stats, derived, topDir, topExt, elapsedMs } = result;
  const F = makeFmt(cfg);
  const W = 74;
  const line = (ch = '─') => ch.repeat(W);
  const out = [];
  const p = (s = '') => out.push(s);

  p('');
  p(`  token-audit · ${stats.root}`);
  p(`  ${line()}`);
  p(`  ${n(stats.totalFiles)} arquivos · ${bytes(stats.totalBytes)} · varrido em ${(elapsedMs / 1000).toFixed(1).replace('.', ',')}s`);
  p(`  janela de referência: ${n(cfg.contextWindow)} tokens · ${cfg.charsPerToken} caracteres por token`);
  p('');
  p('  CAMADA             ARQUIVOS      VOLUME     TOKENS   JANELAS');
  p(`  ${line('·')}`);
  const rows = [
    ['Tudo em disco', stats.totalFiles, stats.totalBytes, 1],
    ['Sem ruído', stats.cleanFiles, stats.cleanBytes, stats.totalBytes ? stats.cleanBytes / stats.totalBytes : 0],
    ['Só código-fonte', stats.sourceFiles, stats.sourceBytes, stats.totalBytes ? stats.sourceBytes / stats.totalBytes : 0],
  ];
  for (const [label, files, b, frac] of rows) {
    p('  ' + label.padEnd(17) + n(files).padStart(9) + bytes(b).padStart(12) + F.tokens(b).padStart(11) + F.win(b).padStart(10));
    p('  ' + ' '.repeat(17) + bar(frac));
  }
  p('');
  p(`  ${line()}`);
  p('  O QUE ISSO CUSTA ANTES DE LER UMA LINHA DE CÓDIGO');
  p('');
  p(`  Só a lista de nomes de arquivo   ${n(stats.pathChars)} caracteres`);
  p(`                                   ≈ ${F.tokens(stats.pathChars)} tokens`);
  p(`                                   = ${F.win(stats.pathChars)} janela(s) de contexto`);
  p('');
  p(`  Ruído em disco    ${pct(stats.noiseFiles, stats.totalFiles).padStart(7)} dos arquivos · ${pct(stats.noiseBytes, stats.totalBytes)} do volume`);
  p(`  Não é código      ${(derived.nonSourceShare * 100).toFixed(1).replace('.', ',').padStart(6)}% do volume`);
  p('');

  if (topDir.length) {
    p(`  ${line()}`);
    p('  DIRETÓRIOS MAIS PESADOS');
    p('');
    const maxB = topDir[0][1].bytes || 1;
    for (const [d, e] of topDir) {
      p('  ' + (d + (e.noise ? ' [ruído]' : '')).padEnd(26) + bytes(e.bytes).padStart(10) + '  ' + bar(e.bytes / maxB, 26));
    }
    p('');
  }

  if (topExt.length) {
    p(`  ${line()}`);
    p('  CÓDIGO-FONTE POR EXTENSÃO');
    p('');
    for (const [ext, e] of topExt) {
      p('  ' + ext.padEnd(16) + n(e.files).padStart(8) + ' arq.' + bytes(e.bytes).padStart(11) + F.tokens(e.bytes).padStart(10) + ' tok');
    }
    p('');
  }

  p(`  ${line()}`);
  const savedFiles = stats.totalFiles - stats.cleanFiles;
  const savedBytes = stats.totalBytes - stats.cleanBytes;
  p('  GANHO IMEDIATO — apenas descartando diretórios de build/dependência');
  p('');
  p(`  −${n(savedFiles)} arquivos (${pct(savedFiles, stats.totalFiles)})   −${bytes(savedBytes)} (${pct(savedBytes, stats.totalBytes)})`);
  p('  Custo de implementação: nenhum. É configuração.');
  p('');
  if (extra.configSource) p(`  config: ${extra.configSource}`);
  if (extra.cachePath) p(`  cache:  ${extra.cachePath}`);
  p('');
  return out.join('\n');
}

module.exports = { scan, writeCache, renderText, renderMarkdown, bytes, bar, pct };
