# Troca do daemon no Windows sem janela de queda (2026-11-03)

Fontes (acessadas em 2026-11-03):
- https://beppetemp.github.io/cartographer/decisions/D266-a-windows-restart-waits-for-the-old-process-and-proves-the-new-one/
- https://github.com/special-place-ai-heaven/symforge/blob/main/SELF_UPDATE_PROCEDURE.md

Conclusão das duas: no Windows, parar o processo antigo com graça, trocar os arquivos, subir o novo e só
devolver quando o antigo largou a porta e o novo responde ao health informando a versão.

Incidente: após a 2.16.0 o daemon ficou ~7 min fora (arquivos trocados às 15:41, daemon novo às 15:48:18 pelo
`TokenGuardDaemonWatch`); hooks http com conexão recusada; sem registro de partida/saída.
Precedente: whatsapp-bridge `2026-10-25-daemon-derrubado-pelo-msi-do-node.md` (MSI do Node derruba o daemon
via RestartManager/SIGHUP; só volta no relançamento manual).

Aplicação: `swapDaemon` no fim do init (shutdown → espera sair → kill só por pid provado → spawn → health com
versão esperada e pid diferente) e `~/.token-guard/daemon.log`.
