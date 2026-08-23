# Backlog — melhorias anotadas fora de escopo

> Política do dono: ponto óbvio de melhoria encontrado DURANTE qualquer trabalho,
> mesmo fora do escopo, não é implementado na hora — entra aqui e no Brain, e é
> atacado assim que o escopo corrente fechar. Cada item traz origem e esforço
> estimado (S < 1h · M ~1 sessão · L multi-sessão).

## Aberto

| # | Item | Origem | Esforço |
|---|---|---|---|
| A1 | **Replay contínuo**: rodar `node bench/replay-transcripts.cjs` periodicamente (a cada release) e auditar a lista de suspeitos que ele imprime — o replay real de 2026-08 achou 2 classes de FP que nenhuma suíte pegava | gate 2.2.0 | S/recorrente |

## Fechado na release 2.2.0 (rodada 2 — "fechar tudo antes de lançar")

| # | Item | Resultado |
|---|---|---|
| F14 | **A1 Replay de transcripts reais** | `bench/replay-transcripts.cjs`: 79 transcripts / 65 sessões reais / 8.197 chamadas → 28 denies legítimos, ~437k tok líquidos. E o replay CUMPRIU seu propósito: expôs a classe de FP noisePath-fora-da-raiz (69→0) e git ls-files escopado — ambos corrigidos failing-first |
| F15 | **A2 Claude Code substituição real** | v2.1.121 estendeu `updatedToolOutput` para todas as tools; post-hook agora emite o stub como substituição (versões antigas: orientação) |
| F16 | **A3 Cursor broadScan** | Cursor passou a expor `preToolUse` genérico com matcher por ferramenta; adapter traduz o evento e o instalador registra — todas as 4 regras disparam no Cursor recente; matriz IDES.md atualizada |
| F17 | **A4 Sobrescrita de hooks Copilot** | corrigido upstream no CLI v1.0.11–12 (extensões fazem merge); `userPromptSubmitted.additionalContext` oficial desde v1.0.65 — monitoramento encerrado com versões mínimas documentadas |

## Fechado na release 2.2.0 (rodada 1)

| # | Item | Resultado |
|---|---|---|
| F1 | Contagens hardcoded em docs/help | tabelas viraram qualitativas; cada suíte imprime a própria contagem |
| F2 | writeJson não atômico | temp + rename indivisível |
| F3 | Matcher drift alvo `repo` | atualizado automaticamente no upgrade (`copilot` é in-process, sem matcher — N/A) |
| F4 | Plugin path re-carregava config a cada evento | memoização TTL 2s em `CFG.load` (env na chave) |
| F5 | Gatilhos por evidência sem injeção automática | post-hook acumula touched (cap 50) → prompt-hook injeta sempre+codigo/teste/docs; idem plugin Copilot via invocation.sessionId |
| F6 | Injeção do contrato só no Claude Code | `onUserPromptSubmitted` no adapter Copilot (mesmo estado compartilhado); MCP/Cursor seguem manuais por limitação dos harnesses |
| F7 | bigResult em falhas (Copilot) | avaliado: falha de ferramenta não adiciona custo proporcional; orientação seria ruído — fechado sem código |
| F8 | mcp-cost `--extra-files` | flag implementada (Zed/JetBrains/frotas próprias entram no inventário) |
| F9 | advice corta em 8 sem "+N mais"; divisão sem guard | ambos corrigidos |
| F10 | Teste EPIPE ausente | test/epipe.test.cjs: stdout destruído com filho vivo → exit 0, zero stack |
| F11 | CI sem Node 16 (engines >=16) | matriz 16/18/20/22 |
| F12 | Cláusulas README (lockfile dev-only, SDK provido pelo host) | bloco técnico final |
| F13 | debug.log na raiz; 'sem-sessao' global misturando repos | removido; identidade derivada da raiz |

## Histórico

- Itens F1–F13 originados do gate adversarial v2.1.0 → 2.2.0 (reviewer+tester
  independentes, achados confirmados por execução, fixes failing-first).
