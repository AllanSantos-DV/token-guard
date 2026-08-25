# R3 · Anti-boilerplate / Reuso no Contrato — Spec-Driven Development

> Status: **PLANO · Rev.3 — APPROVED WITH CHANGES pela revisão #3** (único
> must-fix D1: este cabeçalho; aplicado). Substantivo verificado limpo
> empiricamente pela #3 (chars/tokens/regras/ordem/gate/âncoras).
> Próximo passo: revisão #4 de fechamento — meta LIMPA.
> Fase: R3 do roadmap de mercado (docs/MARKET.md · R1 §11)
> Regra da fase: rodadas de revisão devem REDUZIR achados. Zero libera mudança.
> **Particularidade desta fase**: é quase toda editorial (contract.default.md).
> O "código" aqui são PALAVRAS que entram na janela de TODA sessão — então o
> custo-benefício por regra é o coração da spec, não um detalhe.

---

## 1. Problema

Reescrita e regarimpo são os custos invisíveis: uma função utilitária recriada
pela 5ª vez, uma decisão arquitetural re-explorada a cada sessão porque ninguém
registrou onde ela vive. Instrução certa no momento certo economiza SAÍDA (não
reescrever) e ENTRADA FUTURA (não regarimpar).

O dono pediu explicitamente: padrão anti-boilerplate, padrão de reuso,
padrão de documentar para evitar garimpar o codebase inteiro — aplicados via
UserPromptSubmit/injeção de contrato.

## 2. Gap analysis — o que o pedido pede vs o que JÁ EXISTE

O `contract.default.md` atual (seção `quando: codigo`) JÁ CONTÉM:

| Tema pedido pelo dono | Já coberto? | Texto existente |
|---|---|---|
| Preferir abstração existente | ✅ parcial | "A abstração que já existe é preferida mesmo quando não é a primeira que ocorre." |
| Consultar antes de criar helper | ✅ parcial | "O repositório é consultado antes de nascer um helper." |
| Documentar p/ evitar garimpo | ❌ **gap real na sessão de código** | `quando: docs` vizinha já diz "decisão datada vive no CHANGELOG ou num ADR" — mas ela só dispara tocando .md; sessão de código puro não recebe |
| Centralizar código chamado N vezes | ⚠️ metade | cobre "preferir a que existe", NÃO cobre "ao extrair, extrair para lugar reutilizável e registrar onde ficou" |

**Conclusão do gap**: faltam exatamente DUAS ideias novas — (G1) extrair-para-
reusar-e-registrar; (G2) decisão relevante vira registro curto que elimina a
re-exploração da próxima sessão. Todo o resto do pedido já está coberto —
duplicar seria o boilerplate que o kit combate.

## 3. Mercado (citado)

| Fonte | Suporte |
|---|---|
| Anthropic — Effective context engineering | structured note-taking/agentic memory como técnica oficial p/ long-horizon; "smallest set of high-signal tokens" |
| codebase-memory-mcp (benchmark) | exploração indexada ≈120× mais barata que grep-and-read — registrar ONDE as coisas estão é o pré-requisito disso |
| gist johnlindquist (−54% contexto inicial) | gatilhos > documentação verbosa — regras novas devem ser densas e disparáveis |
| DRY como economia | cada duplicata diverge, e todas passam a ser lidas (já no contract: "função duplicada é a forma mais cara de lixo") |

## 4. ADR-003: Duas regras novas na `quando: codigo`, zero seção nova

### Por que dentro da seção existente
Seção nova (`## quando: refactor`) criaria outro bloco-base injetável (+custo
fixo por sessão) e fragmentaria o gatilho (sessão de código já dispara
`codigo`). As duas ideias pertencem semanticamente à `quando: codigo`.

### Custo × benefício por regra (o filtro desta fase — valores MEDIDOS pelo estimador do próprio CLI, convenção COM prefixo `- `)

| Regra | Redação (chars c/ prefixo) | Custo injetado | Economia esperada | Veredito |
|---|---|---|---|---|
| G1 extrair-p/-reusar-registrando | 134 → ~34 tok/sessão | +34 tok fixos | 1 função-utilitária não reescrita paga centenas–milhares | entra |
| G2 decisão→registro curto | 150 → ~37 tok/sessão | +37 tok fixos | elimina re-exploração de decisão na sessão seguinte | entra |
| **Total** | **284 chars** | **≈ +71 tok/sessão** ✅ ≤ +80 | assimetria favorável | — |
| Demais ideias do brainstorm (checklists de reuso, exemplos) | >300 tok | marginal/duplicado | ficam de fora |

Total adicionado medido independentemente pela revisão #2: **+71 tok/sessão
(527→598 na sempre+codigo)** — dentro do critério ≤ +80. Assimetria favorável.

### Redação (AFIRMATIVA — passa no gate anti-imperativo; asserção fica no §6.1)

**COLAR COMO LINHA ÚNICA** (o parser só junta continuação INDENTADA — colar
quebrado na coluna 0 trunca a regra ao meio, verificado na revisão #2):

G1 (após a regra da abstração existente):
`- Código extraído para reuso vai ao lugar canônico do projeto e o caminho fica registrado — a próxima construção começa do que existe.`

G2 (fechando a seção):
`- Decisão de arquitetura ganha registro curto e datado (ADR/nota) com o porquê e onde as peças vivem — a próxima sessão lê o mapa em vez de refazê-lo.`

Ambas: afirmação descritiva (não imperativo), densas, sem exemplo verboso
(padrão das vizinhas).

### Alternativas descartadas
| Alternativa | Por que não |
|---|---|
| Seção nova `quando: refactor` | custo fixo extra + fragmentação de gatilho |
| Regras no `sempre` | valem só para código; poluiriam prosa/e-mail |
| Delegar ao skill token-economy | skill é opt-in e não é injetada; o contrato é o canal garantido |
| Mais de 2 regras | cada linha custa para sempre; filtro custo×benefício cortou o resto |

## 5. Impacto medido (antes/depois obrigatório)

```bash
npx @allansantos-dev/token-guard contract --json   # ANTES: anotar tokens/seção (baseline: codigo = 353 tok)
# aplicar as duas regras (linha única cada, §4)
npx @allansantos-dev/token-guard contract --json   # DEPOIS: codigo = 425 tok ⇒ delta +72 ≤ +80
```
Critério: delta total do contrato ≤ +80 tok/sessão (≈0,04% da janela).

## 6. Plano de testes

1. Existente: "o contrato padrão não abre regra em modo imperativo" — DEVE continuar passando com as duas redações novas (rodar antes/depois).
2. Parsing: `quando: codigo` cresce de 9 para 11 regras; ordem preservada (G1 entre as regras de abstração; G2 por último).
3. **OBRIGATÓRIO e automatizado** (sem válvula manual — foi a asserção que teria pego o F1): script no teste de carga mede `tokens(when.codigo)` via CT.load/render + estimador do CLI e **falha se delta > +80 tok** vs baseline anotado aqui (9 regras).
4. Injeção ponta a ponta: prompt-hook/plugin entrega sempre+codigo com as regras novas. Verificação do conteúdo G1/G2 **via CT direto** (`node -e` com CT.load+decide+render, touched=['lib/x.cjs'], assert text inclui "lugar canônico" e "registro curto") — o `--json` do CLI não expõe `would.text`.

## 7. Riscos

| Risco | Mitigação |
|---|---|
| Redação cair em imperativismo e vazar (prompt injection defense) | teste existente de imperativos roda na suíte |
| Regras genéricas ignoradas pelo modelo | densidade + especificidade (padrão das vizinhas); mercado valida instrução densa |
| Custo fixo somando release após release | ESTA spec institui o filtro custo×benefício (§4) como porta de entrada — futuro backlog item: auditoria periódica do contract |

## 8. Fora de escopo (v1)
Seção nova de refactor; integração com memory server no texto do contract
(R2 cuida pelo status); tradução EN do contract (pt-BR é a língua do produto);
mudança nos gatilhos de evidência.

## 9. Checklist de liberação

- [x] Revisão #1 desta spec — F1 major (matemática) + F2/F3/F4 tratados na Rev.2
- [x] Revisão #2 (re-gate) — APPROVED WITH CHANGES: N1/N2/N3 must-fix + N4/N5 aplicados na Rev.3
- [x] Revisão #3 — APPROVED WITH CHANGES: único must-fix D1 (este cabeçalho), aplicado; substantivo verificado limpo empiricamente
- [ ] Revisão #4 de fechamento — meta LIMPA
- [ ] Redações finais passam no gate anti-imperativo (teste rodado)
- [ ] Delta medido ≤ +80 tok/sessão documentado (§4: ~71)
- [ ] CHANGELOG: entrada da mudança de contract.default.md + decisão de bump
- [ ] Nota explícita: projeto com `contract.md` próprio substituindo `quando: codigo` NÃO recebe G1/G2 (semântica de substituição de seção inteira)
- [ ] Fix menor aproveitado da rodada: comentário defasado do prompt-hook.cjs (:12-15) sobre injeção por evidência
- [ ] Dono aprova as duas redações finais (é conteúdo editorial dele)
