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
| `quando: codigo` | Tocou arquivo-fonte (guarda/fallback, helper, abstração existente) | sim, uma única vez |
| `quando: teste` | Tocou arquivo de teste | sim, uma única vez |
| `quando: docs` | Escreveu markdown/docs | sim, uma única vez |
| `subagente` | — | NUNCA na sessão principal: no Claude Code o `SubagentStart` o injeta no scout; nos demais vai no prompt de quem roda em contexto descartável |

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

| Harness | Camada `sempre` | Gatilhos por evidência (`teste`/`docs`) |
|---|---|---|
| Copilot CLI/App (plugin) | automática (`onUserPromptSubmitted`) | automáticos |
| Claude Code | automática (`UserPromptSubmit`); bloco `subagente` no scout via `SubagentStart` | automáticos desde a 2.6.2 |
| Cursor, Codex, MCP | manual (`--subagente` ou copiar o texto) | manual |

Depois de `/compact` ou `/clear` no Claude Code, o `SessionStart` zera o que já foi
injetado e o prompt seguinte traz o contrato de volta (no `resume` o histórico já o contém).
Se a compactação automática cair no meio de um turno, o contrato só reaparece na próxima
mensagem do usuário.

Como a evidência chega: o pós-execução (`PostToolUse` / `onPostToolUse`) grava o
arquivo que cada ferramenta tocou em `.token-guard/sessions/<id>-touched.json`; no
prompt seguinte, a seção que o gatilho liga entra uma vez. Antes da 2.6.2, no Claude
Code esse registro só acontecia quando o resultado era truncado — na prática, só a
camada `sempre` entrava.

## Dono de cada regra

Uma regra chega ao modelo por **um** canal. O token-guard só entrega regra sobre a
**forma e o custo da saída**; política pessoal do usuário (idioma, fail-loud, pesquisa,
revisão, escopo) mora nas instruções dele e o token-guard nunca a carrega.

| Regra | Dono | Canal |
|---|---|---|
| Forma da resposta (`sempre`) | token-guard | `UserPromptSubmit`, uma vez por janela |
| Código enxuto: sem cerimônia, sem código morto | regras com escopo do Boss (`rule:codigo:sem-cerimonia`, `rule:codigo:sem-codigo-morto`) | injeção do Boss, uma vez por escopo; o padrão não as repete |
| Código enxuto: guarda/fallback, helper só depois de consultar o repositório, abstração existente (`codigo`) | token-guard | `UserPromptSubmit`, no prompt seguinte ao toque em arquivo-fonte; vale com ou sem o Boss |
| Teste (`teste`) e documentação (`docs`) | token-guard | idem |
| Contrato do subagente (`subagente`) | token-guard | `SubagentStart`, só no scout |
| Comentários de código | instruções globais do usuário | o token-guard nunca a entrega |
| Idioma, fail-loud, pesquisa, revisão, YAGNI, patch sobre greenfield | instruções globais do usuário | o token-guard nunca a entrega |

Usuário que já escreve uma dessas seções nas próprias instruções declara em
`~/.token-guard/token-guard.config.json` (ou no config do repositório):

```json
{ "contract": { "skip": ["docs"] } }
```

A seção pulada some do contrato inteiro (injeção, `contract` da CLI, simulação). O teste
`test/contract-ownership.test.cjs` falha se uma regra chegar duas vezes na mesma janela, se
o padrão voltar a carregar regra de comentário ou se `skip` não calar a seção.

## Algoritmo de entrega (contrato para quem integra)

1. **Escopo por evidência.** Os caminhos que a sessão tocou (`-touched.json`, até 50) ligam
   `codigo` / `teste` / `docs`; `sempre` vale sempre. A frase do usuário nunca classifica.
2. **Uma vez por janela.** `injected` guarda as seções já entregues na sessão; só o que falta
   é injetado. O único ponto de escrita desse estado é `CT.commitInjection`, usado pelo hook de
   comando, pelo hook http do daemon e pelo plugin do Copilot.
3. **Reinjeção.** `SessionStart` com `source` `compact` ou `clear` zera `injected` (a evidência
   em disco sobrevive); o prompt seguinte entrega de novo o conjunto que a evidência pede. `resume`
   e `startup` não mexem: o histórico volta com o texto.
4. **Texto declarativo, sem ordem**, para não acionar a defesa contra prompt injection.
5. **Um processo por categoria.** `UserPromptSubmit`, `PreToolUse` e `PostToolUse` são atendidos
   pelo daemon por hook http (nenhum processo por chamada). Só `SessionStart` e `SubagentStart`
   são hook de comando, porque o harness não os aceita por http; ambos declaram
   `--hook-origin=token-guard`.
6. **Observável.** Cada injeção vira uma linha em `~/.token-guard/injections.jsonl`
   (`origin`, `target`, `session`, `reason`: `inicio` | `evidencia` | `compact` | `clear`,
   `sections`, `chars`, `tokens`), aparado acima de 256 KB.

Quem implementa o mesmo algoritmo em outro harness (o Boss, `harness-padroes-cliente`) precisa
de: estado por sessão com as seções entregues, zerado em `compact`/`clear`; escrita única desse
estado; origem declarada em cada hook; registro do que entregou e do tamanho.
