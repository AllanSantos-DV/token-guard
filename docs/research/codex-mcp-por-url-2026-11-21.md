# Codex atendido pelo daemon por url (2026-11-21)

## Problema medido
Investigação de desempenho entre produtos (2026-11-19): o Codex mantém um conjunto de servidores MCP stdio por conversa;
com 19 conversas havia 19 processos `node mcp-server.cjs` (+19 conhost, 458 MiB de commit) só para o hook `mcp_tool`.

## Solução
- `adapters/daemon-http.cjs`: rota `POST /token-guard/mcp` (MCP Streamable HTTP sem sessão, resposta `application/json`,
  notificação → 202, GET → 405), mesmo token `X-Token-Guard`; o despacho é o `handle()` do `mcp-server.cjs`, que passou a
  devolver a resposta em vez de escrever no stdout (o stdio segue servindo os outros IDEs).
- `install.cjs`: `[mcp_servers.token-guard]` com `url` e `http_headers`; entrada stdio antiga é migrada.
- `daemon-server.cjs`: ao subir numa porta, reaponta a `url` do `config.toml` do Codex (`syncCodexConfig`).

## Verificação
- `test/daemon-mcp.test.cjs`: 16 casos (401, 405, initialize, 202, tools/list, deny/allow/falha do hook, lote, sync do toml).
- Ambiente real após instalar 2.19.6 (f2c67ac): config do Codex com `url = http://127.0.0.1:44448/token-guard/mcp`;
  `codex exec` pedindo `ls -R /` voltou "Command blocked by PreToolUse hook: token-guard/shellDump";
  0 processos `mcp-server.cjs` vivos.
- Não verificado: contagem de processos com várias conversas do Codex abertas ao mesmo tempo.

## Fontes
- docs/research/2026-11-19-desempenho-entre-produtos.md (projeto investigação), linhas 88-94.
- OpenAI Codex, MCP por url: https://learn.chatgpt.com/docs/extend/mcp?surface=cli (acesso 2026-11-19, citado na investigação).
