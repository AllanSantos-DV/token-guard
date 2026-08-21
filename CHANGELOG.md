# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [2.0.0] — 2026-08-21

### Adicionado
- **Camada `adapters/`**: o núcleo de decisão passa a ser compartilhado por quatro
  integrações distintas, sem duplicar regra de negócio.
- **Adapter Cursor** (`adapters/cursor-hook.cjs`): traduz `beforeReadFile`,
  `beforeShellExecution` e `beforeMCPExecution` para o contrato `{ permission }` do Cursor.
- **Adapter MCP** (`adapters/mcp-server.cjs`): MCP server stdio, zero dependências,
  expondo `token_audit`, `token_guard_status` e `token_guard_check`. Fallback universal
  para IDEs sem hook pré-ferramenta (VS Code, Windsurf, Zed, JetBrains).
- **Adapter Claude Code**: instalação em `~/.claude/settings.json` via `PreToolUse`,
  reaproveitando o hook de comando existente.
- **Instalador multi-alvo**: `install.cjs --target copilot|claude|cursor|mcp|repo|all`.
- `test/adapters.test.cjs` cobrindo os adapters Cursor e MCP.
- CI em GitHub Actions: Linux + Windows × Node 18/20/22.
- `docs/IDES.md` com a matriz de cobertura real por IDE.

### Alterado
- `extension.mjs` e `token-guard.cjs` viraram shims finos sobre `adapters/`.
  Os caminhos antigos continuam funcionando — instalações existentes não quebram.
- `cli.cjs` ganhou `--target` e o comando `mcp`.

### Mantido
- Núcleo (`lib/`) inalterado: mesma decisão, mesmas quatro regras, mesmos 27 testes.
- Fail-open em qualquer erro.
- `TOKEN_GUARD=off` / `TOKEN_GUARD=warn` como escape hatch sem editar arquivo.

## [1.0.0]

- Versão inicial: hook `PreToolUse` para Copilot CLI, extensão in-process,
  auditoria de custo de contexto e as quatro regras.
