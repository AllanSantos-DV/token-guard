'use strict';
/**
 * payload.js — leitor de payload agnóstico ao runtime.
 *
 * Runtimes cobertos:
 *   VS Code Copilot Chat : { toolCall: { toolName, input, toolUseId }, tool_response }
 *   Claude Code CLI      : { tool_name, tool_input, tool_use_id, tool_response }
 *   Legado camelCase     : { toolName, toolInput, toolResult, toolUseId }
 *   Extensão in-process  : { toolName, toolArgs, workingDirectory }  (SDK do Copilot CLI)
 *
 * Nenhuma regra deve ler payload.tool_* diretamente. Sempre por estes helpers.
 */

function firstString(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.length > 0) return v;
  return '';
}

function firstObject(...vals) {
  for (const v of vals) if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  return null;
}

function toolName(payload) {
  return firstString(
    payload?.toolCall?.toolName,
    payload?.tool_name,
    payload?.toolName,
    payload?.name
  );
}

function toolInput(payload) {
  return firstObject(
    payload?.toolCall?.input,
    payload?.tool_input,
    payload?.toolInput,
    payload?.toolArgs,
    payload?.input
  ) || {};
}

function cwd(payload) {
  return firstString(
    payload?.cwd,
    payload?.workingDirectory,   // hook in-process de extensão (SDK do Copilot)
    payload?.workspaceRoot,
    payload?.workspace_root,
    process.cwd()
  );
}

/** Lê o payload de stdin. Resolve com {} se vazio ou inválido: nunca derruba a sessão. */
function readPayload() {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    };
    // Se stdin não vier (execução manual/teste), não trava o agente.
    const bail = setTimeout(done, 1500);
    if (typeof bail.unref === 'function') bail.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => { clearTimeout(bail); done(); });
    process.stdin.on('error', () => { clearTimeout(bail); done(); });
  });
}

/* ---------- cascatas de alias dos campos de entrada ---------- */

/** Caminho de arquivo/pasta alvo, qualquer que seja o nome do campo no harness. */
function inputPath(input) {
  return firstString(
    input.path, input.filePath, input.file_path, input.absolute_path,
    input.target, input.file, input.uri, input.filename
  );
}

/** Lista de caminhos (grep/glob aceitam string ou array). */
function inputPaths(input) {
  const raw = input.paths != null ? input.paths
            : input.path != null ? input.path
            : input.searchPaths != null ? input.searchPaths
            : input.directories;
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string');
  if (typeof raw === 'string' && raw) return [raw];
  return [];
}

/** Padrão de busca / glob. */
function inputPattern(input) {
  return firstString(input.pattern, input.query, input.regex, input.search, input.searchText, input.glob);
}

/** Filtro de escopo (glob/type/include). A presença dele é o que torna a busca aceitável. */
function inputScopeFilter(input) {
  return firstString(input.glob, input.type, input.include, input.includePattern, input.filePattern);
}

/** true se a leitura pediu uma faixa de linhas em vez do arquivo inteiro.
 *  offset=0 sem limit NÃO é faixa: é o arquivo inteiro começando do início. */
function hasReadRange(input) {
  if (Array.isArray(input.view_range) && input.view_range.length) return true;
  if (Array.isArray(input.range) && input.range.length) return true;
  const nums = [input.offset, input.limit, input.startLine, input.endLine,
                input.start_line, input.end_line, input.startLineNumber, input.endLineNumber];
  return nums.some((n) => typeof n === 'number' && Number.isFinite(n) && n > 0);
}

/** Linha de comando de shell, qualquer que seja o campo. */
function inputCommand(input) {
  return firstString(input.command, input.cmd, input.script, input.commandLine);
}

module.exports = {
  readPayload, toolName, toolInput, cwd,
  inputPath, inputPaths, inputPattern, inputScopeFilter, hasReadRange, inputCommand,
  firstString, firstObject,
};
