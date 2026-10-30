'use strict';
/**
 * config-edit.cjs — a única porta de ESCRITA da config pelo usuário (tela de setup).
 *
 * Grava em ~/.token-guard/token-guard.config.json, o último dos homes globais que `config.load()`
 * mescla: o que a tela salva vale para o CLI, os hooks e o próprio daemon, que leem o mesmo
 * arquivo (e a chave de cache do daemon já inclui esse arquivo, então a mudança vale na próxima
 * chamada). Config de repositório continua mandando no próprio repositório.
 *
 * Só mexe nas chaves que a tela gerencia (mode, targets, rules, ui.tray); o resto do arquivo
 * (limites, noiseDirs, comentários `$...`) fica como estava. Arquivo ilegível NÃO é sobrescrito:
 * o erro sobe para a tela, que o mostra (fail-loud).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const CFG = require('./config.cjs');
const { RULES } = require('./catalog.cjs');

const RULE_IDS = RULES.map((r) => r.id);
const MODES = ['block', 'off'];

function userConfigPath() {
  return path.join(os.homedir(), '.token-guard', CFG.CONFIG_NAME);
}

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * Confere o pedido da tela antes de tocar no disco.
 * @param {object} patch {mode?, targets?:{<ide>: 'block'|'off'|null}, rules?:{<regra>: boolean}, ui?:{tray:boolean}}
 * @returns {{ok:true, clean:object}|{ok:false, error:string}}
 */
function validate(patch) {
  if (!isObj(patch)) return { ok: false, error: 'pedido inválido: esperava um objeto' };
  const clean = {};
  for (const k of Object.keys(patch)) {
    if (!['mode', 'targets', 'rules', 'ui'].includes(k)) return { ok: false, error: `campo desconhecido: ${k}` };
  }
  if ('mode' in patch) {
    if (!MODES.includes(patch.mode)) return { ok: false, error: `mode deve ser "block" ou "off" (veio ${JSON.stringify(patch.mode)})` };
    clean.mode = patch.mode;
  }
  if ('targets' in patch) {
    if (!isObj(patch.targets)) return { ok: false, error: 'targets deve ser um objeto' };
    clean.targets = {};
    for (const [t, v] of Object.entries(patch.targets)) {
      if (!CFG.TARGETS.includes(t)) return { ok: false, error: `IDE desconhecido: ${t}` };
      if (v !== null && !MODES.includes(v)) return { ok: false, error: `targets.${t} deve ser "block", "off" ou null (seguir o geral)` };
      clean.targets[t] = v;
    }
  }
  if ('rules' in patch) {
    if (!isObj(patch.rules)) return { ok: false, error: 'rules deve ser um objeto' };
    clean.rules = {};
    for (const [r, v] of Object.entries(patch.rules)) {
      if (!RULE_IDS.includes(r)) return { ok: false, error: `regra desconhecida: ${r}` };
      if (typeof v !== 'boolean') return { ok: false, error: `rules.${r} deve ser true ou false` };
      clean.rules[r] = v;
    }
  }
  if ('ui' in patch) {
    if (!isObj(patch.ui) || typeof patch.ui.tray !== 'boolean') return { ok: false, error: 'ui.tray deve ser true ou false' };
    clean.ui = { tray: patch.ui.tray };
  }
  return { ok: true, clean };
}

/** O que está gravado hoje no arquivo do usuário ({} se ainda não existe). */
function readUserConfig(file = userConfigPath()) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, config: {} };
    return { ok: false, error: `${file}: ${err.message}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isObj(parsed)) return { ok: false, error: `${file} não é um objeto JSON` };
    return { ok: true, config: parsed };
  } catch (err) {
    return { ok: false, error: `${file} não é JSON válido (${err.message}); corrija ou apague o arquivo — nada foi sobrescrito` };
  }
}

/**
 * Aplica o pedido ao arquivo do usuário.
 * @returns {{ok:true, file:string}|{ok:false, error:string}}
 */
function save(patch) {
  const v = validate(patch);
  if (!v.ok) return v;
  const file = userConfigPath();
  const cur = readUserConfig(file);
  if (!cur.ok) return cur;
  const next = { ...cur.config };
  const { clean } = v;
  if (clean.mode) next.mode = clean.mode;
  if (clean.targets) {
    const t = isObj(next.targets) ? { ...next.targets } : {};
    for (const [k, val] of Object.entries(clean.targets)) { if (val === null) delete t[k]; else t[k] = val; }
    next.targets = t;
  }
  if (clean.rules) next.rules = { ...(isObj(next.rules) ? next.rules : {}), ...clean.rules };
  if (clean.ui) next.ui = { ...(isObj(next.ui) ? next.ui : {}), ...clean.ui };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tg-tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    return { ok: false, error: `não gravou ${file}: ${err.message}` };
  }
  CFG.clearMemo();
  return { ok: true, file };
}

module.exports = { validate, save, readUserConfig, userConfigPath, RULE_IDS, MODES };
