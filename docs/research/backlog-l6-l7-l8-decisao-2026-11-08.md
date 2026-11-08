# L6, L7 e L8: o que cada um mostra, precedentes e preço real (2026-11-08)

Base da decisão do dono sobre os três candidatos da lente irmã da 2.18.2 (`docs/BACKLOG.md`). Board narrado:
`boards/backlog-l6-l7-l8.html`, gerado por `boards/backlog-l6-l7-l8.gen.mjs`.

## Medido nesta máquina

- `lib/events.cjs:summary()`: hoje 2 barrados e ~44k tokens poupados; total 102 barrados e ~1,2M tokens poupados
  desde 2026-10-30. "Poupado" conta só o medido (corte de texto, leitura repetida) a 4 caracteres por token; barrado
  não soma tokens (texto da tela de setup, `adapters/ui/setup.html`).
- `token-guard status` hoje mostra só configuração (modo, regras, cache, daemon, hook http, scout); não importa
  `lib/events.cjs`.
- `token-guard cost --since 1d`: 60 sessões e 25101 chamadas num total só, de todos os projetos. `readTranscript` já
  guarda o `cwd` de cada sessão; `renderText` usa só o nome da pasta na lista das mais caras.

## Precedentes (web)

| Afirmação | Fonte | Acessado em |
|---|---|---|
| CLI de economia de tokens mostra o ganho no terminal com divisão por dia; tokens estimados como bytes/4 | https://www.rtk-ai.app/docs/analytics/gain/ | 2026-11-08 |
| Tokens poupados não viram economia igual na conta: são uma parte da entrada, que é uma parte da conta | https://www.rtk-ai.app/docs/resources/savings-explained/ | 2026-11-08 |
| Custo filtrado por projeto (`--project`) e agrupado por projeto (`--instances`) | https://ccusage.com/guide/cli-options | 2026-11-08 |
| Opus 5.5 US$ 4/20 por Mtok, cache lido US$ 0,20 (0,05×); Sonnet 5.5 US$ 2/10 (cache 0,05×); Fable 5.1 US$ 10/50 (cache 0,025×); Haiku 5.5 em duas faixas | https://platform.claude.com/docs/en/about-claude/pricing | 2026-11-08 |

## Consequências

- L8: pelos mesmos ~1,2M tokens, US$ 4,83 a preço de entrada do Opus 5.5 e US$ 0,24 a preço de cache, 20× de
  diferença; e um texto que fica no contexto é relido a cada turno, então a economia real também pode ser maior. Só é
  honesto com a palavra "estimativa" e a conta usada visíveis.
- A tabela padrão do token-guard (`lib/cost.cjs`: opus 5/25, sonnet 3/15, haiku 1/5, cache 0,1× para todos) está
  desatualizada: item técnico C10 no backlog, independente da decisão sobre L6/L7/L8.

## Pesquisa anterior aplicada

`docs/research/refusal-hook-decisions-2026-10.md`: toda recusa é `deny` com a reescrita barata (não há `ask`, o modo
aviso foi aposentado). Logo, "barrados" em L6 conta chamadas trocadas pela alternativa barata, não perguntas ao
usuário; e L6/L8 são exibição para o usuário (CLI e tela de setup), fora do contexto do modelo, sem custo de tokens.
Não muda nada em L7.
