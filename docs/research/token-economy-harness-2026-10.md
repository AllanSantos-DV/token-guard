# Economia de tokens por comportamento de harness — pesquisa de 2026-10-23

Data de acesso de todas as fontes: **2026-10-23**. Escopo: mecanismos de Claude Code, Codex CLI,
GitHub Copilot CLI e Cursor que o token-guard pode usar (ou já usa). Só consta o que foi lido nas
páginas; onde a página não trazia o dado, está escrito "não encontrei".

Limitações honestas desta pesquisa:

- As páginas foram lidas pelo `WebFetch`, que devolve o trecho que um modelo pequeno extrai. Páginas
  longas (hooks: 280 mil caracteres; settings-reference: 437 mil) foram lidas só nas partes que o
  leitor selecionou. Onde a extração foi parcial, a linha diz.
- Releases do GitHub de `openai/codex` e `github/copilot-cli` **não** foram lidas. O
  `CHANGELOG.md` do `anthropics/claude-code` foi lido, mas a extração devolveu só entradas antigas
  (2.1.31): não serve de fonte para nada abaixo.
- Nenhum nome de variável ou campo foi inventado: todos aparecem literalmente nas páginas citadas.
- O leitor de `developers.openai.com/codex/*` e `docs.github.com/.../hooks-configuration` resolveu
  para `learn.chatgpt.com/docs/...` e `.../hooks-reference`; a URL efetivamente lida está na tabela.

## 1. O que o token-guard já cobre (lido no código)

| Peça | O que faz | Arquivo |
|---|---|---|
| broadScan, blindRead, noisePath, shellDump | `deny`/`ask` no `PreToolUse` com a alternativa barata no `reason` | `lib/rules.cjs` |
| bigResult | resultado > 25 mil caracteres vira stub (cabeça + cauda; no shell, início + fim + linhas-sinal), integral em `.token-guard/results/`, via `updatedToolOutput` (Claude Code >= 2.1.121) e `modifiedResult` (Copilot) | `lib/postresult.cjs` |
| dupRead | hash por sessão; releitura idêntica >= 2000 caracteres vira stub; zera em `SessionStart` com `source` compact/clear/resume | `lib/dupread.cjs`, `adapters/session-start.cjs` |
| scout | aviso único após 8 leituras/buscas seguidas sem edição, no `PostToolUse` | `lib/scout.cjs` |
| ctxwatch | `systemMessage` ao humano em 120k tokens de contexto e a cada +60k (custo de reler o cache) | `lib/ctxwatch.cjs` |
| contrato de saída | `UserPromptSubmit` injeta `sempre` 1x/sessão e `codigo/teste/docs` por evidência; bloco `subagente` **manual** | `contract.default.md`, `lib/contract.cjs` |
| mcp-cost | mede o preâmbulo MCP por handshake real (`tools/list`) | `lib/mcp-cost.cjs` |
| cost, audit, replay | custo por sessão/modelo a partir do transcript (tarifa por TTL de cache), custo do repo, replay do `decide()` | `lib/cost.cjs`, `lib/audit.cjs` |
| transporte | hook http (Claude Code), `mcp_tool` (Codex), in-process (Copilot), comando (Cursor) | `adapters/*` |
| agente `scout` + skill `token-economy` | investigação em contexto descartável; progressive disclosure | `agents/scout.agent.md`, `skills/token-economy/SKILL.md` |
| R6 (contrato sobrevive à compaction) | **planejado, não implementado**: nenhum hook `PreCompact`/`PostCompact` no código | `docs/plans/R6-contract-compaction.md` |

Verificado por varredura de arquivos (sem `.md` de docs/test/bench): **não aparecem no código** os termos
`updatedInput`, `SubagentStart`, `PreCompact`, `PostCompact`, `PostToolBatch`, `BASH_MAX_OUTPUT_LENGTH`,
`MAX_MCP_OUTPUT_TOKENS`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`,
`CLAUDE_CODE_PROMPT_CACHE_TTL`, `maxTurns`, `tool_output_token_limit`. O `agents/scout.agent.md` tem só
`name` e `description` no frontmatter. O token-guard também não grava `env` em `settings.json`.

## 2. Achados

Colunas: mecanismo e o que economiza (entrada/saída/cache) · fonte · coberto? · integrável num hook?

### 2.1 Claude Code

| # | Achado (mecanismo → o que economiza) | Fonte (lida em 2026-10-23) | Já coberto? | Integrável num hook do token-guard? |
|---|---|---|---|---|
| C1 | `PostToolUse` `hookSpecificOutput.updatedToolOutput`: "Replaces the tool's output with the provided value before it is sent to Claude. The value must match the tool's output shape." Entrada: o resultado grande nunca entra. | https://code.claude.com/docs/en/hooks.md | **Sim** (bigResult, dupRead) | Já integrado. |
| C2 | `PreToolUse` `hookSpecificOutput.updatedInput`: "replaces a tool's arguments before it runs". A página de custos traz o exemplo oficial: reescrever `npm test`/`pytest`/`go test` para `... \| grep -A 5 -E '(FAIL\|ERROR\|error:)' \| head -100`. Entrada: evita o dump em vez de negar e esperar a nova tentativa (poupa o `reason` mais o turno da repetição). | https://code.claude.com/docs/en/costs ; https://code.claude.com/docs/en/hooks | **Não** (o guard só faz `deny`/`ask`; `updatedInput` não aparece no código) | **Sim.** `decide.cjs` já conhece a alternativa barata de blindRead (faixa de linhas) e shellDump (teto no pipe); falta devolver `updatedInput` + `additionalContext` explicando. Risco: perde o efeito pedagógico do deny; manter `reason`/contexto no mesmo envelope. |
| C3 | Hook `if` ("Bash(git *)", "Edit(*.ts)"): filtra por regra de permissão antes de rodar o hook; só vale em `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`. Poupa spawn (latência), não token. | https://code.claude.com/docs/en/hooks ; exemplo em https://code.claude.com/docs/en/hooks-guide | Parcial (o modo comando usa `matcher`; o padrão http já não spawna) | Sim, só no modo `--command-hooks`/repo: trocar parte do `matcher` por `if`. Ganho de latência, não de token. |
| C4 | Limite de `additionalContext`, `systemMessage`, `initialUserMessage` e stdout: **10.000 caracteres cada**; acima, o harness grava em arquivo e passa o caminho com prévia de 2.000 caracteres, "Claude isn't asked to read the file". Sem setting para subir. | https://code.claude.com/docs/en/hooks | Não verificado no código | Sim, como teste/guard: o contrato (`sempre` + `codigo` + ...) e as mensagens do bigResult devem caber em 10k, senão a regra some em silêncio. |
| C5 | `SessionStart` com `source` = `startup`, `resume`, `clear`, `compact`, `fork`; `hookSpecificOutput.additionalContext` entra "before the first prompt". A página de contexto confirma: "SessionStart hooks that match the `compact` source: Claude Code runs them and adds their output to the compacted context". E: "Context that hooks added earlier: Summarized with the rest of the conversation". Entrada/saída: a regra volta imediatamente após a compaction, sem esperar o próximo prompt. | https://code.claude.com/docs/en/context-window ; https://code.claude.com/docs/en/hooks | **Parcial**: `session-start.cjs` já lê `source` (zera dupRead). O contrato continua dependendo do plano R6 (PreCompact limpa o estado; o próximo `UserPromptSubmit` reinjeta), não implementado. O plano R6 chamava o `SessionStart(compact)` de "evolução v2". | **Sim.** Reuso: o mesmo `session-start.cjs`; para `compact` devolver `additionalContext` com a camada `sempre`. A própria página confirma o canal. |
| C6 | `PreCompact`: entrada traz `trigger` e `custom_instructions`; exit 2 "Blocks compaction"; matcher `manual`/`auto`. `PostCompact`: entrada traz `trigger` e `compact_summary`; sem controle de decisão. Não encontrei campo de injeção de contexto em nenhum dos dois (extração parcial da página). | https://code.claude.com/docs/en/hooks.md | Não | Parcial. `PreCompact` serve para gravar estado/instruções; `PostCompact` serve para **medir** (`compact_summary`) quanto a compaction reteve. Não injeta. |
| C7 | `PostToolBatch`: dispara "after a full batch of parallel tool calls resolves, before the next model call"; aceita `additionalContext`; sem matcher; exit 2 para o loop. | https://code.claude.com/docs/en/hooks | Não | Sim, marginal: consolidar os avisos do lote (scout + bigResult + dupRead) num único `additionalContext` por lote, em vez de um por chamada. |
| C8 | `SubagentStart`: `additionalContext` "adds context for the subagent", matcher por tipo de agente. Hoje o bloco `subagente` do contrato é colado à mão. | https://code.claude.com/docs/en/hooks | **Não** (README: `--subagente` é manual) | **Sim.** Hook novo, matcher `scout`, devolve `contract.cjs --subagente`. Saída: o subagente passa a responder em formato de dado (o texto final dele é cobrado da janela principal). |
| C9 | Frontmatter de subagente: `model` (`sonnet`, `opus`, `haiku`, `fable`, ID completo, `inherit`), `tools`, `disallowedTools`, `maxTurns` ("Claude Code returns its output marked as partial"), `effort`, `skills`, `memory`, `background`, `isolation`. A página de custos recomenda "`model: haiku` ... for simple subagent tasks". Subagentes pagam as próprias requisições. | https://code.claude.com/docs/en/sub-agents ; https://code.claude.com/docs/en/costs | **Não**: `agents/scout.agent.md` só tem `name` e `description` | Não é hook: é arquivo de agente. Mas é a mudança de menor esforço do relatório (ver 3, ideia 1). |
| C10 | Precedência do modelo do subagente: parâmetro da chamada, depois `model` do frontmatter, depois `CLAUDE_CODE_SUBAGENT_MODEL`, depois o modelo da conversa. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` força um só e ignora o frontmatter. Antes da v2.1.251 a variável vencia tudo. | https://code.claude.com/docs/en/sub-agents | Não | Não (config). Útil para `status`/doc: explicar por que o `model` do scout vale. |
| C11 | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1-100: porcentagem da janela de auto-compact; "can't raise the threshold"; vale também em subagentes) e `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (100000 a 1000000 tokens; também `/autocompact 500k`). Modelos de 1M rodam com a janela de 1M por padrão. Entrada/cache: compactar mais cedo limita o contexto relido a cada turno. | https://code.claude.com/docs/en/env-vars ; https://code.claude.com/docs/en/model-config | **Não**: o `ctxwatch` só avisa o humano em 120k | Não é hook: é `env` em `settings.json`. O instalador já faz merge de `settings.json` (para os hooks), então pode gravar `env` opt-in. Custo: compactar é uma requisição grande e invalida o cache (C13). |
| C12 | `BASH_MAX_OUTPUT_LENGTH`: "Maximum number of characters of bash output ... (default: 30000; maximum: 150000)"; o setting `bashOutputMaxChars` vence a variável. `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`: padrão 25.000 tokens para leitura de arquivo, e o `Read` com parâmetro `allow_large` passa disso se houver espaço. Saída: teto nativo, sem processo nenhum. | https://code.claude.com/docs/en/env-vars | **Não** (o bigResult corta a 25 mil caracteres no pós-hook; o teto nativo é 30 mil e fica antes) | Não é hook. Observação: com o teto nativo de 30.000, o bigResult só age sobre Bash se o limite do guard for menor; vale conferir se o corte do harness já precede o do guard (ele não tem as linhas-sinal). |
| C13 | Cache de prompt: TTL de 5 min ou 1 h. Conversa principal: **1 h** em assinatura dentro do plano; **5 min** com créditos de uso, API key ou provedor de nuvem. Demais requisições: 5 min. Controle: `CLAUDE_CODE_PROMPT_CACHE_TTL`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`, settings `promptCacheTtl`/`subagentPromptCacheTtl`, `FORCE_PROMPT_CACHING_5M=1` (força 5 min e vence as outras). Desligar: `DISABLE_PROMPT_CACHING` (+ `_HAIKU`, `_SONNET`, `_OPUS`, `_FABLE`). Invalidam o cache: trocar de modelo, mudar o effort, ligar fast mode, conectar/remover servidor MCP, ativar/desativar plugin, negar uma ferramenta inteira, compactar, acumular muitas imagens, atualizar o Claude Code. A 1ª mensagem depois de uma pausa maior que o TTL reprocessa o contexto inteiro. | https://code.claude.com/docs/en/prompt-caching ; https://code.claude.com/docs/en/env-vars ; https://code.claude.com/docs/en/costs | **Parcial**: `cost.cjs` já aplica tarifa por TTL; nada avisa o humano do cache frio nem recomenda TTL | **Sim**, no `UserPromptSubmit` do ctxwatch: se o último turno do assistente é mais velho que o TTL e o contexto é grande, `systemMessage` ("cache frio: este prompt reprocessa ~Nk tokens; se mudou de tarefa, /clear"). Vai ao humano, não custa token ao modelo. Ver 3, ideia 3. |
| C14 | `/usage` mostra linha `Prompt cache (main)` (requisições, % da entrada servida do cache, misses, "expected rebuild", warm/cold com o TTL); exige v2.1.251; "likely cause" exige v2.1.260. Os scripts de status line leem o objeto `prompt_cache`. | https://code.claude.com/docs/en/costs | Não | Não é hook; é fonte de medição para o `cost`/`status`. Não li os campos do objeto `prompt_cache`: **não encontrei** os nomes. |
| C15 | Busca de ferramentas MCP (`ToolSearch`): ferramentas MCP **adiadas por padrão**; "only tool names and server instructions enter context until Claude uses a specific tool". `ENABLE_TOOL_SEARCH`: ausente/`true` adia, `auto` ativa a partir de 10% da janela, `auto:N` limiar próprio, `false` carrega tudo. `alwaysLoad: true` por servidor mantém as ferramentas sempre visíveis. `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`: 4096 caracteres (16384 para ferramenta carregada por tool search). | https://code.claude.com/docs/en/costs ; https://code.claude.com/docs/en/mcp ; https://code.claude.com/docs/en/env-vars | **Contradiz o `mcp-cost`/README**: "74 ferramentas ... ≈ 9.695 tokens, em toda sessão" mede o schema completo, mas no Claude Code o padrão é só nome + instruções do servidor | Não é hook. Ação: o `mcp-cost` deve distinguir por harness (Claude Code adiado vs. Codex/Copilot/Cursor) e contar o `instructions` do servidor, que paga toda sessão. Caso contrário o número do README superestima o preâmbulo no Claude Code. |
| C16 | Saída MCP: `MAX_MCP_OUTPUT_TOKENS` (padrão 25.000; aviso em 10.000, fixo); texto > 50.000 caracteres vai para arquivo no diretório `tool-results` da sessão e a conversa recebe o caminho; o servidor pode elevar o próprio teto com `_meta["anthropic/maxResultSizeChars"]`, até 500.000 caracteres. | https://code.claude.com/docs/en/env-vars ; https://code.claude.com/docs/en/mcp | Parcial (bigResult cobre MCP via `updatedToolOutput`; corta antes, a 25 mil caracteres) | Sim, nas ferramentas MCP **do próprio token-guard**: manter respostas curtas e não declarar `anthropic/maxResultSizeChars`. Nada a fazer no hook. |
| C17 | O que sobrevive à compaction (tabela oficial): CLAUDE.md da raiz e regras sem `paths:` reinjetados do disco; auto memory reinjetada; descrições de skills reconstruídas (v2.1.304+); corpos de skills invocadas reinjetados com teto de 5.000 tokens por skill e 25.000 no total; "Files Claude read or edited: re-reads up to five, most recently modified first"; contexto adicionado por hooks é **resumido** com o resto. | https://code.claude.com/docs/en/context-window ; https://code.claude.com/docs/en/skills | Parcial (dupRead zera no `compact`) | Sim, duas consequências: (a) regra que precisa sobreviver exato vai em CLAUDE.md/`SessionStart(compact)`, não em `additionalContext` solto; (b) após a compaction o harness relê até 5 arquivos sozinho: o dupRead zerado já está certo, mas esses 5 reads não são medidos como "ruído". |
| C18 | Skills: a listagem (nome + descrição) entra no contexto no início; orçamento de 1% da janela; estourando, descrições das skills menos usadas caem primeiro. Settings `skillListingBudgetFraction` e `skillListingMaxDescChars`. Campos de frontmatter vistos: `disable-model-invocation`, `paths`, `hooks`, `shell`, `allowed-tools`, `when_to_use`. `!`comando`` executa shell na invocação (o `disableSkillShellExecution` desliga). A página de custos: mover instruções do CLAUDE.md para skills ("Skills load on-demand only when invoked"); CLAUDE.md abaixo de 200 linhas. | https://code.claude.com/docs/en/skills ; https://code.claude.com/docs/en/settings-reference ; https://code.claude.com/docs/en/costs | Parcial (a skill `token-economy` existe; o `audit` não mede skills/CLAUDE.md) | Não é hook. Extensão natural do `audit`/`mcp-cost`: medir a listagem de skills e o CLAUDE.md como preâmbulo. A descrição da `token-economy` tem ~900 caracteres, vale enxugar. |
| C19 | Pensamento/esforço: `/effort`, `CLAUDE_CODE_EFFORT_LEVEL` (`low`, `medium`, `high`, `xhigh`, `max`, `auto`), setting `effortLevel`, `maxEffortLevel`; `MAX_THINKING_TOKENS` só vale em modelos de orçamento fixo ("Adaptive-reasoning models ignore nonzero budgets"); `MAX_THINKING_TOKENS=0` não desliga o thinking nos modelos 5.5 e Fable. Pensamento é cobrado como saída. `/usage` recomenda "Switch from max to high effort · /effort high" e `f` aplica. | https://code.claude.com/docs/en/costs ; https://code.claude.com/docs/en/env-vars ; https://code.claude.com/docs/en/model-config | Não | Parcial: o hook não muda o effort (e mudar invalida o cache, C13). Dá para o `status`/`cost` recomendar com base no transcript. |
| C20 | Flags de `claude -p`: `--max-turns` ("print mode only. Exits with an error when the limit is reached"), `--max-budget-usd`, `--bare` (pula hooks, skills, plugins, MCP, auto memory e CLAUDE.md), `--exclude-dynamic-system-prompt-sections`, `--disallowedTools` ("A bare tool name removes the matching tools from Claude's context"), `--strict-mcp-config`, `--tools`. | https://code.claude.com/docs/en/cli-reference | Não | Não é hook. Relevante para automações que chamam `claude -p`; `--bare` **desliga o token-guard** na chamada. |
| C21 | Tipos de hook: `command`, `http`, `mcp_tool`, `prompt` ("single-turn LLM evaluation"), `agent` ("multi-turn verification with tool access"). `prompt`/`agent` gastam tokens de modelo. | https://code.claude.com/docs/en/hooks-guide | Parcial (usa `http` e `command`; Codex usa `mcp_tool`) | Não recomendado: `prompt`/`agent` somam custo; o guard é determinístico por design. |
| C22 | Mensagens de custo ao humano: `/usage` traz atribuição por skill/subagente/plugin/servidor MCP e "Recommendations" (ex.: "Trim ~/code/api/CLAUDE.md · 49k tokens per request") com % do uso. Requer plano de assinatura para o detalhamento. | https://code.claude.com/docs/en/costs | Não | Não é hook: concorrente/complemento do `cost`. Evitar duplicar. |
| C23 | Outros: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (padrão 20), `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (padrão 3), `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS`; Explore e Plan "skip CLAUDE.md files and the git status snapshot"; combinação de descrições de subagentes acima de 15.000 tokens gera aviso; tarefas agendadas e check-ins de goal reenviam o contexto inteiro com a sessão ociosa (`CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0` desliga). | https://code.claude.com/docs/en/env-vars ; https://code.claude.com/docs/en/sub-agents ; https://code.claude.com/docs/en/costs | Não | Não é hook. Material para o `status` (alertar `/loop` pesado). |

### 2.2 Codex CLI

Fonte base: https://developers.openai.com/codex/hooks (a leitura resolveu para https://learn.chatgpt.com/docs/hooks)
e https://developers.openai.com/codex/config-reference (resolveu para https://learn.chatgpt.com/docs/config-file/config-reference).

| # | Achado | Fonte | Já coberto? | Integrável? |
|---|---|---|---|---|
| X1 | Eventos: `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`, `Interrupt`. Tipos: `command` e `mcp_tool` (campos `server`, `tool`, `input`, `timeout` padrão 600, `statusMessage`). | learn.chatgpt.com/docs/hooks | Parcial: o token-guard usa só `PreToolUse` via `mcp_tool` | Sim: `UserPromptSubmit` e `SessionStart` via `mcp_tool` permitiriam injetar o contrato no Codex, hoje "manual" no README. Não verifiquei se o `mcp_tool` aceita esses eventos além do `PreToolUse`: a página lista o tipo, sem restrição por evento na extração. |
| X2 | `additionalContextLimit`, padrão **2500**: acima disso o Codex grava o texto em disco e manda uma prévia. Campos de saída: `additionalContext`, `updatedInput`, `continue`, `stopReason`, `systemMessage`, `suppressOutput`. | learn.chatgpt.com/docs/hooks | Não verificado | Sim, como teste: o bloco `sempre` do contrato (~1,5 mil caracteres) e as mensagens bilíngues do bigResult precisam caber em 2500 no Codex; as seções `codigo/teste/docs` somadas podem estourar. |
| X3 | `PostToolUse`: `updatedMCPToolOutput` e `suppressOutput` "are parsed but not supported yet". Segundo a extração, `continue: false` no `PostToolUse` faz o Codex **substituir o resultado pela mensagem do hook**. Eu não li o trecho original, só o resumo: **verificar antes de usar**. | learn.chatgpt.com/docs/hooks | Não | Talvez: um bigResult para Codex via `PostToolUse` + `continue: false` com o stub (cabeça + cauda + caminho) como mensagem. Depende da confirmação acima. |
| X4 | `PreCompact`/`PostCompact`: matchers `manual\|auto`; "If a matching `PreCompact` hook returns `continue: false`, Codex stops before compacting." Entrada traz `turn_id` e `trigger`. | learn.chatgpt.com/docs/hooks | Não | Parcial (mesmo que C6). |
| X5 | Config: `tool_output_token_limit` ("Token budget for storing individual tool/function outputs in history"), `model_auto_compact_token_limit`, `model_context_window`, `model_reasoning_effort` (`low` a `max` e `ultra`). Não encontrei `compact_prompt`, `project_doc_max_bytes` nem `agents.max_threads` nessa página. | learn.chatgpt.com/docs/config-file/config-reference | **Não** | Não é hook. O instalador do alvo `codex` já edita `~/.codex/config.toml`: pode propor `tool_output_token_limit` (equivalente nativo do bigResult, que no Codex não substitui saída) e `model_auto_compact_token_limit`. |

### 2.3 GitHub Copilot CLI

| # | Achado | Fonte | Já coberto? | Integrável? |
|---|---|---|---|---|
| G1 | Eventos: `sessionStart`, `sessionEnd`, `userPromptSubmitted`, `preToolUse`, `postToolUse`, `errorOccurred`, `agentStop`. `postToolUse`: `modifiedResult`, `additionalContext`. `preToolUse`: `permissionDecision` e, segundo a extração, `modifiedArgs` (a extração marcou como "implícito": **não confirmado**). `userPromptSubmitted`: `modifiedPrompt` só em hooks programáticos do SDK. | https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-hooks ; https://docs.github.com/en/copilot/reference/hooks-reference | **Sim** (bigResult e contrato já usam a extensão in-process) | `modifiedArgs` seria o equivalente de C2: confirmar o nome na página antes de usar. |
| G2 | `/compact`, `/context` (detalhe de uso de tokens) e compactação automática "when your conversation approaches 95% of the token limit"; troca de modelo por `/model` ou `--model`. | https://docs.github.com/en/copilot/concepts/copilot-surfaces/copilot-cli | Não | Não é hook. |

### 2.4 Cursor

| # | Achado | Fonte | Já coberto? | Integrável? |
|---|---|---|---|---|
| U1 | Eventos: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `subagentStart`, `subagentStop`, `beforeShellExecution`, `afterShellExecution`, `beforeMCPExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`, `preCompact`, `stop`, `afterAgentResponse`, `afterAgentThought`. `preToolUse` aceita `permission`, `user_message`, `agent_message`, `updated_input`. `postToolUse` só `user_message` (a extração disse que não há `updated_mcp_tool_output`); **não substitui o resultado**. | https://cursor.com/docs/hooks | Parcial (adapter usa o `preToolUse` genérico e 3 eventos nomeados) | Sim: `updated_input` (equivalente de C2) no `preToolUse` do Cursor. `beforeReadFile`/`beforeShellExecution` são ganchos específicos que o adapter pode usar se o `preToolUse` genérico falhar em alguma versão. Os campos de `preCompact` e `subagentStart` não constavam na extração: **não encontrei**. O plano R1 do repo cita `additional_context` no `postToolUse`; a extração desta página não o confirmou. |
| U2 | "Dynamic context discovery": saída longa de ferramenta é gravada em arquivo e o agente lê sob demanda; histórico do chat como arquivos para melhorar a sumarização; terminal sincronizado em arquivos; MCP carregado sob demanda: "reduced total agent tokens by 46.9%" nas execuções que chamaram uma ferramenta MCP (teste A/B do próprio Cursor). Sem data na página. | https://cursor.com/blog/dynamic-context-discovery | **Sim**, no conceito (bigResult grava integral em disco e devolve ponteiro) | Valida a tese; nada novo a integrar. O número 46,9% é do Cursor, não do token-guard. |

### 2.5 Posts de engenharia / API (complemento, não são hooks)

| # | Achado | Fonte | Já coberto? | Integrável? |
|---|---|---|---|---|
| A1 | Tool Search Tool: "85% reduction in token usage" mantendo a biblioteca inteira acessível (`defer_loading: true`). Programmatic Tool Calling: média de 43.588 para 27.297 tokens, "37% reduction" (`code_execution`, `allowed_callers`). Tool Use Examples: exatidão de 72% para 90%. Sem data na extração. | https://www.anthropic.com/research/advanced-tool-use (a URL pedida `/engineering/advanced-tool-use` resolveu para esta) | Não | Não: são recursos da API. No Claude Code o equivalente é C15. |
| A2 | Context editing (limpa chamadas e resultados antigos de ferramenta perto do limite) e memory tool: "reducing token consumption by 84%" em avaliação de busca web de 100 turnos; +29% só com context editing, +39% com os dois. Sem data na extração. | https://claude.com/resources/articles/context-management (a URL `anthropic.com/news/context-management` resolveu para esta) | Já citado em `docs/MARKET.md` (tool result clearing) | Não: é da API. No Claude Code não encontrei variável ou setting de limpeza de resultados (a página de prompt-caching só fala em "clearing old tool results" como causa de "expected rebuild"). |

## 3. As 5 ideias mais promissoras ainda não cobertas

Ordenadas por ganho esperado e simplicidade.

1. **Scout barato por construção.** Frontmatter do `agents/scout.agent.md` com `model: haiku`,
   `tools` somente leitura (ou `disallowedTools` de escrita), `maxTurns` e `effort: low`; mais um hook
   `SubagentStart` (matcher `scout`) que injeta o bloco `subagente` do contrato. Hoje o agente só tem
   `name`/`description`, então herda o modelo da sessão e o bloco é colado à mão. Fontes: C8, C9, C10.
   Esforço S. Ressalva: `model: haiku` troca qualidade por preço numa investigação; medir antes
   (o `cost` já separa por modelo).
2. **Compactar mais cedo por `env` do instalador (opt-in).** Gravar em `settings.json`, no mesmo merge
   que já existe, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` ou `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, e opcionalmente
   um `BASH_MAX_OUTPUT_LENGTH` menor. Os dados do próprio repo dizem que sessões acima de 200k tokens
   foram ~68% do gasto, e o `ctxwatch` só avisa. Fontes: C11, C12. Esforço S. Ressalvas:
   a variável só baixa o limiar; cada compaction é uma requisição grande e invalida o cache
   (C13); deve ser opt-in e aparecer no `status`.
3. **Aviso de cache frio no `ctxwatch`.** Comparar o horário do último turno do assistente no
   transcript com o TTL (1 h em assinatura, 5 min em API key/créditos) e avisar o humano, em
   `systemMessage`, de que o próximo prompt reprocessa ~Nk tokens; sugerir `/clear` se mudou de tarefa,
   ou `promptCacheTtl`/`CLAUDE_CODE_PROMPT_CACHE_TTL` para quem está em API key. Reusa
   `lastUsage()` e a tarifa por TTL do `cost.cjs`. Fonte: C13. Esforço S. Ressalva: eu não verifiquei que
   o transcript traz o horário em cada linha nem como distinguir 5 min de 1 h; checar nos transcripts reais.
4. **Reinjetar o contrato em `SessionStart(source=compact)`.** O próprio doc do harness diz que a saída
   desses hooks entra no contexto compactado, e que o que um hook adicionou antes é "summarized". O R6
   atual (limpar o estado no `PreCompact` e reinjetar no próximo prompt) deixa um vazio entre a
   compaction e o prompt; o `session-start.cjs` já lê `source`. Fontes: C5, C17. Esforço S.
   Ressalva: limite de 10.000 caracteres (C4).
5. **`updatedInput` no lugar de `deny` quando a correção é mecânica.** blindRead pode devolver o `Read`
   com faixa de linhas, shellDump pode acrescentar o teto no pipe (`| head -N`), com `additionalContext`
   dizendo o que foi feito. Poupa o turno de repetição e o texto do `reason`; a documentação de custos
   traz exatamente esse padrão para `npm test`. Fontes: C2 (Claude Code), U1 (`updated_input`, Cursor),
   G1 (`modifiedArgs` no Copilot, a confirmar). Esforço M. Ressalva: quebra a regra "nunca um deny
   cego" só na forma, não na essência (o aviso continua); exige teste de que a faixa escolhida não
   corta a região que o agente queria.

Fora do top 5, mas com ação concreta:

- **Corrigir a premissa do `mcp-cost` (C15).** No Claude Code as ferramentas MCP são adiadas por padrão,
  então o "9.695 tokens em toda sessão" do README superestima o preâmbulo naquele harness; o que paga toda
  sessão é nome + `instructions` do servidor (e `alwaysLoad`). Distinguir por harness. Esforço S-M.
- **Codex: `tool_output_token_limit` e `model_auto_compact_token_limit` no `config.toml` (X5)** e
  verificação do `PostToolUse` com `continue: false` (X3) para ter um bigResult no Codex.
- **Teste de tamanho do que o guard injeta** contra 10.000 caracteres no Claude Code (C4) e 2.500 no
  Codex (X2).
