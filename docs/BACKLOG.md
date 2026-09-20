# Backlog — melhorias anotadas fora de escopo

> Política do dono: ponto óbvio de melhoria encontrado DURANTE qualquer trabalho,
> mesmo fora do escopo, não é implementado na hora — entra aqui e no Brain, e é
> atacado assim que o escopo corrente fechar. Cada item traz origem e esforço
> estimado (S < 1h · M ~1 sessão · L multi-sessão).

## Aberto

| # | Item | Origem | Esforço |
|---|---|---|---|
| A1 | **Replay contínuo**: rodar `node bench/replay-transcripts.cjs` periodicamente (a cada release) e auditar a lista de suspeitos que ele imprime — o replay real de 2026-08 achou 2 classes de FP que nenhuma suíte pegava | gate 2.2.0 | S/recorrente |
| A2 | **Teste `TOKEN_GUARD=off` ponta a ponta com daemon real**: `test/daemon-adapters-parity.test.cjs` cobre fail-open de endpoint inexistente mas não o escape hatch `TOKEN_GUARD=off` com um daemon de pé via `spawnSync` dos 3 hooks — verificado manualmente, mas hoje pode regredir sem teste pegar | gate F3 daemon-único, rodada 2 de revisão (`reviewer` ade1ff2a775f49a4c) | S |
| A3 | **`handleMessage()` trata `msg.id === 0` como inválido** (`adapters/daemon-server.cjs:89`) — sem resposta, cliente só descobre por timeout. Inofensivo hoje (`lib/daemon-client.cjs` nunca gera id 0, faz `++reqId` antes de usar), mas é fragilidade de contrato pra qualquer cliente RPC futuro que comece a contagem em 0 | gate F3 daemon-único, rodada 2 de revisão (`reviewer` ade1ff2a775f49a4c) | S |
| A4 | **Windows: named pipe órfão derruba o daemon novo pra sempre.** `claimOrphanMutex`/o retry de socket órfão em `start()` só roda com `process.platform !== 'win32'` (`adapters/daemon-server.cjs`, guard dentro do handler `server.on('error', ...)`) — no Windows, `EADDRINUSE` sem lock-record correspondente cai direto em `giveUp()`, sem tentativa de reclaim. Isso só importa quando `TOKEN_GUARD_SID` está setado (pipe compartilhado entre processos), que é exatamente o modo de deploy alvo primário do projeto (`docs/PLAN-daemon-unico.md`: `platform_target: win32 corporate`). Cenário: daemon crasha sem limpar, o named pipe "morre" mas o SO ainda reporta conflito ao segundo `listen()` → falso "já em execução" permanente até reinício manual. Achado pela rodada 8 de revisão independente F4 (`reviewer` a1eab51c0458f7a43), pré-existente ao trabalho desta sessão, não regressão | gate F4 daemon-único, rodada 8 de revisão (`reviewer` a1eab51c0458f7a43) | M |
| A5 | **Ruído de stderr do processo filho vazando pro console/CI em `test/daemon-singleton.test.cjs`** (teste do socket órfão único, `execFileSync` sem `stdio` explícito) — Node herda o `stderr` do filho por padrão, então toda execução imprime `token-guard daemon pronto em ...` mesmo quando o teste passa. Não afeta a asserção (usa `out.includes(...)`, não `stderr`), só suja o log. Fix sugerido: `stdio: ['pipe','pipe','ignore']`. Achado pela rodada 9 de revisão independente F4 (`reviewer` a9dc5d262c4581c07), não-bloqueante por recomendação do próprio revisor | gate F4 daemon-único, rodada 9 de revisão (`reviewer` a9dc5d262c4581c07) | S |
| A7 | **`docs/PLAN-daemon-unico.md` cabeçalho YAML ainda diz `status: PLANNED`** apesar de F1–F7 (incl. F2b contract/postprocess RPC + F3 thin clients) estarem implementados, testados e liberados (confirmado por `lib/daemon-client.cjs`, `test/daemon-contract-parity.test.cjs`, `test/daemon-postprocess-parity.test.cjs` já existentes em disco, e F7 fechado na tabela acima) — doc drift, sem impacto funcional | achado ao retomar sessão 2026-09-20 pra feature update-notify (plano de sessão anterior estava em modo-plano não commitado sobre o mesmo tema, já obsoleto) | S |
| A9 | **`SEMVER_RE` (`lib/update-check.cjs:50`) aceita zero à esquerda em identificadores numéricos** (`01.1.1`, `1.2.3-0123` passam), o que a spec oficial semver.org proíbe. Sem impacto de segurança (charset já restrito a `[0-9A-Za-z-]`, não há brecha de injeção) — só imprecisão de spec-compliance sem cobertura de teste | Review Round 5 da feature update-notify (`reviewer`, gate final pós-fix ANSI) | S |
| A10 | **`compareVersions` (`lib/update-check.cjs:21-30`) ignora sufixo de pre-release/build ao comparar** — só olha os 3 segmentos numéricos. Se o dist-tag `latest` do registry apontar pra algo como `2.4.0-beta.1`, `compareVersions('2.4.0','2.4.0-beta.1')` retorna igual (0) e nenhum aviso dispara mesmo havendo publicação nova. Risco baixo (convenção do npm é `latest` ser sempre release estável), pré-existente ao escopo do fix ANSI desta sessão | Review Round 5 da feature update-notify (`reviewer`, gate final pós-fix ANSI) | S |
| A11 | **`REAL_DEPS.readCache` (`lib/update-check.cjs:119-129`) só valida `typeof checkedAt === 'number'`, aceitando `Infinity`** — um `checkedAt: Infinity` no arquivo de cache faz `isStale` nunca mais expirar (`now - Infinity >= ttlMs` é sempre `false`). Exige acesso de escrita ao próprio `~/.token-guard/update-check.json` do usuário (mesma fronteira de confiança do processo, não é vulnerabilidade de fronteira real) — robustez teórica, fix sugerido é um `Number.isFinite(parsed.checkedAt)` a mais | Review Round 5 da feature update-notify (`reviewer`, gate final pós-fix ANSI) | S |
| A12 | **A4h (`test/update-check.test.cjs`) prova o branch `https:` por efeito colateral da validação de protocolo do Node, não por asserção direta** — se a ternária `client = url.startsWith('https:') ? https : http` fosse invertida, o teste não falharia com mensagem legível: o processo crasharia via unhandled rejection (`ERR_INVALID_PROTOCOL`) antes do `check()` rodar. Regressão ainda é pega (processo não-zero), mas de forma opaca. Fix sugerido: apontar `fetchVersionFromUrl('https://...')` pra um servidor HTTP puro (sem TLS) local — se `https` for usado de verdade, o handshake falha (`null`); se por engano usar `http`, o servidor responde 200 normalmente, tornando a distinção observável por asserção, não por crash | Gate v2 tester pós-fix MAJOR update-notify (2026-09-20) | S |
| A13 | **`REAL_DEPS.writeCache` (`lib/update-check.cjs:130-135`) nunca é testado criando um diretório `~/.token-guard/` que realmente não existe** — todos os 53 casos escrevem em `TMP` já criado via `mkdtempSync`, então `fs.mkdirSync(dirname, {recursive:true})` sempre roda contra diretório já presente. Uma regressão que removesse esse `mkdirSync` quebraria silenciosamente o cache na primeira execução real de um usuário (onde `~/.token-guard/` ainda não existe), sem nenhum dos testes atuais detectar | Gate v2 tester pós-fix MAJOR update-notify (2026-09-20) | S |
| A15 | **`.vscode/scripts/pack-smoke.mjs` reporta "0 arquivo(s) no pacote" (falso negativo)** — o parser de linhas `npm notice` não bate com o formato real do `npm pack --dry-run` desta versão do npm (83 arquivos reais, verificado manualmente); o script ainda funciona pro objetivo de achar nome suspeito de segredo no output bruto, mas o contador/lista está quebrado silenciosamente há pelo menos o release v2.4.0 | pack-smoke pré-tag do release v2.4.0, sessão 2026-09-20 | S |
| A14 | **O `catch` em torno de `await deps.fetchLatest(...)` (`lib/update-check.cjs:166`) nunca é exercitado** — todos os mocks de `fetchLatest` usados nos testes resolvem (`null` ou uma versão), nenhum rejeita/lança. Como `fetchVersionFromUrl` é desenhado pra nunca rejeitar, esse catch é defesa em profundidade só relevante pra um `depsOverride` mal comportado — risco baixo, cobertura zero | Gate v2 tester pós-fix MAJOR update-notify (2026-09-20) | S |

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
