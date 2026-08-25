# Alinhamento de mercado — economia de tokens sem perder qualidade

> Pesquisa de 2026-08-25. Fontes: engenharia Anthropic (2 posts integrais),
> comunidade Claude Code (repos/gists com dados medidos), comunidade Cursor,
> ecossistema MCP de memória/indexação. Objetivo: garantir que cada feature do
> kit esteja alinhada com o que o mercado valida — e mapear o que falta.

## O que as fontes oficiais validam no produto

| Prática (fonte) | Número/afirmação | token-guard |
|---|---|---|
| Tool responses truncadas DEVEM steerar o agente ("be sure to steer agents with helpful instructions") | Anthropic, Writing tools for agents | ✅ exatamente o bigResult |
| Limite default de tool response no Claude Code | **25.000 tokens** | ✅ mesmo número (`resultCharsWithoutTrim`≈cap) |
| Erros/bloqueios acionáveis, nunca códigos opacos | idem | ✅ nunca um deny cego |
| `response_format: concise/detailed` corta −65% dos tokens do exemplo oficial (206→72) | idem | 🔵 aplicar às tools do guard (R4) |
| Consolidar ferramentas (`schedule_event` > list_users+list_events+create_event) | idem | ✅ valida integração c/ memory server |
| Tool result clearing = "a forma mais segura e leve de compaction" | Effective context engineering | ✅ valida bigResult/clearing |
| Context rot: atenção decai com n² tokens; "smallest set of high-signal tokens" | idem (e research.trychroma.com/context-rot) | ✅ tese central do produto |
| Retrieval híbrido: instruções-chave upfront + navegação just-in-time (CLAUDE.md + glob/grep) | idem | ✅ contrato injetado + guards JIT |
| Structured note-taking / agentic memory (memory tool, NOTES.md) | idem + memory tool beta | 🔵 valida integração memory server |
| Sub-agentes: exploram 10k–100k tok, devolvem 1–2k resumidos | idem + multi-agent research post | ✅ valida scout.agent.md |

## O que a comunidade valida (dados medidos)

| Ferramenta/prática | Números | Lição p/ o kit |
|---|---|---|
| `token-saving-hooks-claude-code` (plugin) | file-read **deduplication**, diff compression, context mgmt | 🔴 **dedupe de leitura**: avisar "arquivo já lido nesta sessão" — estado `sessions/touched` já existe, falta o aviso (S) |
| gist johnlindquist | −54% do contexto inicial (7.584→3.434 tok) com **triggers de divulgação progressiva**: "não precisa de documentação verbosa upfront — precisa de gatilhos" | ✅ valida o design de gatilhos do contract |
| claude-context-optimizer | −50% auditando plugins/hooks/CLAUDE.md/MCP | vizinho do `mcp-cost`/`audit` — não duplicar |
| Hook consolidation report | 10 hooks TS → 1 runner .cjs compilado, −200–500ms por chamada | ✅ valida nossa escolha .cjs puro, single-runner |
| guias yurukusa (800h de operação real) | −50% com CLAUDE.md enxuto + hook guards | valida CLAUDE.md lean (skill v2 já orienta) |

## O que a comunidade Cursor valida

- **`.mdc` rules com glob-scoping** = progressive disclosure de instruções; regras verbosas sempre-on desperdiçam budget de contexto (morphllm/tokenkits).
- **Context pollution → Continue and Revert**: voltar a um prompt anterior é prática padrão contra poluição.
- Desligar features caras (web search, auto-fix longos) e usar repo indexing eficiente são as dicas #1 do fórum oficial.
- **Gap que só hooks preenchem**: rules são advisory — não existe enforcement runtime nativo de custo. É exatamente o nosso lugar no Cursor (preToolUse).

## Memória/indexação: o maior multiplicador de economia

`codebase-memory-mcp` (open source, benchmark próprio auditado pela imprensa dev):
**5 consultas estruturais ≈ 3.400 tokens vs ≈ 412.000 tokens do equivalente grep-and-read — 99% (~120×) menos.**

Isso confirma a tese: **ferramenta indexada > LLM garimpando**. E é o caso de uso
do `@allansantos-dev/opencode-memory`: a exploração que o agente já fez fica salva,
reutilizável, e responde perguntas estruturais sem gastar janela.

### Integração token-guard × memory server (proposta R2)

O guard ENXERGUA o garimpo em tempo real (é ele que vê os broadScan/dumps). Então:

1. `token_guard_status` passa a reportar padrão de garimpo da sessão
   ("N buscas amplas nos últimos turns — considere indexar").
2. Quando detecta garimpo recorrente num repo, o deny de broadScan acrescenta à
   correção: *"para perguntas estruturais, um índice persistente elimina essa
   classe de busca — veja memory/indexing MCP"* (sem nomear fornecedor no deny;
   recomendação nomeada vai só no dashboard/status, que é humano).
3. Se o memory server estiver configurado no projeto, o status reconhece e para
   de sugerir.

## Roadmap resultante (mercado-validado, ranqueado por esforço × ganho)

| # | Contribuição | Validação de mercado | Esforço |
|---|---|---|---|
| R1 | **Dedupe de leitura** (aviso de arquivo já lido na sessão, via estado touched existente) | plugin community equivalente | S |
| R2 | **Integração memory server** (status detecta garimpo + recomenda; reconhece se instalado) | codebase-memory-mcp 120×; memory tool Anthropic | S-M |
| R3 | **Seções anti-boilerplate/reuso no contract** (`quando: codigo`: preferir abstração existente, consultar antes de criar helper, registrar decisão em ADR para não regarimpar) | context engineering (instruções certas economizam SAÍDA e re-leitura); DRY como economia de reescrita | S |
| R4 | **response_format concise/detailed** nas 3 tools MCP do guard | Anthropic: −65% (206→72 tok) | S |
| R5 | **Replay v2 com bytes reais** de tool_result (JSONL traz inline) | dado real > estimativa | M |
| R6 | **Contrato sobrevive à compaction** (PreCompact persist + SessionStart re-injeta) | compaction descarta contexto injetado | M |

Fontes primárias: anthropic.com/engineering/writing-tools-for-agents ·
anthropic.com/engineering/effective-context-engineering-for-ai-agents ·
research.trychroma.com/context-rot · github.com/aaron-for-value/token-saving-hooks-claude-code ·
gist.github.com/johnlindquist/849b813e · github.com/DeusData/codebase-memory-mcp ·
forum.cursor.com · morphllm.com/cursor-rules-best-practices · dev.to (token economy series).
