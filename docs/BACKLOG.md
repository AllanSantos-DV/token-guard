# Backlog — melhorias anotadas fora de escopo

> Política do dono: ponto óbvio de melhoria encontrado DURANTE qualquer trabalho,
> mesmo fora do escopo, não é implementado na hora — entra aqui e no Brain, e é
> atacado assim que o escopo corrente fechar. Cada item traz origem e esforço
> estimado (S < 1h · M ~1 sessão · L multi-sessão).

## P1 — atacar primeiro

| # | Item | Origem | Esforço |
|---|---|---|---|
| 1 | **Contagens hardcoded já stale**: README "caixa" diz selftest=48 (real: 52). Remover números fixos das tabelas e apontar para a saída das próprias suítes | gate final | S |
| 2 | **writeJson não atômico** (install.cjs): crash mid-install pode truncar settings.json do usuário → gravar temp+rename | reviewer | S |
| 3 | **Matcher drift nos alvos `repo`/`copilot`** (MATCHER_COPILOT no hooks.json): reconcile() existe só no alvo claude; upgrades antigos herdam matcher velho silenciosamente | tester R3 generalizada | M |
| 4 | **Plugin path perde o pitch de latência**: CFG.load roda 1–2× por evento (~ms) no onPreToolUse/onPostToolUse; memoizar config por cwd+mtime devolveria o "~0,15 ms" do README | reviewer #9 | S-M |

## P2 — ganho médio

| # | Item | Origem | Esforço |
|---|---|---|---|
| 5 | **Gatilhos por evidência sem injeção automática** (codigo/teste/docs): UserPromptSubmit não traz arquivos tocados; acumular touched num estado de sessão via PostToolUse fecharia o circuito | design contract | M-L |
| 6 | **Injeção do contrato no Copilot/Cursor/MCP** — hoje só Claude Code injeta; verificar se o SDK expõe evento equivalente | docs CONTRACT status | M |
| 7 | **bigResult em falhas do Copilot**: SDK dispara onPostToolUse só em sucesso; avaliar onPostToolUseFailure para orientar também ali | reviewer #9 nuance | S |
| 8 | **mcp-cost `--extra-files ARQUIVO`**: API de discover() aceita extraFiles, CLI não expõe; habilitaria Zed/JetBrains sem esperar suporte nativo | auditoria IDES | S |
| 9 | **renderAdvice corta em 8 sem "+N mais"**; renderText divide por charsPerToken sem guard (só via API programática) | reviewer #11 | S |
| 10 | **Teste EPIPE** para post-hook/prompt-hook (fix aplicado sem RED dedicado — custo/benefício não fechava na época) | revisão própria | M |

## P3 — polimento / monitorar

| # | Item | Origem | Esforço |
|---|---|---|---|
| 11 | Replay de transcripts REAIS para validar economia (a simulação paramétrica é honesta mas é modelo) | bench savings | L |
| 12 | Claude Code: se hooks de comando passarem a aceitar modifiedResult no PostToolUse, trocar advisory por substituição real | IDES.md nota | S |
| 13 | Monitorar Cursor: se ganharem evento de busca, broadScan passa a disparar sem mudança no núcleo | IDES.md | — |
| 14 | CI: engines >=16 mas matriz testa 18/20/22 (avaliar custo de um job 16) | auditoria docs | S |
| 15 | README: cláusula "package-lock é de dev; runtime zero-dep"; campo `"extensions":["."]` do plugin.json sem explicação | auditoria docs | S |
| 16 | Limpeza: `debug.log` na raiz (gitignored); `'sem-sessao'` compartilhado quando harness não manda session_id | housekeeping | S |

## Fechados nesta sessão (referência)

- Config knobs fora do sanitize truncando tudo → DEFAULTS.limits + guards locais ✅
- liveOther duplicando guard → reconcile() substitui layout antigo ✅
- Matcher drift (claude) → atualização automática ✅
- Dedup hooks[0] → flatMap nos três eventos ✅
- EPIPE + persist-before-deliver → handler + emitir antes de persistir ✅
- Colisão de session-id sanitizado → sufixo sha1 do id original ✅
