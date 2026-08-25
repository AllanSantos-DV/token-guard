# Contrato de saída

Os guards cuidam da **entrada** (o que o agente lê). O contrato cuida da **saída**
(o que o agente escreve): regras de forma que evitam lixo caro — recapitulação,
narrativa de sessão em comentário, cerimônia sem valor — porque saída-lixo vira
**imposto permanente de entrada** para toda leitura futura.

## As peças

| Peça | Papel |
|---|---|
| `contract.default.md` | O padrão, dividido por seção-gatilho. |
| `lib/contract.cjs` | Parsing, gatilho por evidência acumulada e estado por sessão. |
| `contract.cjs` | CLI de inspeção (`token-guard contract`). |
| `contract.md` (seu repo) | Substitui **seções inteiras** do padrão; seção não mencionada continua vindo do padrão. |

## Seções e gatilhos

| Seção | Entra quando | Injeta na sessão principal? |
|---|---|---|
| `sempre` | Toda tarefa | sim, uma única vez |
| `quando: codigo` | A sessão leu/escreveu arquivo-fonte | sim, uma única vez |
| `quando: teste` | Tocou arquivo de teste | sim, uma única vez |
| `quando: docs` | Escreveu markdown/docs | sim, uma única vez |
| `subagente` | — | NUNCA: vai no prompt de quem roda em contexto descritável |

O gatilho é **evidência acumulada** (caminhos tocados), nunca classificação da
frase do usuário. Uma sessão de prosa não recebe regra de código. Cada seção é
injetada no máximo uma vez por sessão; o estado fica em `.token-guard/sessions/`
com poda de 7 dias.

## Duas invariantes de escrita

1. **Afirmação, não ordem.** Texto injetado em imperativo aciona a defesa contra
   prompt injection: o modelo mostra o texto ao usuário em vez de segui-lo.
2. **Só regra que nunca precisará ser retirada.** A injeção fica no transcript e
   sobrevive ao `--continue` sem o hook rodar de novo.

## Inspecionar

```bash
npx @allansantos-dev/token-guard contract                        # seções, regras, custo em tokens
npx @allansantos-dev/token-guard contract --touched src/a.ts     # simula a evidência da sessão
npx @allansantos-dev/token-guard contract --json                 # dados crus
npx @allansantos-dev/token-guard contract --subagente            # bloco pronto p/ colar no scout
```

`TOKEN_GUARD=off` zera o contrato junto com os guards.

## Status honesto

A biblioteca e o CLI de inspeção estão estáveis e testados (42 casos). A injeção
automática existe desde a 2.1.0 no Claude Code via `UserPromptSubmit`: a camada
`sempre` entra UMA vez por sessão, direto no contexto, com estado em
`.token-guard/sessions/`. Limitação declarada: os gatilhos por evidência
(`codigo`/`teste`/`docs`) ainda não têm injeção automática — o payload do
UserPromptSubmit não traz arquivos tocados; e no Copilot/Cursor/MCP a injeção
segue manual (`--subagente` ou copiar o texto). Automatizar nesses harnesses é
o próximo passo natural (ver CONTRIBUTING.md para as convenções).
