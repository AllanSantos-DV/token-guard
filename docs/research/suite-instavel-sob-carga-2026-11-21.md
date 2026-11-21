# Suíte instável sob carga: causas medidas (2026-11-21)

Pergunta: por que `dupread-subagent` e `daemon-swap` falhavam de vez em quando na cadeia do `npm test` e passavam sozinhos?

## Medição

`postprocess` pelo cliente do daemon (150 chamadas, sessões novas, home isolado): p50 12 ms, p90 190 ms, 7 a 10 de 150
estouravam os 200 ms do orçamento do hook (`connectOnce`), mesmo com a máquina ociosa. Dentro do processo, o perfil por
chamada mostrou ~75 `statSync` (poda varrendo a pasta de estado inteira a cada gravação) e `writeFileSync` com pico de 118 ms.

## Causas e correções

1. **Poda a cada gravação** (`lib/contract.cjs`, `lib/statedir.cjs`): um `stat` por arquivo de sessão, pasta que só cresce
   por sete dias. Agora `lib/prune.cjs` poda no máximo uma vez por hora por pasta (marcador `.pruned`). Depois: p50 5 ms,
   p90 7 ms, 0 estouros em 3 de 3 medições. `test/prune.test.cjs`.
2. **Rename por cima de arquivo em leitura falha com EPERM no Windows** (`adapters/daemon-http.cjs`, `writeJsonAtomic`):
   com um leitor ativo, 7265 falhas contra 829 renames em 7 s. O daemon engolia o erro e o endpoint (porta ou motivo de o
   HTTP não ter subido) nunca era gravado; o `swapDaemon` esperava 20 s e saía com "não respondeu o health". Agora o rename
   repete em EPERM/EBUSY/EACCES e lança se esgotar. `test/endpoint-write.test.cjs` falha sem a correção (2463 EPERM).
3. **Teste ocupava a porta cedo demais** (`test/daemon-swap.test.cjs`, passo "porta ocupada"): o daemon anterior ainda
   segurava a porta e o `listen` do teste lançava EADDRINUSE sem tratador. O teste espera o pid sair e repete o bind.

Nenhum timeout foi aumentado.

## Prova

Suíte completa com as três correções: 3 rodadas seguidas verdes (uma limpa, duas com 6 processos de CPU ocupados em
paralelo). Duas rodadas anteriores, só com as correções 1 e 2, também fecharam verdes sob carga; a terceira dessas caiu no
EADDRINUSE do item 3, que motivou a correção do teste.
Memória livre mínima medida: 7,3 GB de 31,9 GB.

## Fontes

- Reprodução local: scripts de medição e perfil de fs desta sessão (2026-11-21).
- Node.js `fs.rename` (Windows, EPERM com o destino aberto): https://nodejs.org/api/fs.html#fsrenameoldpath-newpath-callback (acesso 2026-11-21)
- Pesquisa anterior do projeto: `docs/research/daemon-followups-flaky.md` (stopDaemon fail-loud e tratador de EPIPE seguem valendo).
