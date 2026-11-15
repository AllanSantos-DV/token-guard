# Troca do daemon sem fechar a porta, ociosidade com sessão viva e URLs antigas (2026-11-15)

Origem: investigação de hooks sem dono e lentidão (2026-11-14, projeto de investigação), achado 5 do token-guard.
Material reaproveitado: `troca-do-daemon-no-windows-2026-11-03.md` (espera do antigo sair + prova do novo pelo health
com versão e pid) e `refusal-hook-decisions-2026-10.md` (o hook que falha tem de dizer de quem é).

## Medições

- `~/.token-guard/daemon.log`: 59 subidas, 44 saídas por `shutdown solicitado` (trocas de versão), 14 `previous-unclean`,
  **nenhuma saída por ociosidade**. Com token de hook http o daemon já não sai por ociosidade (`idleTimeoutFor`); a
  janela entre o `exit` do antigo e o `http-on` do novo era de ~0,2 s, mas é nela que caem ECONNREFUSED/ECONNRESET.
- Windows: dois processos não fazem bind na mesma porta TCP (testado: `EADDRINUSE`). Passar o socket de escuta ao filho por
  IPC (`child.send(msg, server)`) funciona e o filho segue vivo depois que o pai sai (testado em Node 24, Windows 11). Handle
  de named pipe não passa, então o pipe dos hooks de comando continua com uma troca curta (os clientes já reabrem o daemon).
- URLs antigas sem origem: varredura de `settings.json`/`settings.local.json` de todos os 131 projetos de `~/.claude.json` e
  de `~/.claude/settings.json`: **nenhuma** URL `/token-guard/pre|post` sem `hook-origin` em disco (só uma cópia de backup
  em outro projeto). `hooksRepointed:0` é o resultado correto: não há o que reapontar. As 2.089 execuções vêm de sessões
  abertas antes do reapontamento, que mantêm a URL antiga em memória até reiniciar; o daemon segue atendendo a rota.

## Decisões

1. Troca sem queda: RPC `handover` no daemon em pé (só aceita o `daemon-server.cjs` de uma instalação do token-guard).
   Ele sobe o sucessor com IPC, lhe entrega o socket do HTTP, espera a confirmação, passa a responder `Connection: close`,
   fecha o que sobrou depois de 1 s e sai. Falhou, segue servindo e grava `handover-failed`. `swapDaemon` tenta o handover
   primeiro e cai no caminho antigo com o motivo em `handoverFallback`.
2. Ociosidade: o daemon só sai quando não há sessão viva (`lib/sessions-alive.cjs`: pid dos registros do Claude Code;
   lock exclusivo de thread do Codex, só Windows).
3. Origem: erros do hook http e do cliente começam com `[hook-origin=token-guard]`; os hooks de comando já levam
   `--hook-origin=token-guard` (migração no instalador, coberta por `hook-origin.test.cjs`).

Fontes: Node.js child_process, `subprocess.send(message, sendHandle)` (https://nodejs.org/api/child_process.html#subprocesssendmessage-sendhandle-options-callback, acessado em 2026-11-15).
