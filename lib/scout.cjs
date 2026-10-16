'use strict';
/**
 * scout.cjs — rajada de leitura/busca no contexto principal (A27).
 *
 * Investigar no contexto principal deixa cada resultado na janela, relido em
 * toda chamada seguinte. O subagente `scout` roda em janela descartável e devolve
 * só a conclusão, mas nada o acionava. Aqui: N leituras/buscas seguidas sem
 * edição → UM aviso por rajada (additionalContext no PostToolUse).
 *
 * Medido em 7 dias de transcripts (641 sessões, só contexto principal, qualquer
 * Bash que não seja leitura conta como edição): limiar 6 → 470 rajadas em 131
 * sessões; 8 → 256 em 88; 10 → 157 em 67. Default 8: avisa sem virar ruído.
 * Fail-open: qualquer erro devolve null.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { family } = require('./rules.cjs');

const DEFAULT_BURST = 8;
const WRITE_TOOL = /^(edit|multiedit|write|notebookedit|edit_file|write_file|create_file|replace_string_in_file|insert_edit_into_file|apply_patch)$/;
const SHELL_READ = /^\s*(?:cat|ls|head|tail|find|grep|rg|wc|type|git\s+(?:log|show|diff|status|grep|blame)|Get-Content|Select-String|Get-ChildItem)\b/i;
const SMART_SEARCH = /smart_search|brain_search|graph_(?:search|callers|references|symbols)/i;

/** 'read' = continua a rajada · 'break' = escrita/outra ação zera · 'skip' = não conta. */
function classify(name, input) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (WRITE_TOOL.test(n)) return 'break';
  const fam = family(name);
  if (fam === 'read' || fam === 'grep' || fam === 'glob' || SMART_SEARCH.test(String(name))) return 'read';
  if (fam === 'shell') return SHELL_READ.test(String((input && (input.command || input.cmd)) || '')) ? 'read' : 'break';
  return 'skip';
}

function stateFile(root, sid) {
  const raw = String(sid || '');
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'default';
  const name = safe === raw ? safe : safe + '-' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
  return path.join(root || process.cwd(), '.token-guard', 'sessions', name + '-burst.json');
}

function load(f) {
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { n: Number(s.n) || 0, notified: Boolean(s.notified) };
  } catch { return { n: 0, notified: false }; }
}

/**
 * @returns {null | {additionalContext:string}} aviso na chamada que completa a rajada.
 */
function note({ name, input, root, sessionId, cfg }) {
  try {
    const flag = cfg && cfg.rules ? cfg.rules.scout : undefined;
    if (flag === false || flag === 'false' || flag === 0 || flag === 'off') return null;
    if (!sessionId) return null;
    const kind = classify(name, input);
    if (kind === 'skip') return null;
    const raw = Number(cfg && cfg.limits && cfg.limits.scoutBurst);
    const limit = Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : DEFAULT_BURST;

    const f = stateFile(root, sessionId);
    const st = kind === 'break' ? { n: 0, notified: false } : load(f);
    if (kind === 'read') st.n += 1;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(st), 'utf8');

    if (kind !== 'read' || st.notified || st.n < limit) return null;
    st.notified = true;
    fs.writeFileSync(f, JSON.stringify(st), 'utf8');
    return {
      additionalContext:
        `[token-guard/scout] ${st.n} leituras/buscas seguidas sem edição no contexto principal: cada resultado fica na janela e é relido em toda chamada seguinte. ` +
        'O subagente scout investiga em janela descartável e devolve só a conclusão — adequado a esta fase exploratória.\n' +
        `(PT-BR) ${st.n} leituras/buscas seguidas sem edição; o subagente scout faz essa investigação em contexto descartável e devolve só o veredito.`,
    };
  } catch { return null; }
}

/** Soma o aviso de rajada ao que o pós-processamento já devolveu (conta a chamada de qualquer jeito). */
function withBurst(trimmed, args) {
  const burst = note(args);
  if (!burst) return trimmed;
  if (!trimmed) return burst;
  return { ...trimmed, additionalContext: `${trimmed.additionalContext}\n${burst.additionalContext}` };
}

module.exports = { note, withBurst, classify, DEFAULT_BURST };
