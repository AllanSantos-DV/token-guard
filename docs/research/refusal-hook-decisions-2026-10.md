# Como os hooks tratam deny, ask e o motivo — pesquisa de 2026-10-24

Pergunta: qual decisão de um hook `PreToolUse` gera prompt ao usuário, e para quem vai o texto
do motivo? Base para a regra do token-guard: **a recusa ensina o agente; nunca pergunta ao
usuário.**

Acesso a todas as fontes: **2026-10-24** (páginas lidas pelo `web_fetch`, que devolve o trecho
que um modelo pequeno extrai; as duas vieram de cache de 2026-10-23).

## Claude Code — https://code.claude.com/docs/en/hooks

| Decisão | Efeito (citação) |
|---|---|
| `allow` | "skips the permission prompt" |
| `deny` | "prevents the tool call"; o motivo é "shown to Claude" (e não ao usuário) |
| `ask` | "prompts the user to confirm"; o prompt ganha um rótulo com a origem (`[settings]`, `[plugin:<name>]`, `[skill]`) |
| `defer` | "ends the turn so the tool can be resumed later" |
| exit 2 | "Claude sees the stderr message as the denial reason" |
| `additionalContext` com `allow` | "written to the debug log only" |

Consequências para o token-guard:

1. `ask` é a única decisão que gera prompt ao usuário. O token-guard só a emitia em modo `warn`.
2. `allow` com texto **não** chega ao modelo: o `warn` "só avisa" nunca teria como ensinar pelo
   `PreToolUse`. E `allow` ainda pularia o prompt de permissão do próprio usuário — pior que
   nada.
3. O único canal que leva texto ao agente é o `deny` (ou exit 2): o motivo vai ao modelo.

## Codex — https://developers.openai.com/codex/hooks (redireciona para learn.chatgpt.com/docs/hooks)

- `PreToolUse` aceita `permissionDecision` `deny`/`allow`/`ask`, `permissionDecisionReason`,
  `additionalContext`, `systemMessage`, `continue`/`stopReason` e exit 2 com stderr.
- Para negar: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`.
- `permissionDecision: "ask"` "[is] parsed but not supported yet. Codex marks the hook run as
  failed, reports the error, and continues the tool call."

Consequência: no Codex, `ask` não pergunta nada — o hook falha e a chamada segue sem guard.

## Cursor

O adapter mapeava `ask` para `permission: "ask"` (confirmação do usuário), segundo o comentário
do próprio `adapters/cursor-hook.cjs`. **Não reli a documentação do Cursor nesta rodada.**

## Decisão

- `decide()` devolve só `deny`; o texto traz "DO THIS INSTEAD" com o comando ou a chamada de
  ferramenta já reescritos com os argumentos do pedido.
- `mode: "warn"` (config, `TOKEN_GUARD=warn`, `--mode warn`) foi aposentado e vale `block`.
- Teste `test/refusal-teaches.test.cjs`: toda recusa é `deny`, o texto é executável, o comando
  sugerido passa pelo próprio guard, nenhum arquivo de `lib/` ou `adapters/` emite `ask`.
