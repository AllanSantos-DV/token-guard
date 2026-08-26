> Status: **PLANO · Rev.5** — rodadas: #1 achou 5 mandatórios (aplicados na
> Rev.2), #2 achou 2 MAJOR + shoulds (aplicados na Rev.3), #3 achou 4 textuais
> (parcialmente aplicados na Rev.4), #4 auditou a Rev.4 e pegou a aplicação
> incompleta + 1 nova contradição — TUDO corrigido nesta Rev.5. Próximo passo:
> revisão #5 de fechamento — meta LIMPA.
> Fase: R5 do roadmap de mercado (docs/MARKET.md › Roadmap resultante, linha R5)
> Regra da fase: rodadas de revisão devem REDUZIR achados. Zero libera código.
> Tese: o replay atual (bench/replay-transcripts.cjs) estima custo por teto
> (25k tok); os JSONL do Claude Code trazem o `tool_result` INLINE com o texto
> completo — dá para medir os BYTES REAIS que cada resultado custou (a única
> parte não-estimada; o overhead dos denies segue estimado e rotulado), e
> portanto a economia REAL que os guards teriam evitado.

---

## 1. Problema

O replay v1 responde "quantas chamadas seriam barradas" com precisão (o decide()
é real), mas a ECONOMIA continua sendo `min(bruto, 25k)` — uma estimativa. A
pergunta do dono é mais dura: **quantos bytes de tool result entraram
desnecessariamente nas janelas reais?** O JSONL tem a resposta: cada
`tool_result` traz o conteúdo que o harness efetivamente devolveu.

## 2. Formato verificado no corpus (campos reais)

- Entrada assistant: `message.content[]` com blocos `tool_use {id, name, input}`.
  **Uma única linha pode carregar dezenas de tool_use** (medido: 86 num caso
  real — chamadas paralelas).
- Bloco `tool_result {tool_use_id, content}` onde `content` é string OU array
  misto: `{type:'text', text}` E `{type:'tool_reference', tool_name}` (~1,6%
  dos results no maior arquivo). Blocos não-texto EXISTEM e precisam de conta.
- `isSidechain` é campo TOP-LEVEL da entrada (não dentro de message) — marca
  sub-agentes (contexto separado), contagem própria.
- Nem todo tool_use tem result pareado (sessão truncada/compactada): órfãos
  descartados e CONTADOS.

## 3. ADR-005: replay v2 como EXTENSÃO do v1, não substituto

### Decisão
`bench/replay-transcripts.cjs` ganha modo **--real-bytes** que:
1. **Coleta em duas passadas por arquivo** (arquivo já lido inteiro via
   readFileSync): passada 1 constrói mapa global `id → result`
   (**order-independent** — resultado pode chegar antes/depois/de outra linha;
   id duplicado = primeira ocorrência vence); passada 2 percorre os tool_use e
   pareia pelo mapa;
2. Roda o decide() ATUAL sobre cada tool_use (como hoje);
3. **Roteia pelo verdict.decision**: `'deny'` soma `bytes(result)` em
   `avoidedRealBytes`; `'ask'` E `'allow'` somam em `enteredRealBytes` (em warn
   o resultado ENTRA na janela; em allow, idem);
4. Reporta `pairedCalls`, `orphanCalls`, `orphanResults`, `sidechainCalls`,
   `sidechainBytes`,
   distribuição P50/P90/P99/max dos bytes por resultado (população: TODOS os
   results pareados NÃO-sidechain — watched ou não; o que entra, entra), e
   `nonTextResultBlocks` (blocos não-texto contados).

### Conta de bytes por content (fecha bloco não-texto)
string → Buffer.byteLength(s) · array → soma dos `.text` dos blocos text +
JSON.stringify de cada bloco não-texto (contados em `nonTextResultBlocks`) ·
bloco text sem `.text` → 0 · null/ausente → 0.

### Estado do guard pinado (fecha D1 — fecha F3 na porta env E na porta config)
O replay exige **semântica block/default** para o dado ser reprodutível:
1. Boot: `TOKEN_GUARD` setado (qualquer valor, case-insensitive, string vazia
   conta como não-setada) → **falha loud** (exit 1).
2. Após o scan: para cada cwd distinto encontrado nos transcripts,
   `CFG.load(cwd)` → se `mode !== 'block'` → **falha loud listando os caminhos
   e as fontes de config** (repo config com warn/off viesaria deny→ask ou
   zeraria tudo pela outra porta). Sem isso, dois engenheiros rodam o mesmo
   corpus e produzem métricas-chave diferentes.

### Por que extensão e não v2 separado
Mesmo parser, mesmo corpus, mesmo decide() — a flag apenas liga o pareamento
por id. O modo default (sem --real-bytes) permanece idêntico ao atual para
compatibilidade.

### Alternativas descartadas
| Alternativa | Por que não |
|---|---|
| Medir tokens com tokenizer real | zero-deps é princípio; chars/4 já é a convenção do projeto e basta para COMPARAR antes/depois |
| Incluir sub-agentes na mesma conta | janelas distintas; contaminaria a métrica principal (contados à parte) |
| BigResult no replay | resultado truncado pelo harness ≠ resultado no JSONL; sem ground truth confiável |
| Pairing por adjacência de linha | irreal: 86 uses numa linha, results batched em user-lines seguintes |

## 4. Contratos

```
node bench/replay-transcripts.cjs [--real-bytes] [--json] [dir]
```
Saída nova (modo --real-bytes), além da atual:
```
PAREAMENTO: X/Y chamadas com resultado pareado (Z órfãs · S sidechain)
BYTES REAIS (bytes UTF-8; população = todos os results pareados não-sidechain):
  P50/P90/P99/max · avoided total
ECONOMIA LÍQUIDA REAL: (avoided − denyOverhead) convertidos via chars/4
  — o overhead continua estimado e está rotulado como tal
```
--json ganha campos equivalentes (`pairedCalls`, `orphanCalls`,
`orphanResults`,
`sidechainCalls`, `sidechainBytes`, `enteredRealBytes`, `avoidedRealBytes`,
`p50/p90/p99/max`, `nonTextResultBlocks`). Unidades rotuladas (bytes vs tok).
**Sidechain**: bytes EXCLUÍDOS de avoided/entered/percentis (métrica própria
`sidechainBytes`) — janela separada.

TOKEN_GUARD: o bench **falha loud no boot** se env estiver setado (off zeraria
tudo; warn mudaria roteamento) — dado real exige guard no estado default.

Regras de robustez: content array → soma `.text` + stringify não-texto;
content ausente → 0 bytes; linhas corrompidas → pular; id duplicado → primeira
ocorrência vence.

## 5. Plano de testes (failing-first)

Fixture JSONL sintético mínimo + asserts:
1. Pareamento por id correto (2 uses, 2 results, ids fora de ordem no stream).
2. Deny conhecido (glob **/*) soma `avoidedRealBytes` = bytes do result real.
3. Allow soma `enteredRealBytes`; ask (warn) também soma `enteredRealBytes` (roteamento).
4. Órfão use-sem-result contado em `orphanCalls`; result-órfão contado em `orphanResults`.
5. content array multi-blocos soma todos os `.text`.
6. Array com bloco não-texto (tool_reference) → bytes do stringify contados + `nonTextResultBlocks` incrementado.
7. Bloco {type:'text'} sem `.text` → contribui 0 (sem NaN).
8. isSidechain separado (top-level): calls e bytes fora das métricas principais.
9. Modo default (sem --real-bytes) imutável.
10. 86 tool_use numa linha + results batched em user-line seguinte → todos pareados.
11. id duplicado → primeira vence.
12. TOKEN_GUARD setado no boot → exit 1 loud com mensagem clara.
13. Config warn/off num fixture-repo → falha loud PÓS-SCAN listando cwd+fonte.
14. Result antes do use no stream → pareia igual (order-independent).
15. Linha corrompida no meio do stream → pulada, replay segue.


## 6. Métricas de sucesso

Rodar sobre o corpus real (~65 sessões): reportar P50/P90/P99/max REAIS,
% dos bytes que seriam evitados, e comparar com a estimativa capped do v1
(a diferença vira dado sobre quão boa era a estimativa).

## 7. Fora de escopo (v1)
Copilot events.jsonl (replay-copilot.cjs já mede bytes reais nativamente);
sub-agentes como sessões próprias; tokenizer real.

## 8. Checklist de liberação

- [x] Revisão #1 — 5 mandatórios aplicados na Rev.2 (pairing global, fallback não-texto, TOKEN_GUARD loud, roteamento deny/ask, 6 testes novos com dados reais do corpus)
- [x] Revisão #2 — APPROVED WITH CHANGES: 2 MAJOR (D1 config pin duplo, D2 sidechain bytes) + shoulds aplicados na Rev.3
- [x] Revisão #3 — APPROVED WITH CHANGES: 4 must-fix textuais aplicados PARCIALMENTE na Rev.4 (2 de 4; verificação da #4 pegou a incompletude)
- [x] Revisão #4 — auditou a Rev.4: pegou aplicação incompleta + 1 nova contradição de população; TUDO corrigido na Rev.5
- [ ] Revisão #5 de fechamento — meta LIMPA
- [ ] Implementação failing-first (§5)
- [ ] Rodada final sobre corpus real com números no README (seção economia)
