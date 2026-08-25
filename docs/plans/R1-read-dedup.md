# R1 · Dedupe de Leitura — Spec-Driven Development

> Status: **PLANO · Rev.4 — APROVADO pela revisão #4** (zero bloqueantes;
> fixes cosméticos N1-N4 aplicados e verificados pela revisão #5, que achou
> apenas 3 itens de consistência de trilha/cabeçalho — corrigidos aqui).
> **Liberado para implementação.**
> Fase: R1 do roadmap de mercado (docs/MARKET.md)
> Regra da fase cumprida: achados totais por rodada 13 → ~12 → 10 → 4 → 3
> (todos os 3 da última são de trilha/formatação; bloqueantes = 0 desde a
> rodada #2). Trilha completa na §11.

---

## 1. Problema

Agentes relêem o mesmo arquivo várias vezes na mesma sessão — por esquecimento,
retentativa após truncamento, ou pedido de outro sub-agente. Cada releitura paga
o arquivo inteiro de novo. O plugin community `token-saving-hooks-claude-code`
fez dessa deduplicação sua feature principal; nenhum número nosso mede hoje
quanto do volume lido é redundante (§7 provisiona a medição).

## 2. Pesquisa de mercado

| Fonte | Prática validada |
|---|---|
| `token-saving-hooks-claude-code` | file-read deduplication como feature principal |
| `claude-context-manager` | cache de leituras grandes com stub (`READ_THRESHOLD=25000`) |
| Anthropic — context engineering | "não re-verifique o que já está estabelecido na sessão" |
| Anthropic — writing tools | truncamento/caps DEVEM steerar com instrução útil |

## 3. ADR-001: Duas camadas, semânticas diferentes (Rev.2)

### Decisão

**Camada A — `dupRead` (PostToolUse, ON por default).**
Dedupe por HASH DO CONTEÚDO INTEGRAL. Se o resultado integral de uma leitura for
idêntico ao último resultado INTEGRAL da mesma origem na mesma sessão, substituir
por stub que CARREGA O CAMINHO (nunca "see above" — a cópia anterior pode ter
sido evictada por compaction):

```
[dupRead] conteúdo idêntico à leitura anterior de <path> (N chars não relidos).
Precisa de precisão? releia com faixa (view_range/offset+limit).
(PT-BR) idêntico à leitura anterior de <path>...
```

**Camada B — `reRead` (pré-execução, OFF por default, escopo reduzido).**
Aviso advisory ANTES de repetir leitura integral grande já feita. Implementada
NO ADAPTER (não em rules.cjs — ver §5B), apenas quando `mode === 'warn'`
(em `block`, o blindRead já nega pré-execução; em `off`, nada roda).

### Ordem de pipeline bigResult × dupRead (fecha achado crítico #1)

Ordem fixa e exclusiva por chamada:

1. **checkDup primeiro**: se duplicata → retorna SEU próprio stub e **bigResult
   NÃO roda** para esta chamada (conteúdo duplicado não precisa de truncamento).
   Contabiliza em `savedReal` (substituição confirmada) ou `savedAdvisory`
   (incerta) conforme a tabela abaixo; somente se o harness tem substituição
   confirmada (§4 coluna "conta?").
2. **Não-duplicata**: grava hash do conteúdo INTEGRAL no estado, DEPOIS roda
   `bigResult/postProcess` normalmente. Nada é creditado aqui.
3. Regra de composição: **um único `modifiedResult`/`updatedToolOutput` por
   chamada**, sempre o do módulo que agiu. Nunca stub-de-stub.
4. Hash é SEMPRE do conteúdo integral (nunca do stub truncado) — assim a
   segunda leitura do mesmo arquivo dedupe corretamente mesmo que a primeira
   tenha sido truncada pelo bigResult.
5. Apenas leituras INTEGRAIS atualizam o mapa de hashes (leituras com range
   nunca sobrescrevem — política explícita, fecha o caso full→range→full).

### Contagem honesta por harness (fecha achado crítico #2)

`updatedToolOutput` no Claude Code está **quebrado para ferramentas built-in**
(anthropics/claude-code#67442, dup de #32105/#36843). Portanto:

| Harness | Substituição confirmada? | Conta em? |
|---|---|---|
| Copilot plugin (`modifiedResult`) | ✅ sim | ✅ real |
| Copilot repo (hooks.json modifiedResult) | ✅ sim (docs GitHub) | ✅ real |
| Claude Code | ⚠️ incerto (#67442) | contabiliza em `savedAdvisory` separado; nunca em `savedReal` |
| Cursor (additional_context) | ❌ contestado (#155689/#158168) | `savedAdvisory`; go/no-go pelo **§6.13** |

docs/IDES.md mantém "⚠️ orienta" para o CC command hook até evidência contrária;
README recebe nota "#67442: built-ins podem ignorar".

### Alternativas descartadas
(mantidas da Rev.1: deny default, mtime-only, cache global, Layer-B-em-rules —
esta última agora formalizada como decisão: Layer B vive no adapter, §5B.)

## 4. Contratos por harness (Rev.2 — session keys e canais verificados)

| Harness | Camada A | Conta? | Session key |
|---|---|---|---|
| Claude Code (command hook) | `updatedToolOutput` otimista + `additionalContext` sempre | advisory | `session_id` do payload (presente no schema comum); fallback hash-da-raiz (paridade com prompt-hook — tarefa T-B1) |
| Copilot plugin | `modifiedResult:{resultType:"success",textResultForLlm}` | ✅ real | `invocation.sessionId` |
| Copilot repo (hooks.json) | `postToolUse.modifiedResult` — **requer wiring novo**: registrar evento + adaptar parser (snake_case `tool_result.text_result_for_llm`) — tarefa T-A1 | ✅ real | `sessionId` presente no payload (verificado na referência GitHub) |
| Cursor IDE | `postToolUse.additional_context` APENAS (resultado não-substituível fora de MCP); efetividade contestada (#155689/#158168) → gate **§6.13** é go/no-go; wiring na tarefa **T-C2** (não implementável antes dela) | advisory | `conversation_id` (schema comum do Cursor); **sem ele: dedupe DESLIGADO** e surfaced no README/IDES (evita vazamento entre conversas) |
| Cursor CLI / MCP | fora de escopo v1 | — | — |

Tarefas de wiring itemizadas: **T-A1** registro+parsing do cell repo;
**T-B1** fallback de sid no post-hook; **T-C1** extração de sessionId no
hook-cmd; **T-C2 (gated pelo §6.13)** — corpo: (i) branch `postToolUse` no
`cursor-hook.cjs` extraindo `tool_name`/`tool_input`/`conversation_id` do
schema comum e respondendo `{"additional_context": "<stub>"}` (único campo de
substituição/aviso disponível); (ii) registro do evento `postToolUse` em
`~/.cursor/hooks.json` e project hooks.json pelo install.cjs (mesmo padrão dos
demais eventos, idempotente); (iii) extração de `conversation_id` como session
key com fallback DESLIGADO (sem id → dedupe inativo + surfaced); (iv) surfacing
da condição desligada no README/IDES.

## 5. Especificação técnica

### 5A. lib/dupread.cjs (novo; I/O limitado ao estado)

Gravação de hash é INCONDICIONAL para leituras integrais (hash é barato e a
Camada B precisa do mapa mesmo com dupRead desligado); as flags controlam
apenas stub e hint.

```
originKey(root, target)
  = sha1( normalize(resolve(root,target)) )
  normalize(): backslashes→'/', drive-letter lowercase, case-fold SE win32/darwin
  (FOLD_CASE já existente em rules.cjs:37 — mesma semântica, helper próprio).
  Symlink/realpath: NÃO resolvido (política explícita: aliases dedupe-missam de
  propósito; realpath trocaria identidade entre mounts).
  Multi-root: origem inclui o root usado pelo adapter (workspace_roots[0] no
  Cursor é limitação documentada do harness).

noteResult({ name, input, result, root, sessionId, cfg })
  → null | { duplicate:true, originKey, savedReal | savedAdvisory }
  SOMENTE família read (FAM.read). Alvo extraído por P.inputPath. Result
  vazio/não-stringificável → null. Leituras com faixa (P.hasReadRange) NEM
  gravam NEM criam origem no mapa (fecha F6). Gravação ATÔMICA (temp+rename)
  em .token-guard/sessions/<safe>-reads.json (<safe> herda o sufixo hash do
  stateFile — fecha F8):
    { "_total": { savedReal, savedAdvisory, hints }, [originKey]: {hash, at, count} }
  cap 32 origens LRU; chama pruneState(dir) após escrever (fecha achado poda).

checkDup({ name, input, result, root, sessionId, cfg })
  → null | { duplicate:true, stub, savedMode:'real'|'advisory' }
  compara hash integral; stub carrega <path> (nunca "see above").

checkRepeat({ name, input, root, sessionId, cfg })   // Camada B (adapter-level)
  → null | hint   // só se rules.reRead && size>reReadMinBytes && origem no mapa
```

### 5B. Camada B no adapter (fecha achado alto #5)

Implementada em `adapters/hook-cmd.cjs`/plugin `onPreToolUse` APÓS o decide().
Condição POSITIVA (fecha F2): `mode === 'warn'` e decide() null e checkRepeat()
bateu → emite hint advisory. Em `block`, blindRead já nega a leitura inteira
pré-execução; em `off`, nada roda. Interação warn documentada: se o usuário
confirmar o ask do blindRead, não há reRead hint nessa chamada — aceitável.

Wire format por harness (fecha F5):
- Claude Code PreToolUse: `{hookSpecificOutput:{hookEventName:'PreToolUse', additionalContext}}` — suportado desde v2.1.9.
- Copilot plugin onPreToolUse: `permissionDecision:"allow"` + a hint dentro de `permissionDecisionReason` (`additionalContext` é descartado nesse evento — #2585).
- Contagem: hints entram em `_total.hints` (não em savedReal/savedAdvisory).

**rules.cjs e o contrato evaluate()/decide() permanecem intactos**; session_id
entra no adapter direto do payload (sem tocar ctx de rules).

### 5C. Config (defaults + plumbagem completa)

```json
"rules":    { "dupRead": true, "reRead": false },
"limits":   { "reReadMinBytes": 51200 }
```
`dupRead/reRead` entram em `DEFAULTS.rules` **com coerção por chave no sanitize
(fecha F7): valor não-booleano cai no default individual, sem descartar as
outras regras**; `reReadMinBytes` entra no loop numérico de `DEFAULTS.limits`.
Espelhados em `config.default.json`. Precedência da coerção (fecha D7):
spellings falsy reconhecidas (`false/'false'/0/'off'`) coerem para `false`;
outros não-booleanos caem no default individual da chave (`dupRead`→`true`,
`reRead`→`false`). Flag tolerante herdada do padrão bigResult.

## 6. Plano de testes (failing-first)

1. dupRead básico: idêntica→stub+saved; diferente→passa e atualiza hash; 3ª idêntica→stub de novo.
2. **Ordem**: resultado 100k chars duplicado → stub do dupRead, bigResult NÃO aplica truncamento (um modifiedResult só); resultado 100k NOVO → bigResult trunca, hash gravado é do INTEGRAL; próxima leitura igual → dedupe funciona.
3. Range nunca sobrescreve NEM cria: full→range→full ⇒ 3ª é dedupe; range como PRIMEIRA leitura ⇒ origem não criada (full seguinte grava normal).
4. originKey: mesmo arquivo por caminho relativo/absoluto/backslash/caixa (win32) → MESMA chave; raízes distintas → chaves distintas.
5. Session keys: CC com/sem session_id (fallback raiz); Cursor sem conversation_id → desligado; dois conversation_ids isolados.
6. Repo cell (pós T-A1): envelope snake_case parseado; modifiedResult emitido. *(gate: implementação)*
7. Concorrência leve 4× mesma origem → estado íntegro (última vence, hash igual inofensivo).
8. Fail-open: circular, root ausente, estado corrompido, sid hostil → null/silêncio.
9. Config: lixo em dupRead/reRead/reReadMinBytes → defaults individuais.
10. Poda: writes chamam pruneState; TTL remove.
11. EPIPE/stdin-timeout nos adapters (convenção epipe.test.cjs).
12. Métricas: _total separa real × advisory; status do plugin/MCP exibe.
13. **Go/no-go Cursor additional_context (executa ANTES de implementar a célula Cursor/T-C2)**: estímulo = **duas leituras integrais idênticas do mesmo arquivo acima de N chars** (dupRead exige par idêntico; uma leitura só não produz stub). PASS = o `additional_context` do 2º par aparece no contexto/transcript do agente → célula Cursor sai de advisory-only para implementação via T-C2; FAIL/indeterminado → célula permanece advisory + nota #155689/#158168 no IDES. Re-executar a cada major do Cursor.

*(nota: cada Read passa a fazer 2 RMW de estado — custo ≪ 1 ms, aceito e documentado.)*

## 7. Métricas de sucesso (dado real)

- Baseline ANTES da feature: % de bytes duplicados medidos no corpus real
  (extensão do replay para parear tool_use↔tool_result por id).
- Pós: `_total.savedReal/savedAdvisory` por sessão; critério de aceite:
  ≥1 caso real dedupado, FP = 0 na auditoria manual, e savedReal > 0 em
  pelo menos um harness de substituição confirmada.

## 8. Riscos

| Risco | Mitigação |
|---|---|
| Eviction do contexto invalida "veja acima" | stub carrega o path; ranged read resolve |
| Estado cresce | cap 32 LRU + poda TTL + escrita atômica |
| updatedToolOutput silenciosamente ignorado (CC) | contabilidade advisory separada + nota #67442 no README/IDES |
| Formato interno de transcripts mudar | dedupe não depende de transcript |
| Divergência entre adapters | tabela §4 = contrato; célula ⇒ teste (§6) |

## 9. Fora de escopo (v1)
Dedupe entre sub-agentes; dedupe parcial por faixa; compressão de diff;
Cursor updated_input rewrite; repo-target contract injection (item próprio).

## 10. Checklist de liberação para código

- [x] Revisão #1 — 13 achados, 7 mudanças obrigatórias aplicadas nesta Rev.2
- [x] Revisão #2 independente da Rev.2 — APPROVED WITH CHANGES (0 críticos, 3 altos → Rev.3)
- [x] Revisão #3 independente da Rev.3 — APPROVED WITH CHANGES (0 críticos, 2 altos → Rev.4)
- [x] Revisão #4 independente da Rev.4 — APPROVED (must-fix N1 aplicado; N2-N4 cosméticos aplicados e verificados pela revisão #5)
- [x] Cross-check de reuso (touched/stateFile/postProcess/FOLD_CASE reaproveitados)
- [ ] Dono aprova defaults (dupRead ON / reRead OFF)
- [ ] Tarefas de wiring estimadas: T-A1 (repo cell), T-B1 (fallback sid), T-C1 (sessionId no hook-cmd), **T-C2 (célula Cursor — gated pelo §6.13)**
- [ ] Docs pós-implementação: nota #67442 no README/IDES + linha "Cursor sem conversation_id ⇒ dedupe desligado" (F11/F12)

## 11. Mudanças entre revisões (trilha de auditoria)

### Rev.4 → Rev.4+fixes (revisão #5: N1-N4 cosméticos verificados)
N1-N4 aplicados e verificados nesta rodada; nenhum achado de substância.
Correções de consistência da própria rodada: narrativa de trajetória corrigida
(NEW-1), checkbox/trilha da revisão #4 registrados (NEW-2), §11.1 realocado
para depois do §11 (NEW-3).

### 11.1 Notas das revisões incorporadas (should/notes)

- F4: wiring do repo PostToolUse especificado — comando `node .github/token-guard/adapters/post-hook.cjs` adaptado ao envelope Copilot (snake_case), matcher `postToolUse`, timeout 10.
- F6: leituras com faixa NEM gravam NEM criam origem no mapa (predicado: `P.hasReadRange`).
- F8: extrator de alvo = `P.inputPath`; `<safe>` herda o sufixo hash do stateFile (convenção contract.cjs).
- F9: terminologia unificada em `savedReal`/`savedAdvisory` (§3 "savedChars" abolido).
- F11: README/IDES ganham linha "Cursor sem conversation_id ⇒ dedupe desligado".
- F12: tarefa de docs reconciliar IDES.md linha 23 ("✅ substitui v2.1.121+") com #67442 (built-ins podem ignorar).

### Rev.3 → Rev.4 (revisão #3: 0 críticos, 2 altos, D3-D10)
| Achado | Onde endereçado |
|---|---|
| D1 condição stale `mode !== 'block'` no §3 | §3 ADR → `mode === 'warn'` |
| D2 T-C2 nome pendular sem corpo | §4 wiring itemizado (adapter/install/envelope/conversation_id/surfacing) |
| D3 estímulo do gate ambíguo | §6.13: "duas leituras integrais idênticas acima de N chars" |
| D4 `savedChars` residual no §3 | renomeado savedReal/savedAdvisory |
| D5 gravação condicionada a dupRead deixaria Layer B faminta | nota: gravação é incondicional (hash barato), flags só controlam stub/hint |
| D6 fragmento duplicado §5C | removido |
| D7 precedência de coerção | spellings falsy → false; outros não-booleanos → default |
| D8 F11/F12 sem checkbox | adicionados ao checklist §10 |
| D9 range-como-primeira-leitura não testado | §6.3 estendido |
| D10 trilha de auditoria desatualizada | este bloco + checklist marcado |

### Rev.2 → Rev.3 (revisão #2)
F2 (Layer B em off) corrigido via condição positiva; F3/T-C2 anunciado mas corpo só na Rev.4 (este); F5 wire format por harness; F4/F6-F12 conforme §11.1. Registro do 13º achado da rev#1: foi o próprio truncamento do relatório final do revisor (formatação) — sem ação técnica.

### Rev.1 → Rev.2

| Achado da revisão #1 | Onde foi endereçado |
|---|---|
| C1 ordem bigResult×dupRead indefinida | §3 ordem fixa + §6.2 |
| C2 updatedToolOutput quebrado p/ built-ins (#67442) | §3 contagem real×advisory + §4 + §8 |
| H3 originKey "normalização do noisePath" imprecisa | §5A derivação exata + política symlink/case |
| H4 session keys por harness assumidas | §4 tabela + tarefas T-B1/T-C1 + Cursor conversation_id |
| H5 Layer B dentro de ruleBlindRead viola contratos | §5B movida para adapter, escopo mode≠block |
| M6 additional_context do Cursor contestado | §4 + gate §6.13 |
| F1(rev2) referência §7.6 inexistente | substituída por §6.13 em todas as ocorrências |
| F2(rev2) Layer B disparava em mode off | condição positiva mode==='warn' (§5B) |
| F3(rev2) célula Cursor sem caminho de implementação | wiring T-C2 itemizado (§4) |
| M7 repo cell sem wiring/testes | T-A1 itemizada + §6.6 gate |
| M8 plumbagem de config incompleta | §5C DEFAULTS + config.default.json |
| M9 poda/atomicidade não especificadas | §5A pruneState + temp+rename |
| M10 métricas não mensuráveis cross-harness | §7 _total persistido + superfícies onde existem |
| M11 "zero FP" superestimado / see-above | stub com path; só integral atualiza mapa; schema unificado |
| L12 lacunas de teste | §6 itens 2,3,4,5,6,11,12 + nota de write-amplification |
