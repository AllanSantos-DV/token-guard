# Backlog — melhorias anotadas fora de escopo

> Política do dono: ponto óbvio de melhoria encontrado DURANTE qualquer trabalho,
> mesmo fora do escopo, não é implementado na hora — entra aqui e no Brain, e é
> atacado assim que o escopo corrente fechar. Cada item traz origem e esforço
> estimado (S < 1h · M ~1 sessão · L multi-sessão).

## Aberto

_(nenhum item aberto no momento — os 13 itens da rodada "resolva todos" de 2026-09-20 foram fechados abaixo)_

## Fechado na rodada "resolva todos" (sessão 2026-09-20)

| # | Item | Resultado |
|---|---|---|
| A1 | Replay contínuo de transcripts reais | Executado via `npm run replay`: 265 arquivos, 52 sessões, 22.315 chamadas de ferramenta (16.825 nas famílias vigiadas) → 88 denies (60 blindRead, 6 shellDump, 8 noisePath, 14 broadScan), ~1.348.200 tok líquidos estimados nessas sessões. Auditoria manual dos até 40 denies impressos: nenhum falso positivo novo identificado — todos os casos (PDFs binários, `find` em vez de `git ls-files`, leituras de arquivo grande sem offset/limit, scan amplo de padrão) são bloqueios legítimos. Nenhuma classe de FP nova descoberta nesta rodada (as 2 classes achadas em 2026-08 já estão corrigidas desde a release 2.2.0). Item é recorrente por natureza — repetir a cada release |
| A2 | Teste `TOKEN_GUARD=off`/`warn` ponta a ponta com daemon real ausente | Novo bloco em `test/daemon-adapters-parity.test.cjs`: sobe daemon real, gera baseline `deny`, depois prova que `TOKEN_GUARD=off` e `TOKEN_GUARD=warn` no ambiente do processo cliente bypassam o daemon (via `hasTokenGuardEnvOverride()` em `lib/daemon-client.cjs`, comportamento pré-existente e correto) sem precisar derrubar/reconfigurar o daemon. 3 novos `check()`, confirmados verdes |
| A3 | `handleMessage()` tratava `msg.id === 0` como ausente | `adapters/daemon-server.cjs`: guard trocado de `!msg.id` para `msg.id === undefined \|\| msg.id === null`. Teste novo em `test/daemon-server.test.cjs` prova que `id:0` responde normalmente |
| A4 | Windows: named pipe órfão derrubava o daemon novo pra sempre | `adapters/daemon-server.cjs`: retry-com-backoff específico de win32 (`WIN32_MAX_RETRIES=3`, `WIN32_RETRY_DELAY_MS=50`) dentro do handler de `EADDRINUSE`, cobrindo a janela entre o processo antigo morrer e o kernel liberar o handle do named pipe (sem lógica de unlink, que não se aplica a named pipes). Regressão live nova em `test/daemon-singleton.test.cjs` (gated a `process.platform === 'win32'`): segura um listener real, spawna um daemon real contra o mesmo endpoint, libera o listener no meio da sequência de retry, confirma que o filho eventualmente sobe (`OK:listening`) em vez de desistir |
| A5 | Ruído de stderr do filho vazando pro console em `test/daemon-singleton.test.cjs` | `stdio: ['ignore','pipe','pipe']` explícito adicionado ao `execFileSync` existente (defensivo — empiricamente o ruído não era mais reproduzível mesmo antes do fix, mas o comportamento implícito era frágil) |
| A7 | `docs/PLAN-daemon-unico.md` cabeçalho YAML ainda dizia `status: PLANNED` | Corrigido para `status: DONE (v2.3.0)` — F1–F8 já estavam marcadas `✅ DONE`/`FECHADO` no corpo do doc (§5), só o header YAML estava desatualizado (doc drift, sem impacto funcional) |
| A9 | `SEMVER_RE` aceitava zero à esquerda em identificadores numéricos | `lib/update-check.cjs`: regex trocada pela oficial de semver.org (rejeita `01.1.1`, `1.2.3-0123`, etc.). 4 novas asserções em `test/update-check.test.cjs` |
| A10 | `compareVersions` ignorava sufixo de pre-release/build | `lib/update-check.cjs`: implementação completa do algoritmo de precedência do semver.org (`parseSemver`/`compareIdentifier`/`comparePrerelease`), incluindo a regra "mais campos de pre-release = maior precedência" e "release sempre > pre-release do mesmo major.minor.patch". 7 novas asserções em `test/update-check.test.cjs` |
| A11 | `REAL_DEPS.readCache` aceitava `checkedAt: Infinity` | `lib/update-check.cjs`: troca de `typeof parsed.checkedAt !== 'number'` para `!Number.isFinite(parsed.checkedAt)` |
| A12 | A4h provava o branch `https:` só por efeito colateral (crash opaco), não por asserção direta | `test/update-check.test.cjs`: A4h reescrito para usar um servidor HTTP puro real (sem TLS) — se o código por engano usasse `http` para uma URL `https:`, o servidor responderia 200 (falha observável por asserção); usando `https` de verdade, o handshake TLS falha contra o servidor plain-HTTP (branch corretamente exercitado) |
| A13 | `REAL_DEPS.writeCache` nunca testado criando diretório pai inexistente | Novo bloco B5 em `test/update-check.test.cjs`: `checkForUpdate` chamado com `cacheFile` apontando pra um diretório aninhado genuinamente inexistente, usando `REAL_DEPS.writeCache` real (sem mock) — confirma criação do arquivo e dos diretórios pais |
| A14 | O `catch` em torno de `await deps.fetchLatest(...)` nunca era exercitado | Novo bloco C3a-C3c em `test/update-check.test.cjs`: mock de `fetchLatest` que rejeita, testado com e sem cache prévio (`reason:'offline'` sem cache; usa cache válido best-effort quando existe) |
| A15 | `.vscode/scripts/pack-smoke.mjs` reportava "0 arquivo(s) no pacote" (falso negativo) | Duas causas raiz corrigidas: (1) `npm pack --dry-run` escreve em stderr, não stdout — `execSync` passou a usar `2>&1` pra fundir os streams; (2) isso revelou um segundo bug oculto: o parser de linhas confundia o cabeçalho "Tarball Details" com entradas de arquivo, e o regex `SUSPECT` tinha um padrão bare `token` que batia no próprio nome do projeto (`token-guard.cjs`, `token-audit.cjs`, etc.) — ambos corrigidos com regex mais precisos. Verificado contra o tarball real: "83 arquivo(s) no pacote, nenhum nome suspeito de segredo". O gate de segurança estava silenciosamente no-op desde sempre (lista sempre vazia → sempre passava) |

## Fechado na feature update-notify (sessão 2026-09-20)

| # | Item | Resultado |
|---|---|---|
| A8 | **Formato exato da linha de aviso quando `updateAvailable:true` não tinha smoke E2E via `cli.cjs`** | Resolvido sem precisar expor `depsOverride` no CLI: `test/update-check.test.cjs` camada F ganhou F3a-d, que pré-popula `<fakeHome>/.token-guard/update-check.json` com cache fresco (não-stale) via redirecionamento de `HOME`/`USERPROFILE` (mesmo padrão de `test/install.test.cjs`), forçando `checkForUpdate` a usar o cache sem bater rede — determinístico, sem flakiness. Achado pela rodada tester do gate final (2026-09-20), fixado e revalidado |

## Fechado por F7 daemon-único (sessão 2026-09-19)

| # | Item | Resultado |
|---|---|---|
| A6 | **`TOKEN_GUARD_SID` nunca era setado por caminho de produção** — `defaultEndpoint()` no Windows caía em `process.pid` por processo, daemon autostart e hook-client nunca convergiam no mesmo named pipe | `install.cjs`/`installAutostartWindows()`: `setx TOKEN_GUARD_SID <username-sanitizado>` gravado em `HKCU\Environment` junto do registro da Task Scheduler; vale a partir do próximo logon/sessão do Windows. Testado via `--dry-run` em `test/install.test.cjs` (schtasks/setx reais nunca invocados em teste automatizado) |

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
