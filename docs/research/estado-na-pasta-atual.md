# Estado gravado na pasta atual (`<cwd>/.token-guard`)

Investigação só de leitura. Nenhum código mudou.

## Causa

O hook do Claude Code recebe `cwd` da sessão. `lib/payload.cjs:49-57` (`cwd`) devolve `payload.cwd` e, sem ele, `process.cwd()`. Esse valor vira `root` em `adapters/daemon-http.cjs:158` (pré), `adapters/post-hook.cjs:29` via `H.postArgs` (pós) e `adapters/prompt-hook.cjs`. Nenhum ponto confere se `root` é uma pasta de projeto. Sessão aberta na Área de Trabalho tem `root` = Área de Trabalho, e o primeiro prompt ou resultado grande cria `<root>/.token-guard/`.

## Quem grava em `<root>/.token-guard`

| Arquivo:linha | O que grava | Gatilho |
|---|---|---|
| `lib/contract.cjs:178-186` (`sessionFile`), `:197-207` (`writeState`) | `sessions/<id>.json` (injected) | primeiro prompt com contrato; `commitInjection` `:244`, `resetInjected` `:215` |
| `lib/contract.cjs:282-283`, `:325` (`noteTouched`) | `sessions/<id>-touched.json` | toda chamada pós-ferramenta |
| `lib/dupread.cjs:26-31` (`sfPath`), `:40-45` (`saveMap`) | `sessions/<id>-reads.json` | todo Read pós-ferramenta |
| `lib/scout.cjs:45-50` (`stateFile`) | `sessions/<id>-burst.json` | rajada de leituras/buscas |
| `lib/ctxwatch.cjs:75-78`, `:99-100` | `sessions/ctxwatch-<h>.json` | aviso de peso de contexto |
| `lib/postresult.cjs:168-173` | `results/*.txt` (saída integral) | resultado acima do limite |
| `lib/audit.cjs:125-135` (`writeCache`) | `repo-stats.json` | `token_audit` MCP (`adapters/mcp-server.cjs:63-67`), Copilot (`adapters/copilot-cli.mjs:84`) |
| `adapters/copilot-cli.mjs:161,187` | os de cima, com `process.cwd()` / `workingDirectory` | Copilot CLI |

Só lê o que está em `root`: `lib/config.cjs` (sobe a árvore a partir do cwd), `adapters/daemon-server.cjs:93-100`.

Já ficam fora do cwd (sem problema): `~/.token-guard/` com `events.jsonl`, `injections.jsonl`, `daemon-http.json`, `daemon.log`, `update-check.json`.

## Plano de correção (recomendado)

Um único resolvedor de pasta de estado em `lib/` (ex.: `statedir.cjs`, `stateRoot(root)`), usado pelos seis pontos de escrita acima, no lugar de `path.join(root, '.token-guard', ...)`:

1. Se `root` contém marcador de projeto (`.git`, `package.json`, `token-guard.config.json`, `.token-guard` já existente), mantém `<root>/.token-guard` (compatível com o que o `SECURITY.md` documenta e com quem já tem a pasta).
2. Caso contrário (Área de Trabalho, pasta do usuário, pasta solta), usa `%LOCALAPPDATA%\token-guard\state\<hash do root>` (Linux/macOS: `$XDG_STATE_HOME` ou `~/.local/state`), nunca o cwd.
3. `daemon-server.cjs:98-99` e `config.cjs` passam a ler pelo mesmo resolvedor.
4. Atualizar `SECURITY.md` ("O que grava").

Alternativa descartada: nunca gravar fora de projeto. Perde `bigResult` (a cópia integral que o agente relê) e `dupRead`, que são o produto.

Mudança de produto? O local do estado muda só para quem não tem marcador de projeto; nada que o usuário configure ou veja. É técnica.

## Plano de teste

Em `test/contract.test.cjs` (e `postresult`, `dupread`, `scout`, `ctxwatch`, `audit`), com o `test/bootstrap.cjs` já isolando HOME/USERPROFILE:

1. Criar `os.tmpdir()/<tmp>/Área de Trabalho` vazio (sem marcador) e rodar cada escritor com `root` nele e `LOCALAPPDATA` apontando para uma pasta temporária: afirmar que a pasta não ganhou nenhuma entrada (`readdirSync` vazio) e que o estado foi para a pasta de dados.
2. Mesma execução duas vezes: contagem de arquivos igual na segunda.
3. Com `.git` na pasta: o estado continua em `<root>/.token-guard`.
4. Fim a fim: `post-hook.cjs` e `daemon-http` com payload `cwd` = pasta de nome da Área de Trabalho.

## Como o material anterior foi aplicado

- `daemon-followups-flaky.md`: só lição de teste. Os testes novos não usam socket nem daemon próprio de verdade além do `bootstrap`, então não herdam EPIPE/EADDRINUSE; nada do daemon real é tocado.
- `2026-11-08-teste-sweep-pastas-reais.md` (skill-repo): a regra "o teste confere as pastas reais depois" virou o item 1 do teste (HOME, USERPROFILE e LOCALAPPDATA redirecionados; asserção de zero entradas na pasta-alvo) e a decisão de recusar por padrão em pasta sem marcador, em vez de gravar.
- `2026-11-08-temp-investigacao-pastas-e-op-cli.md`: padrão de dados em `%LOCALAPPDATA%\<produto>` e prova de duas execuções com zero arquivos novos (item 2 do teste); falha explícita se a base não existir.

## Fontes

Código lido em `lib/`, `adapters/` (linhas acima). Sem pesquisa externa.
