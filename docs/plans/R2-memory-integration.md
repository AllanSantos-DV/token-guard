# R2 · Integração Memory Server — Spec-Driven Development

> Status: **PLANO · Rev.2 + fixes das revisões #3 e #4 aplicados** — rodadas:
> #1 achou 6 (3 altos), #2 re-gate APPROVED com 0 bloqueantes (2 correções
> editoriais + 4 touch-ups, N1-N6, todos editoriais/low), #3 verificou os
> N-fixes e achou 4 resíduos de edição (D1-D4, corrigidos aqui).
> **Fase encerra quando uma rodada vier LIMPA (zero achados, inclusive lows).**
> Fase: R2 do roadmap de mercado (docs/MARKET.md · docs/plans/R1-read-dedup.md §11)
> Regra da fase: rodadas de revisão devem REDUZIR achados. Zero libera código.
> **Dependência de ordem**: a coerção por chave no sanitize chega com R1 —
> se R2 landar primeiro, traz a própria coerção para estas chaves.

---

## 1. Problema

A maior economia medida no mercado não vem de bloquear chamadas — vem de **não
precisar fazê-las**: indexação persistente do codebase responde perguntas
estruturais com ~120× menos tokens que o garimpo equivalente
(codebase-memory-mcp: 5 queries ≈ 3.400 tok vs ≈ 412.000 tok em grep+read).
O token-guard ENXERGUA o garimpo em tempo real (é quem vê os broadScan), mas:

1. **não reconhece** o padrão ("este usuário está garimpando");
2. **não recomenda** a solução da classe (indexação/memória persistente);
3. **não reconhece** quando um indexer já está configurado (recomendação
   redundante = ruído).

## 2. Pesquisa de mercado (citada)

| Fonte | Validade |
|---|---|
| codebase-memory-mcp (benchmark próprio, coberto por imprensa dev) | 5 queries estruturais ≈ 3.400 tok vs 412k tok grep-and-read ⇒ 99% (~120×) |
| Anthropic — Effective context engineering | retrieval híbrido (índice upfront + navegação JIT); structured note-taking/agentic memory como técnica oficial p/ long-horizon |
| Anthropic — Writing tools for agents | consolidar ferramentas (`schedule_event` > list_users+list_events+create_event): contexto consolidado > garimpo multi-chamada |
| Cursor forum (settings p/ não queimar tokens) | repo indexing eficiente = dica #1 da comunidade |

Consequência de produto: o guard é o **sensor**; o memory/indexer é o **tratamento**.
A integração é natural e de baixo custo (texto + detecção), sem acoplamento de código.

## 3. ADR-002: Recomendação no dashboard, nunca no deny; detecção por inventário

### Contexto
Três superfícies onde uma recomendação poderia aparecer: (a) dentro do texto do
deny (vai para o MODELO); (b) `token_guard_status` (plugin/MCP — vai para o
AGENTE sob demanda) e `cli status`/site (HUMANO); (c) workflow separado.

### Decisão (Rev.2 — fontes de dados honestas por superfície)
1. **Deny NUNCA nomeia fornecedor nem recomenda instalação de software.** O deny
   continua ensinando apenas a alternativa barata da própria chamada. *Exceção
   mínima e neutra, v1 SÓ no modo plugin in-process* (que já mantém `byRule`
   em memória): o 3º+ deny de broadScan da sessão acrescenta UMA linha fixa,
   sem marca: `"perguntas estruturais recorrentes são mais baratas com um
   índice persistente do codebase (ex.: servidor MCP de indexação/memória)"`.
   Hooks de comando (stateless) e Cursor ficam FORA dessa linha em v1 —
   contadores por sessão exigiriam I/O no hot path que decide() hoje não tem.
2. **Detecção de indexer configurado** = função PURA sobre a saída REAL de
   `MC.discover()` (`{name, ide, file, spec:{command,args,url}|null, transport}`,
   incluindo linhas de erro com `spec:null` — ignoradas). Casa `name` e
   `spec.command/args/url` contra padrões (regex case-insensitive, §5) — a
   lista normativa única vive em §5. FP aqui custa apenas omitir uma dica —
   fail-open de recomendação.
3. **Gatilho de garimpo por superfície (sem mentir)**:
   - Plugin in-process: `byRule.broadScan` real (vereditos deny+ask da sessão) ✓.
   - MCP server: `byRule` conta só autoavaliações via `token_guard_check` —
     bloco aparece rotulado como "autoavaliações", raro por natureza.
   - `cli status`: processo novo, zero contadores → **mostra SOMENTE a
     detecção de indexer** (presente/ausente), sem bloco de garimpo.
4. **Postura de privacidade (emendada)**: o caminho nomeado de instalação é
   permitido nas superfícies de status (sob demanda do agente/humano, ≤4
   linhas) e PROIBIDO dentro de deny. O deny recebe a linha neutra do item 1.

### Alternativas descartadas
| Alternativa | Por que não |
|---|---|
| Recomendação nomeada dentro do deny | deny vai para o modelo: publicidade no contexto custa tokens e viola "bloqueio ensina a ação" |
| Integração profunda (chamar o memory server do guard) | acoplamento + duplicação; o kit é sensor/guard, não indexer |
| Detectar garimpo via transcripts | dependência de formato interno de cada harness (frágil); contadores locais bastam |
| Contadores persistentes p/ hooks stateless | I/O em disco no hot path do decide() — viola o desenho lazy atual; fica para v2 com T-C1-style plumbing |

### Consequências
+ Zero custo de runtime além de um `Array.some` sobre o inventário.
+ Recomendação aparece exatamente quando o padrão dói (≥3 garimpsos/sessão).
− Não há como medir adoção automaticamente (aceitável: recomendação é conselho,
  métrica real fica com o replay/bench).
− Heurística de detecção pode errar nos dois lados (omitir dica = inofensivo;
  sugerir com indexer presente = ruído evitável pelos padrões amplos).

## 4. Contratos

### lib/memory-integration.cjs (novo, funções PURAS — zero I/O)
```
hasIndexer(servers, patterns?)
  servers: saída REAL de MC.discover() — linhas {name, ide, file,
    spec:{command,args,url}|null, transport}; linhas com spec:null (config
    ilegível) são PULADAS.
  → { found: boolean, which: string|null, total: number }
  match: name OU join de [command, ...(args||[]), url].filter(Boolean).join(' ') contra patterns
  (regex case-insensitive). Múltiplos: which = primeiro; total = contagem.

miningPattern(byRule, threshold=3)
  → { mining: boolean, count }   // count = byRule.broadScan || 0

recommend({ discovered, mining, surface })
  → null | string   // texto pronto p/ a superfície; surface define se o
                    // caminho de instalação pode ser nomeado
                    // ('plugin'|'mcp'|'cli'); cli nunca nomeia fornecedor
```
Nome `recommend()` (evita colisão com `mcp-cost.advise`). Novo módulo entra no
exports map do package.json (convenção).

### Superfícies (todas opcionais-fail-open)
- **Plugin in-process** (`token_guard_status`): mining real (byRule) + detecção;
  bloco completo nomeando instalação quando aplicável. Deny-line v1 também só
  aqui (in-memory byRule, append pós-decide, zero I/O).
- **MCP server** (`token_guard_status`): detecção + bloco de garimpo rotulado
  "autoavaliações via token_guard_check" (semântica honesta).
- **cli status**: SOMENTE detecção de indexer (processo novo não tem contadores).
- Todas respeitam `mode==='off'` (já herdado) e o kill-switch
  `recommendations.memory=false` (silencia dashboard E deny-line).

### Descoberta reutilizada
`MC.discover({cwd})` JÁ varre Claude/Cursor/Windsurf/Claude Desktop/VS Code/
token-guard (+`--extra-files`). Zero I/O novo. Custo: discover roda ~ms — só
nas superfícies de STATUS (sob demanda), nunca no hot path do decide().

### Config (defaults + plumbagem completa, padrão R1)
```json
"recommendations": { "memory": true },
"indexerPatterns": []        // ADITIVO aos padrões embutidos (strings→regex)
```
- `DEFAULTS.recommendations` = {memory:true} com guard de objeto aninhado
  (mesmo tratamento de rules/limits); `indexerPatterns` com filtro+dedupe de
  strings (padrão allowlist existente em config.cjs).
- Espelhado em `config.default.json` (hoje termina em allowlist).
- Coerção por chave: se R1 já landou, herda; senão R2 traz a própria para
  estas chaves (dependência declarada no header).

## 5. Padrões embutidos (LISTA NORMATIVA ÚNICA — §3 referencia esta)

Case-insensitive, casam contra `name` e `spec.command+args+url`:
`opencode-memory` · `codebase-memory` · `memory-server` · `memory-bank` ·
`codebase-index` · `code-index` · `context7` · `serena` · `graph-rag`
(qualquer novo indexer entra via `indexerPatterns` sem tocar no código).
Deliberadamente GENÉRICOS fora desta lista (`graph`, `/memory/` sozinhos)
ficam de fora — FP demais; o dono estende por config.

## 6. Plano de testes (failing-first)

1. hasIndexer: detecta por name, por args, case-insensitive; **linha spec:null (config ilegível) é pulada sem throw**; falso alvo (`my-memory-utils`) NÃO detecta.
2. hasIndexer: lista vazia/undefined → not found; patterns custom SOMAM aos embutidos.
3. miningPattern: <3 false; ≥3 true com count; byRule ausente → false.
4. recommend: plugin+mining+sem indexer → texto nomeando instalação; mcp+mining → rótulo "autoavaliações"; cli → só detecção (nunca nomeia); miner+indexer → supressão; indexer presente sem mining → SEM linha de índice (anti-ruído); recommendations.memory=false → null em todas.
5. Status surfaces: plugin/MCP/cli renderizam blocos conforme superfície (snapshot das linhas); mode off → nada além do aviso existente.
6. Deny neutro (plugin-only): 3º broadScan da MESMA sessão in-process contém a linha fixa sem marca; 1º não contém; TOKEN_GUARD=warn → linha vai no reason do ask (intencional); hooks command/cursor → nunca.
7. Fail-open: discover lança/corrompido → superfícies renderizam sem bloco, exit 0.
8. Hot path: decide() chamado com payload vigiado NÃO executa writeFileSync/discover (assert via interceptação de fs no processo de teste).

## 7. Métricas de sucesso

- Dado real imediato: o próprio replay Copilot desta máquina (352k chamadas)
  quantifica quantos vereditos deny+ask de broadScan teriam disparado a
  recomendação (baseline do gatilho ≥3).
- Adoção em si não é auto-mensurável (conselho, não telemetria) — declarado.

## 8. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Recomendação vista como anúncio | nomeada SÓ no dashboard humano; deny recebe linha neutra e rara |
| FP na detecção de indexer | custo = omitir dica; patterns extensíveis por config |
| Custo de discover em status | só em superfície sob demanda; nunca no hot path (teste 8) |
| Formato de inventário mudar | discover() é nosso contrato interno; adapters não tocados |

## 9. Fora de escopo (v1)
Chamar o memory server a partir do guard; dashboard gráfico; recomendação em
hooks stateless claude/cursor (deny-line é plugin-only; Cursor: cursor-hook
continua aplicando as 4 regras mas sem linha de recomendação — v2); métricas
de adoção; contadores persistentes cross-sessão; **site do Pages como
superfície** (estático, não executa discover()). Pós-implementação:
reconciliar docs/MARKET.md §integração com o escopo final.

## 10. Checklist de liberação para código

- [x] Revisão #1 — 3 altos + 3 méd corrigidos nesta Rev.2 (F1 contrato discover real; F2 fontes de mining honestas por superfície; F3 deny-line plugin-only; F4 lista normativa única; F5 postura de privacidade emendada; F6 plumbagem config completa)
- [x] Revisão #2 (re-gate) — APPROVED com 2 correções editoriais + 4 touch-ups, aplicadas (N1-N6)
- [ ] Cross-check de reuso: discover()/byRule/status surfaces reaproveitados, nenhum I/O novo no hot path
- [ ] Dono valida o texto da recomendação e confirma o padrão de detecção do SEU memory server (@allansantos-dev/opencode-memory casa com `opencode-memory`?)
