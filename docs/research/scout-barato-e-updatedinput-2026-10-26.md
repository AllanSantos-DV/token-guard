# P1 scout barato por construção e P4 `updatedInput` no lugar de `deny`

Data: 2026-10-26. Fontes lidas em 2026-10-26.

## Fontes

- Frontmatter de subagente: <https://code.claude.com/docs/en/sub-agents>
  - `disallowedTools`: remove ferramentas da lista herdada ou de `tools`.
  - `maxTurns`: limite de turnos; ao atingir, devolve a saída marcada como parcial e o pai pode retomar (a marca exige Claude Code v2.1.246 ou superior).
  - `effort`: `low`, `medium`, `high`, `xhigh`, `max`; sobrepõe o esforço da sessão, mas não `CLAUDE_CODE_EFFORT_LEVEL`.
  - `hooks` e `mcpServers` no frontmatter são ignorados em subagente de plugin.
- Eventos de hook: <https://code.claude.com/docs/en/hooks>
  - `SubagentStart`: entrada com `agent_id` e `agent_type`; saída `hookSpecificOutput.additionalContext` entra no contexto do subagente antes do primeiro prompt; o hook não bloqueia a criação; o matcher casa o `name` do frontmatter (ancorar com `^scout$` para casamento exato).
  - `PreToolUse`: `updatedInput` "substitui o objeto de entrada inteiro"; a permissão é avaliada sobre a entrada devolvida. Com vários hooks e decisões diferentes, a precedência é `deny` > `defer` > `ask` > `allow`. A página não define a ordem de aplicação de `updatedInput` de hooks paralelos (a regra de coexistência do Smart Tool 0.9.34 diz o mesmo: mesma entrada para todos, ordem indefinida, deny prevalece).

## P1 — decisão: fazer, em três peças

1. `agents/scout.agent.md` ganha `disallowedTools: Edit, Write, NotebookEdit`, `maxTurns: 30` e `effort: medium`.
   - Lista de negação em vez de `tools` de leitura: um `tools` fechado também tiraria do scout as ferramentas MCP de busca semântica e o Bash, que ele usa para localizar antes de ler. Negar escrita deixa o scout somente leitura sem cortar a busca.
   - `maxTurns: 30`: a medição de 2026-10-24 viu 5 a 13 chamadas por pergunta; 30 dá folga e ainda corta o scout que não converge. Estourar o limite devolve saída parcial, retomável.
   - `effort: medium`: investigar é ler e localizar, não raciocinar longo. **Não medido** nesta rodada (a medição de 2026-10-24 cobriu só o modelo). O frontmatter é a alavanca; se uma medição futura mostrar perda de acurácia, basta subir.
2. Hook `SubagentStart` (`adapters/subagent-start.cjs`, matcher `^scout$`) injeta o bloco `subagente` do contrato (`CT.subagentText`) no início da conversa do scout. Substitui a cola manual de `token-guard contract --subagente`. Respeita `TOKEN_GUARD=off` e usa o contrato do repositório sobre o default; sem `cwd` ou com erro, silêncio (fail-open).
3. O instalador (alvo `claude`, modo http e modo comando) registra o hook e grava o scout em `~/.claude/agents/scout.agent.md`.
   - **Achado:** até a 2.12.3 o scout só era copiado para `~/.claude/token-guard/agents/` (asset), e nunca para a pasta que o Claude Code lê; o `lib/scout.cjs` sugeria um subagente que não existia na lista de agentes. Sem isso, as peças 1 e 2 não teriam efeito.
   - Atualiza só o scout reconhecido pelo título (`# Scout — reconhecimento com contexto descartável`); agente homônimo do usuário é preservado.

## P4 — decisão: não fazer

Registrado como **decidido**, com a evidência:

1. **Não há correção mecânica que preserve o sentido.** O `blindRead` barra a leitura de arquivo grande sem faixa: o trecho que importa só quem pediu sabe; uma faixa fixa (as primeiras N linhas) devolveria conteúdo diferente do pedido sem o modelo saber. O `shellDump` barra saída sem teto: `| head` esconde o resto e muda o código de saída do pipeline.
2. **Reescrita silenciosa quebra o princípio 3 do projeto** ("todo bloqueio ensina") e o fail-loud: o modelo acredita que leu o arquivo inteiro ou que o comando terminou limpo. O `deny` com a reescrita pronta na razão (2.12.0) ensina e mantém o modelo a par do que de fato roda.
3. **Coexistência.** `updatedInput` substitui o objeto inteiro e os hooks rodam em paralelo com o mesmo input, com ordem de aplicação indefinida. O Smart Tool 0.9.34 já reescreve buscas de conteúdo no Bash; uma segunda reescrita do token-guard no mesmo comando seria uma corrida em que um dos dois resultados se perde. O `deny` não tem esse problema: prevalece na precedência documentada e é idempotente.
4. **O custo que o P4 pouparia é um turno por bloqueio**, já reduzido pela razão que traz a reescrita pronta. O replay de 30.206 buscas reais (A34) mostrou 6 negações, ou seja, frequência baixa.

Reabrir se: o harness passar a distinguir `updatedInput` de hooks independentes (merge definido), e houver uma correção cujo sentido o modelo não perde (por exemplo, normalizar `\` de caminho), não um corte de conteúdo.
