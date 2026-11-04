# Quedas do cliente com o daemon no ar e saudável (2026-11-04)

Pergunta: com o daemon vivo e respondendo ao health, por que um cliente (sessão do Claude Code, Codex) ainda
perde o token-guard?

## Fontes (acessadas em 2026-11-04)

- https://code.claude.com/docs/en/hooks: hooks editados no `settings.json` são relidos pelo watcher;
  erro de hook `http` (conexão recusada, timeout, status não 2xx) não bloqueia, a chamada segue.
- https://github.com/anthropics/claude-code/issues/77357, /6491, /55867, /60949, /6305: relatos de hook que
  some sem aviso, de timeout de hook e de recarga de settings.
- Endpoint MCP preso após troca de porta, em outros projetos: unity-kiss-mcp commit 136c00e,
  opencode #25682, openclaw #98435, deepseek-harness #9740. Correção comum: reler o arquivo de anúncio e
  sondar o health antes de reconectar.

## Inventário do que fica fixo

| Item | Onde | Muda? |
|---|---|---|
| Pipe IPC | `\\.\pipe\token-guard-<SID>` | não (SID estável por conta) |
| Porta HTTP | preferida (sha1 do usuário) → registrada → livre; vai para `~/.token-guard/daemon-http.json` e para as URLs dos hooks no `settings.json` | só se a anterior estiver ocupada |
| Token HTTP | `~/.token-guard/daemon-http.token` | não |
| Cópias por alvo | `~/.claude/token-guard`, `~/.codex/token-guard`, `~/.cursor/token-guard`, `~/.copilot/extensions/token-guard`, `~/.token-guard/runtime` | a cada `init`/auto-update, **só dos alvos atualizados** |
| Servidor MCP do Codex | `~/.codex/config.toml` aponta para `~/.codex/token-guard/adapters/mcp-server.cjs`; processo longo, decide em processo, sem daemon | carrega a versão do disco na partida |

## Experimentos (sessões reais do Claude Code 2.1.316, home isolado)

| Sessão | Cenário | Resultado |
|---|---|---|
| 45b62244 | porta muda no meio da sessão (reescrita atômica do `settings.json`) | a sessão segue a porta nova em ~3–4 s |
| 830f822f | duas mudanças seguidas | segue as duas |
| b10cdcf6 | conexão recusada | nenhum anexo no transcript: falha aberta silenciosa |
| 3a43950e | servidor aceita e não responde | `hook_cancelled` no timeout |

Shutdown com outro cliente IPC preso: o daemon antigo segue vivo **e com a porta** até o cliente soltar; um
sucessor que sobe nessa janela desiste (~400 ms) em vez de abrir em outra porta. A hipótese de "janela de troca
de porta" foi descartada: não há correção para ela.

## Perícia de 2026-10-31

Os `hook_cancelled` daquele dia têm a assinatura "conexão aceita, sem resposta" e atingiram todas as sessões
ao mesmo tempo, enquanto os outros servidores de hook respondiam: o travamento era do daemon do token-guard. As
mesmas chamadas, reexecutadas pelo caminho do hook http no código atual, respondem rápido. A causa não é
provável: o `daemon.log` daquela época não existia e não registrava a porta. Desde esta versão o log grava
`http-on` com a porta.

## Causa provada: cópia de alvo parada numa versão antiga

O auto-update comparava só a versão da cópia que o rodava (a do Claude). Com ela em dia, não reinstalava os
outros alvos registrados: a cópia do Codex ficou na 2.15.1 enquanto a do Claude estava na 2.17.0, e o
servidor MCP do Codex seguia com regras e correções de três versões atrás. Correção: o auto-update parte da
versão **mais antiga** entre as cópias dos alvos registrados (`oldestInstalledVersion`), e o teste falha sem
ela (69/1 → 70/0).

Mistura de versões no processo longo do Codex (módulos carregados tarde por `decide.cjs`/`rules.cjs`/
`postresult.cjs` depois da troca em disco): medido de 2.15.1 para a atual, toda função usada existe com a mesma
aridade; o resto cai no fail-open.

## Como cada referência foi aplicada

| Referência | Aplicação aqui |
|---|---|
| `troca-do-daemon-no-windows-2026-11-03.md` | o `swapDaemon` já espera o antigo sair e prova o novo pelo health; o experimento do cliente preso confirmou que a porta não se perde na troca |
| codex-boss `2026-11-02-proxy-port-rediscovery.md` (lançador estável, reler o anúncio + health na recusa, redescoberta única, retry só de leitura) | o lado Claude já relê o anúncio (`syncClaudeSettings` + watcher do harness) e o retry do cliente IPC já é só de chamada idempotente (`requestKey`); o lançador estável corresponde ao caminho fixo por alvo, cuja falha real era a cópia não atualizada |
| skill `plugin-daemon-unico` | um daemon por usuário, swap esperando a saída, aviso alto quando o HTTP não sobe; nada novo a adotar |
| skill `contextacao` | levantamento antes de mudar: inventário acima, reprodução isolada, prova antes/depois |

## Limites que ficam

- Hook http recusado não deixa rastro no transcript nem no daemon (comportamento do harness); só o health e o
  `daemon.log` mostram a queda.
- `~/.token-guard/mcp.json` e `~/.token-guard/runtime` (alvo `mcp`, não registrado) podem sobrar de instalações
  antigas e não são atualizados por não estarem entre os alvos.
