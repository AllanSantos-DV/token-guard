# Estado do projeto

Retrato do que existe hoje. Decisões datadas ficam no `CHANGELOG.md` e em `docs/research/`; itens abertos, em `docs/BACKLOG.md`.

## O que é

Pacote npm `@allansantos-dev/token-guard` (zero dependências em runtime, Node >= 16). Barra no `PreToolUse` as chamadas que
estouram a janela de contexto e devolve sempre a alternativa barata; mede o custo do repositório e dos servidores MCP; governa o
contrato de saída. Princípios: fail-open, zero dependências, todo bloqueio ensina.

## Estrutura

| Pasta ou arquivo | Papel |
|---|---|
| `lib/` | núcleo puro, sem conhecer harness: regras (`rules.cjs`), decisão (`decide.cjs`), config, auditoria, custo, contrato, pós-resultado, leitura repetida, atualização |
| `adapters/` | tradução de envelope por harness (Claude, Codex, Cursor, Copilot, MCP) e o daemon residente (`daemon-server.cjs`, `daemon-http.cjs`, `session-start.cjs`, `hook-cmd.cjs`) |
| `cli.cjs`, `install.cjs`, `token-audit.cjs`, `mcp-cost.cjs`, `cost.cjs`, `contract.cjs` | entradas de linha de comando |
| `token-guard.cjs`, `extension.mjs`, `hooks.json`, `plugin.json` | entradas dos harnesses (hook de comando, plugin do Copilot, manifestos) |
| `agents/`, `skills/`, `contract.default.md`, `config.default.json` | agente scout, skill, contrato e configuração padrão |
| `test/` | suítes em Node puro, uma por tema; `test/bootstrap.cjs` isola SID, home e daemon de cada suíte |
| `docs/` | guias do usuário, pesquisas (`docs/research/`), planos, backlog, este estado e os marcos |
| `native-lens/` | medição de desempenho de portes nativos (C#, Rust, Go) com prova de equivalência; **fora do pacote** |
| `boards/`, `bench/`, `scripts/` | painéis narrados, benchmarks e verificações de segurança do daemon; `boards/` e `native-lens/` ficam fora do pacote |

## Como roda

- Daemon residente por usuário (pipe IPC por SID no Windows). Com o token do usuário serve também o hook http do Claude Code
  (`POST /token-guard/pre|post|prompt`), o MCP do Codex por url (`POST /token-guard/mcp`) e a tela de setup.
- A porta nunca é fixa: o daemon sobe numa porta livre, grava `~/.token-guard/daemon-http.json`, e reaponta as URLs dos hooks
  no `settings.json` do Claude Code e a `url` do MCP no `config.toml` do Codex. A URL do hook leva `hook-origin` e `port-file`.
- `SessionStart` (comando) garante o daemon, reaponta e avisa o que falhou; sem daemon, o hook http falha aberto.
- Auto-update ligado por padrão (`TOKEN_GUARD_AUTO_UPDATE=off` desliga), com aviso visível ao instalar e ao atualizar.

## Como testar e publicar

- `npm test` roda todas as suítes em sequência; suíte isolada: `node test/<nome>.test.cjs`. Nada toca o daemon real.
- Trabalho em `develop`; release só depois do gate, com avanço por fast-forward para `main` e tag `vX.Y.Z` em `main`
  (o push da tag publica por OIDC). O Actions hospedado não roda suíte.
- Instalar nesta máquina: `node install.cjs --target claude,codex` a partir do pacote extraído.

## Problemas conhecidos

- O `config.toml` do Codex pode perder a tabela `[mcp_servers.token-guard]` quando outro programa o reescreve; o hook `mcp_tool`
  do Codex então aponta para um servidor que não existe e a chamada passa sem guard. `status` passa a dizer isso.
- Hook http que perde o daemon no meio da sessão falha aberto (conexão recusada); o daemon só é religado no próximo início de
  sessão.
- O Windows é a plataforma medida; Linux e macOS rodam o núcleo, sem o daemon por pipe nomeado medido em campo.
