# R4 · response_format (concise/detailed) nas tools MCP — SDD

> Status: **PLANO · Rev.3** — Rev.2 revisada pela rodada #2: 6 mandatórios
> aplicados (F1 fonte do PT-BR; F2 precedência json/texto/markdown; F3 linhas
> R2 condicionais; F4 baselines completos; F5 descrição imperativa; F6 case
> determinístico) + shoulds N7/N8/N9. Rodada #3: único achado D1 (este
> banner), corrigido. Próximo passo: re-verificação de fechamento.
> Fase: R4 do roadmap de mercado (docs/MARKET.md › Roadmap resultante, linha R4)
> Regra da fase: rodadas de revisão devem REDUZIR achados. Zero libera código.
> Padrão da fonte: Anthropic "Writing tools for agents" — enum
> `response_format` concise/detailed cortou **−65%** dos tokens do exemplo
> oficial (206 → 72 tok no Slack), sem perder funcionalidade.

---

## 1. Problema

As três ferramentas MCP do guard (`token_audit`, `token_guard_status`,
`token_guard_check`) devolvem SEMPRE o formato completo — mesmo quando o agente
só precisa do veredito/números-chave. Tool response entra na janela em toda
chamada subsequente: verbosidade aqui é imposto recorrente, não pontual.

## 2. Mercado (citado)

| Fonte | Prática |
|---|---|
| Anthropic — Writing tools for agents | enum `ResponseFormat {DETAILED, CONCISE}` exposto na própria tool; exemplo oficial: 206 tok → 72 tok (−65%) |
| idem | truncamento/caps DEVEM steerar com instrução útil |
| idem | "agents perform better with natural-language names than cryptic ids" — concise não significa ilegível |

## 3. ADR-004: campo opt-in, default `detailed` (compat total)

### Decisão
As 3 tools ganham input opcional `response_format` (`enum: ["concise","detailed"]`,
default **`detailed`**) e handlers que produzem variante concisa quando pedido.

Por que default detailed (e não concise):
- Compat: agentes/integrações existentes continuam recebendo o formato de hoje.
- `token_audit` detalhado É o produto (relatório completo); concise é um resumo
  útil, não substituto.
- O ganho vem do CONVITE explícito: o schema descreve o concise e modelos
  econômicos passam a pedi-lo. Skill token-economy orienta o mesmo.

### Alternativas descartadas
| Alternativa | Por que não |
|---|---|
| Concise default | quebra consumidores atuais do relatório completo; mudança silenciosa de contrato |
| Cortar campos hoje sem opção | perde funcionalidade em vez de dar escolha |
| Estender ao plugin Copilot agora | handlers duplicados lá; v2 após validar no MCP |

## 4. Contratos exatos

### Schema (as 3 tools)
```json
"response_format": { "type": "string", "enum": ["concise","detailed"],
  "description": "Use concise unless you need the full breakdown. Omitting this field returns detailed.",
  "default": "detailed" }
```
Descrição IMPERATIVA de propósito (clients ignoram JSON-Schema `default` — a
descrição carrega 100% do steering; handler trata ausente → detailed).
Valor inválido após normalização case → `detailed`.

### Saídas concise (definição fechada)
- **token_audit**: tabela CAMADA com **3 linhas de dados** (Tudo/Sem ruído/
  Só código-fonte) + linha dedicada "Só a lista de caminhos" (fora da tabela —
  não é camada, é o destaque) + top-3 diretórios + linha GANHO IMEDIATO
  (totalFiles−cleanFiles). Formato markdown mínimo. Sem barras █, sem topExt,
  sem seções narrativas. Renderizador NOVO construído direto de
  stats/derived/topDir (scan() já retorna estruturado) — NÃO filtrando renderText.
- **token_guard_check**: cabeçalho composto dos campos do veredito
  (`regra` + `decisão`) + **parágrafo `(PT-BR) …` INTEIRO extraído do reason**
  (início no delimitador `\n(PT-BR)`, fim na próxima linha iniciada por `[`
  ou EOF — assim o suffixo `[dica: …]` do decide() nunca contamina). Presente
  em todas as regras (7 templates). Proibido parsear frases heurísticas
  (pontos dentro de paths/comandos backtick) e proibido duplicar one-liners
  (drift). Prefixo de warn `[aviso — …]`, quando presente no reason, vem como
  primeira linha do concise.
- **token_guard_status**: modo, transporte, config source, regras ativas,
  contadores **e a linha ATENÇÃO de guard DESLIGADO quando mode==='off'**
  (safety-critical não se omite). Linhas de indexer-detectado/garimpo (R2)
  entram SÓ QUANDO R2 landar (condicional declarado — R4 não depende de R2
  para o resto).

### Precedência format × response_format (fecha F2)
- `format:"json"` → JSON cru, `response_format` IGNORADO (pedido estruturado
  vence dica de apresentação).
- `format:"texto"` → detailed texto puro, `response_format` IGNORADO (mesma
  regra: pedido explícito vence).
- Sem format OU `format:"markdown"` → `response_format` aplica (concise =
  markdown mínimo; renderizador único construído de scan()).

### Case handling (fecha F6)
Normalizar case-insensitive: `"CONCISE"`/`"concise"` → concise; qualquer outro
valor fora do enum → `detailed`. Comportamento único e determinístico.

### Implementação
Handler lê `args?.response_format`, normaliza, desvia. Qualquer exceção na
variante concise → cai no detailed.

## 5. Plano de testes (failing-first)

1. audit concise (sem format e com format:"markdown"): 3 camadas + linha de caminhos, ≤15 linhas, sem barra █; **× format:"json" → JSON cru intacto**; **× format:"texto" → detailed texto puro (response_format ignorado)**.
2. check concise: cabeçalho regra+decisão + parágrafo (PT-BR) inteiro SEM o suffixo [dica; warn mode → prefixo [aviso preservado como 1ª linha; NÃO contém o bloco EN "DO THIS INSTEAD"; OK path idêntico nos dois formatos.
3. status concise: modo+transporte+config+regras+contadores; ATENÇÃO off presente quando off; linhas R2 ausentes (condicionais).
4. default ausente → detailed (snapshot comparando com saída atual).
5. "concise"/"CONCISE" → concise; "lixo" → detailed.
6. Schemas das 3 tools anunciam enum + descrição imperativa (tools/list).
7. Fail-open: exceção na variante concise → detailed.
8. Plugin Copilot intocado: assert estrutural de que copilot-cli.mjs não ganhou response_format nesta fase (escopo §8).

## 6. Métricas de sucesso

Baseline = saída default ATUAL COMPLETA por tool (header incluído no check;
markdown do audit; status completo), medida em chars no fixture repo médio,
assert no teste. Critérios relativos: audit concise ≥45% menor; check concise
≥60% menor; status concise ≥30% menor (valores absolutos variam por repo — %
é o contrato).
Custo fixo: schema cresce ~120 chars/tool (~90 tok de preâmbulo) — pago 1×,
amortizado na 1ª chamada concise.

## 7. Riscos

| Risco | Mitigação |
|---|---|
| Modelo nunca pede concise | descrição do schema + skill token-economy orientam |
| Concise omitir dado crítico | definição fechada §4 + testes de conteúdo mínimo |
| Preamble +90 tok fixos | amortizado em 1 chamada concise; documentado |

## 8. Fora de escopo (v1)
Plugin Copilot (handlers duplicados — v2); CLI humano (formato texto serve);
updatedToolOutput interplay (bigResult independente); compressão TOON.

## 9. Checklist de liberação

- [x] Revisão #1 desta spec — 6 mandatórios (F1-F6) + shoulds tratados na Rev.2
- [x] Revisão #2 — APPROVED WITH CHANGES: N1/N2/N4/N6 must-fix + N3/N5/N7-N9 aplicados na Rev.3
- [x] Revisão #3 — único achado D1 (banner), corrigido
- [ ] Revisão #4 de fechamento — meta LIMPA
- [ ] Métricas §6 medidas de fato (números preenchidos)
- [ ] CHANGELOG + nota na skill token-economy ("peça concise")
- [ ] Dono aprova defaults (detailed)
