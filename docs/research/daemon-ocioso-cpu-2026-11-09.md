# Daemon ocioso e CPU — 2026-11-09

## Causas
1. **Dois daemons:** eram daemons de teste órfãos (HOME isolado, execuções de `npm test` abortadas). Daemon com
   token http não tem autoencerramento por ociosidade, então nunca saem sozinhos.
2. **CPU parada:** com a pasta do perfil apagada, o `fs.watch` da pasta de config (daemon-ui) recebe `rename` em
   laço no Windows, sem `error`. Reprodução isolada em `watch.cjs`: o laço só termina fechando o watcher.
3. **Spawns de node:** os hooks reais do Claude Code já são `type: http` (porta lida do `daemon-http.json`); os
   spawns `token-guard.cjs`/`post-hook.cjs` vêm da suíte de testes.

## Antes e depois (daemon com http, perfil apagado, 4 s de amostra)
- Antes: 3,48 s de CPU em 4 s. Depois: abaixo de 0,5 s (teste `daemon-idle-cpu.test.cjs`, 2 passaram).

## Spawns de uma execução completa de `npm test`
302 token-guard.cjs · 138 post-hook.cjs · 53 daemon-server.cjs · 36 prompt-hook.cjs · 28 hook-cmd.cjs ·
15 session-start.cjs · 5 subagent-start.cjs.

## Mudanças
- `daemon-ui.cjs`: watcher fecha se a pasta sumiu; batimento do stream só com clientes.
- `daemon-server.cjs`: ociosidade por `setTimeout` único reagendado.

## Como os docs anteriores foram aplicados
- Investigação do orquestrador: forneceu a amostra de CPU e a atribuição node←node.
- `tela-setup-bandeja-2026-10-30.md`: descreve o `fs.watch` da pasta de config e o stream da tela, onde está a causa.
