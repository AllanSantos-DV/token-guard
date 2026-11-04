# R7 · Dono único por regra — SDD + ADR em fases

Origem: investigação "regras por escopo via mcp-memory" (2026-11-03). A regra de comentários chegava
duas vezes (instruções globais + seção `codigo`), e o algoritmo de entrega (uma vez por escopo,
reinjeção em compact/clear) precisava de contrato escrito para o Boss e o `harness-padroes-cliente`
copiarem.

## Spec

- Cada regra tem um dono e um canal (`docs/CONTRACT.md`, "Dono de cada regra").
- Nenhuma regra chega duas vezes na mesma janela, por nenhum caminho de entrega.
- Quem já recebe uma seção por outro canal a desliga com `contract.skip`.
- Toda injeção é rastreável: origem, motivo, seções e tamanho.

## Reuso (já existia, não foi recriado)

`lib/contract.cjs` (escopo por evidência, estado por sessão, `resetInjected`), hooks http do daemon
(um processo para todas as sessões), `--hook-origin=token-guard`, `test/contract-compaction.test.cjs`.
A 2.16.6 já tirara a regra de comentários do padrão.

## Fases

| Fase | Entregável | Prova |
|---|---|---|
| 1 | Tabela de donos + `contract.skip` na config | `test/contract-ownership.test.cjs` (skip cala a seção, as outras seguem) |
| 2 | `CT.commitInjection` como escrita única de `injected` (comando, http, Copilot) | mesmo teste, pelos dois caminhos; mutação que remove a escrita derruba 5 checagens |
| 3 | `injections.jsonl` com origem, motivo, seções, caracteres | mesmo teste (início vs. reinjeção) |
| 4 | Contrato do algoritmo documentado | `docs/CONTRACT.md`, "Algoritmo de entrega" |

## Fora de escopo

Regras do usuário no mcp-memory (é do Boss); detecção automática de duplicata contra o arquivo de
instruções do usuário (o `skip` declarado é determinístico, a comparação por texto não).
