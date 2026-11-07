# daemon-followups intermitente: `write EPIPE` e `EADDRINUSE`

Escopo: só código de teste (`test/daemon-followups.test.cjs`). Nenhum código distribuído mudou.

## Causa 1: `write EPIPE`

O daemon falso da seção 8 (`startStubOldDaemon`) escreve a resposta num socket cujo cliente já fechou.
Sem `socket.on('error')`, o EPIPE vira `uncaughtException`. O processo de teste carrega o tratador de
`lib/daemon-lifecycle.cjs` (`hookProcess`), que imprime a pilha e faz `process.exit(1)`: a suíte morre
só quando o cliente fecha antes da resposta, daí passar sozinha e falhar na cadeia do `npm test`.
O daemon real já trata o erro (`adapters/daemon-server.cjs`: `socket.on('error', () => {})`).

Correção: o falso ganha o mesmo tratador. Regressão: 100 clientes conectam, escrevem e destroem o
socket; o caso falha com `write EPIPE` sem a correção (3 de 3 rodadas) e passa com ela.

## Causa 2: `EADDRINUSE` no endpoint padrão

`stopDaemon` esperava o daemon cair por 8 s e ignorava o resultado. Sob carga o daemon do teste
ainda segurava o pipe quando o falso tentava `listen`. Correção: `stopDaemon` encerra por PID os
processos que o próprio teste iniciou se o desligamento limpo não bastar, e lança erro se o pipe seguir
ocupado (fail-loud).

## Fontes

- Node.js, `net.Socket` evento `error`: https://nodejs.org/api/net.html#event-error (acesso 2026-11-07)
- Node.js, `process` evento `uncaughtException`: https://nodejs.org/api/process.html#event-uncaughtexception (acesso 2026-11-07)
