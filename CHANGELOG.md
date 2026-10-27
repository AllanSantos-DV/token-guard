# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [2.13.1] — 2026-10-27

### Corrigido
- **O aviso de versão nova linka o Pages do projeto.** Os avisos visíveis de atualização (SessionStart e `status`/`--version`) agora terminam com a página pública (`https://allansantos-dv.github.io/token-guard/`), pensada para leitor humano, e nunca com README ou blob do repositório. O texto e o mecanismo de atualização não mudaram. Teste em `test/auto-update.test.cjs` falha se o link contiver README ou `/blob/`.

## [2.13.0] — 2026-10-26

### Adicionado
- **Scout barato por construção, sem trocar o modelo (P1).** O frontmatter de `agents/scout.agent.md` ganhou `disallowedTools: Edit, Write, NotebookEdit` (somente leitura sem cortar o Bash nem as ferramentas MCP de busca), `maxTurns: 30` (a medição viu 5 a 13 chamadas) e `effort: medium` (não medido). Um hook `SubagentStart` (`adapters/subagent-start.cjs`, matcher `^scout# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento [SemVer](https://semver.org/lang/pt-BR/).

) injeta o bloco `subagente` do contrato no início da conversa do scout; acabou a cola manual de `contract --subagente`. Respeita `TOKEN_GUARD=off`, usa o contrato do repositório sobre o default e falha aberto. Teste: `test/subagent-start.test.cjs`.

### Corrigido
- **O scout nunca chegava à pasta que o Claude Code lê.** O instalador só o copiava para `~/.claude/token-guard/agents/`; o `scout` que a regra de rajada sugere não existia na lista de agentes. O alvo `claude` agora grava `~/.claude/agents/scout.agent.md`, atualiza o que é do token-guard (reconhecido pelo título) e preserva agente homônimo do usuário.

- **`token-guard status` mostra o scout.** Linha `scout:` diz se faltam o hook `SubagentStart` ou o agente em `~/.claude/agents` (`inspectScout`, `lib/daemon-status.cjs`).
- **Alvo `repo` grava o scout sem `disallowedTools`, `maxTurns` e `effort`**, campos que só o Claude Code entende (`.github/agents` é do Copilot).
- **A sugestão de scout (rajada de leituras) só sai se o agente existe** em `.claude/agents`, `.github/agents`, `~/.claude/agents` ou `~/.copilot/agents`.

### Decidido
- **`updatedInput` no lugar de `deny` (P4): não fazer.** Não há correção mecânica que preserve o sentido (faixa de `Read`, `| head`), a reescrita silenciosa esconde do modelo o que de fato rodou, e `updatedInput` de hooks paralelos tem ordem indefinida (o Smart Tool já reescreve buscas no Bash). Evidência em `docs/research/scout-barato-e-updatedinput-2026-10-26.md`.

## [2.12.3] — 2026-10-24

### Corrigido
- **O `dupRead` entregava ao subagente um stub que apontava para a conversa do pai (A35).** O subagente
  divide o `session_id` com o pai mas tem janela de contexto própria; o estado de releitura era chaveado
  por sessão, então o `Read` do scout (ou de um irmão em paralelo) voltava como
  `[dupRead] conteúdo idêntico… está acima na conversa` sem que aquela janela tivesse visto o arquivo
  (4 de 4 scouts da medição do P1). O hook traz `agent_id` quando a chamada é de um subagente
  (https://code.claude.com/docs/en/hooks); o estado de "o que esta janela já viu" (`dupRead` e a rajada do
  scout) passa a usar `sessionId~agent_id`. O contrato e a evidência seguem por sessão. A economia do
  agente principal não muda: a releitura idêntica ainda vira stub, e a releitura dentro da própria janela do
  subagente também. Teste `test/dupread-subagent.test.cjs` (hook de comando e daemon); 3 dos casos falham
  na 2.12.2.

## [2.12.2] — 2026-10-24

### Corrigido
- **`rg PADRÃO` e `grep -r PADRÃO` sem caminho passavam pelo `shellDump`.** Sem caminho a busca é a
  pasta atual, mas o guard tomava o último argumento por alvo, que nesse caso é o próprio padrão. Agora o
  alvo são os argumentos posicionais menos o padrão (o primeiro, salvo `-e`/`-f`), pulando o valor das flags
  que o levam (`-g`, `-t`, `-m`, `-A/-B/-C`, `--glob`…), com aspas respeitadas e parando em pipe, redirect e
  `&&`. Busca depois de um pipe filtra o stdin e segue liberada; `uniq` passou a contar como teto
  (`grep -rn x . | cut -d: -f1 | sort | uniq -c` agrega e é barato).
- Falsos positivos medidos no replay de 30.206 buscas reais de transcripts: 1 comando novo negado
  (`rg -n 'TOKEN'` sem caminho nem teto), nenhum liberado, nenhuma busca com caminho, glob ou pipe barrada.
  Oito fixtures de deny falhavam na 2.12.1; sete de allow passam nas duas. Método e números em
  `docs/research/scout-haiku-medicao-2026-10-24.md`.

### Documentação
- Medição do scout com `model: haiku` (4 perguntas × 2 modelos): haiku errou o ponto central em uma e
  o scout segue herdando o modelo da conversa. P2 e P3 do backlog descartados: o claude-code-boss já cobre
  a compactação a frio e o cache frio. Achado novo no backlog (A35): o `dupRead` devolve stub ao subagente
  por compartilhar o `sessionId` do pai.

## [2.12.1] — 2026-10-24

### Corrigido
- **`grep -rn "x" .` passava pelo `shellDump`.** Só `-r`, `-R` e `-re` isolados eram lidos como
  busca recursiva; flags curtas combinadas (`-rn`, `-nr`, `-rni`, `-Rn`) escapavam. Agora qualquer
  cluster de flags curtas que contenha `r` ou `R` conta (no grep `r` é só a recursão), e também
  `--recursive`/`--dereference-recursive`. A recusa sugere o comando certo
  (`grep -l -rn "x" . | head -50`, ou a mesma busca restrita a `src`) e ele passa pelo guard.
  Falsos positivos checados: `grep -rn "x" src/`, `grep -rn "x" . | head -50`, `grep -n "x" arquivo`,
  `grep -in foo a.txt b.txt` e `cat a.log | grep -c ERROR` continuam liberados. Testes em
  `selftest.cjs` (fixtures) e `test/refusal-teaches.test.cjs`; contra a 2.12.0 quatro casos falham.

## [2.12.0] — 2026-10-24

### Alterado
- **A recusa ensina o agente e nunca pergunta ao usuário.** O usuário sempre confirmava o
  `ask`, então perguntar não treinava ninguém; no Claude Code só o `deny` leva o motivo ao
  modelo, e no Codex o `ask` nem é suportado (o hook falha e a chamada segue sem guard).
  Fontes em `docs/research/refusal-hook-decisions-2026-10.md`.
  - `mode: "warn"` (config, `TOKEN_GUARD=warn`, `--mode warn`) foi aposentado e vale `block`.
    `--mode warn` grava `block` e avisa; `status` diz que o `warn` foi aposentado.
  - Nenhum arquivo de `lib/` ou `adapters/` emite `ask` (o Cursor também só recebe `deny`).
  - O cliente com `TOKEN_GUARD=warn` deixa de pular o daemon: só `off` o pula.
- **A recusa traz a reescrita concreta, com os argumentos do pedido.** Antes a correção era uma
  orientação ("filtre e limite"); agora é o comando ou a chamada pronta:
  - `shellDump`: o próprio comando refeito com filtro e teto (`ls -R` → `ls <dir> | head -50`,
    `find src` → `find src -name '*.ts' | head -50`, `gci -r` → `Get-ChildItem . -Recurse -Filter *.ts | Select-Object -First 50`,
    `tree` → `tree -L 2 .`, `rg --files`, `fd`, `dir /s`, `findstr /s`; busca por conteúdo → `grep -l ... | head -50`
    e a mesma busca restrita a `src`; `git ls-files` → `git ls-files src/`).
  - `blindRead`: a busca da linha e a leitura por faixa com o caminho do arquivo
    (`Grep ... path="<arquivo>"`, `Read file_path=... offset=<linha-20> limit=80`, e `sed`/`Get-Content`);
    para notebook, `jq` que acha a célula e a extrai.
  - `noisePath`: a correção segue a classe do diretório — dependência (`node_modules`, `vendor`…:
    buscar o uso no projeto, `npm view <pkg> readme`), controle de versão (`git log`, `git show`),
    logs e temporários (`tail -n 100`, `grep -n | tail`), artefato de build (`Glob "**/<nome>.*"`
    para achar a fonte); e a linha de `allowlist` já com o caminho relativo.
  - `broadScan`: a chamada `Glob`/`Grep` reescrita com o padrão do pedido.
- Teste `test/refusal-teaches.test.cjs`: toda recusa é `deny`, o texto é executável, o comando
  sugerido passa pelo próprio guard (a recusa que manda fazer o que ela mesma nega foi a
  classe de falso positivo nº 1) e nenhum caminho emite `ask`. Contra o código da 2.11.1 falha
  em 38 casos.

## [2.11.1] — 2026-10-23

### Corrigido
- **Documentação do `mcp-cost` afirmava um custo que o Claude Code não paga por padrão.**
  README, `docs/IDES.md`, o relatório do `mcp-cost` e o `--help` diziam que o schema das
  ferramentas MCP entra no preâmbulo "em toda sessão". No Claude Code as definições são
  adiadas por padrão: só nomes e instruções do servidor entram até o uso
  (https://code.claude.com/docs/en/costs e
  https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search, lidos em 2026-10-23). O
  schema inteiro volta com `ENABLE_TOOL_SEARCH=false`, em modelos anteriores ao Opus 4 e ao
  Sonnet 4 e em implantações Microsoft Foundry no Azure. O número medido continua certo — é
  o tamanho do schema —, mas deixa de ser apresentado como custo fixo de toda sessão.
  Teste em `test/mcp-cost.test.cjs`.

## [2.11.0] — 2026-10-23

### Adicionado
- **O contrato volta depois de compactar ou limpar (R6).** O contrato é injetado uma vez
  por sessão; `/compact` e `/clear` apagam o texto da janela, mas o estado seguia
  dizendo "já injetado" e as sessões longas ficavam sem ele. O `SessionStart` com
  `source` `compact` ou `clear` zera `injected` (`CT.resetInjected`) e o próximo prompt
  reinjeta a camada `sempre` e os gatilhos por evidência. No `resume` o histórico volta
  inteiro, então nada muda. Custo: ~185 tokens (742 caracteres) por compactação. Reusa o
  hook que já existe, sem registro novo. Teste: `test/contract-compaction.test.cjs`.
- **Aviso para cópia sem registro de instalação.** Uma cópia que não passou pelo `init` da
  2.8.0 em diante (instalada antes do auto-update, ou à mão) nunca consultava o npm e
  nunca avisava nada. Agora o `SessionStart` consulta e diz: "esta cópia não tem registro
  de instalação e não se atualiza sozinha — rode uma vez: npx -y …@X init --target claude".
- `test/images.test.cjs`: imagens (png, jpg, jpeg, gif, webp; 10, 45, 49 e 300 KB; quatro
  formatos de resposta do Read e de MCP) passam pelos hooks reais sem bloqueio nem alteração.
  Contra o código da 2.5.0 o teste falha em 65 de 100 casos.

### Corrigido
- **`TokenGuardDaemon` (logon) não era registrada sem elevação** (A30): `schtasks /sc onlogon`
  vale para todo usuário e exige admin. A task agora é criada por XML, só para o usuário
  atual e com `RunLevel` limitado — aceita sem elevação; o caminho antigo fica de reserva.
- **Flake de `test/daemon-singleton.test.cjs`** (A32): o relógio de 80 ms partia do spawn do
  filho e não do primeiro erro dele; com o cold start do node acima disso o bind dava certo e
  não havia erro para observar. Agora parte do primeiro erro visto pelo filho.

### Documentação
- `docs/research/token-economy-harness-2026-10.md`: mecanismos de harness para economizar
  tokens, com fonte e data de acesso. Ideias que mudam o uso estão no backlog (P1–P5).

## [2.10.1] — 2026-10-23

### Corrigido
- **Instalação não grava mais o caminho do node** — trocar o node de pasta deixava as tasks
  do daemon e a entrada do Codex apontando para um executável que sumiu, em silêncio.
  No Windows, as tasks `TokenGuardDaemon` e `TokenGuardDaemonWatch` chamam o launcher
  `adapters/run-daemon.cmd`, que acha o node ao disparar (PATH primeiro; locais conhecidos
  só se não achar; sem node em lugar nenhum, sai 1 com mensagem). O `config.toml` do Codex
  grava `node` puro (ou um local conhecido que exista, se o node não está no PATH). No macOS
  o plist usa `/usr/bin/env node` com PATH explícito; no Linux o `ExecStart` também.
  Reinstalar (ou o auto-update) repara entrada que ficou com caminho obsoleto.

## [2.10.0] — 2026-10-16

### Adicionado
- **`token-guard cost`** (A26): custo por sessão e por modelo a partir dos transcripts do
  Claude Code — chamadas, tokens, cache lido/escrito (5 min e 1 h), contexto máximo, US$
  estimado e fração acima de 200k. Deduplica o streaming por `message.id`+`requestId`,
  aceita `--since 7d|AAAA-MM-DD`, `--top N`, `--json`. Preço é premissa em `cost.prices`;
  modelo sem preço é listado e não entra na conta.
- **Releitura idêntica chega ao modelo** (A23): o stub do dupRead agora substitui o
  resultado do Read via `updatedToolOutput` (formato `{file:{content}}` do Claude Code),
  para leitura ≥ 2000 caracteres de arquivo inalterado. O registro é zerado em
  compactação/limpeza/retomada (`SessionStart`), e o stub ensina a reler com `offset/limit`.
- **Regra do scout** (A27): `limits.scoutBurst` (8) leituras/buscas seguidas sem edição
  geram UM aviso por rajada sugerindo o subagente `scout`. Desligável em `rules.scout`.
  Medido em 7 dias de transcripts: limiar 6 → 470 rajadas, 8 → 256, 10 → 157.
- **`token-guard status` mostra a saúde do daemon** (A25): IPC, porta http, token e se o
  `settings.json` aponta para a porta viva, com veredito em uma linha.
- **`mcp-cost` lê `~/.codex/config.toml`** (A24): tabelas `[mcp_servers.*]` do Codex.

### Corrigido
- **Daemon que cai no meio da sessão não voltava** (A29): no Windows, uma task agendada a
  cada 5 min (`TokenGuardDaemonWatch`) religa o daemon (singleton: se vivo, sai na hora);
  no macOS, `StartInterval` de 300 s; no Linux o `Restart=on-failure` já cobria. As tasks
  rodam via `conhost --headless`, sem piscar console.

## [2.9.0] — 2026-10-16

### Adicionado
- **Corte de saída de shell preserva as linhas de erro.** Para Bash/shell, o corte do
  `bigResult` passa de "72% começo + 28% fim" para início (37,5% do orçamento) + fim (25%) +
  linhas-sinal do trecho omitido (até 37,5%): `not ok`, `FAIL`, `ERROR`, `Error:`/`*Exception`,
  `Traceback`, `panic:`, `fatal:`, `Caused by:`, `error:`, `N failing`. Linha-sinal tem teto de
  300 caracteres; cada trecho omitido recebe marcador com a contagem, e o que não couber no
  orçamento é contado. Medido em 121 saídas de shell reais: 41 de 158 linhas-sinal mantidas
  (antes 14) gastando 608 mil caracteres (antes 968 mil, -37%). Read e MCP não mudam.
- **O corte agora vale de fato no Bash do Claude Code.** O `tool_response` do Bash é
  `{stdout,stderr,...}` e, até aqui, o Token Guard só gravava a cópia e avisava: o stdout
  inteiro entrava na janela (os 33 cortes de Bash medidos eram só aviso). O `PostToolUse`
  aceita `updatedToolOutput` nesse mesmo formato (documentação oficial do Claude Code,
  hooks, lida em 2026-10-16), então `stdout`/`stderr` acima do orçamento são cortados com a
  regra de linhas-sinal e o resto do objeto segue intacto.

### Corrigido
- **Screenshot MCP disparava `bigResult` pelo base64.** Bloco `{type:'image', data}` e
  `{source:{type:'base64', data}}` agora ficam fora da medida (como o `base64` do Read já
  ficava): o modelo recebe a imagem, não o texto.

## [2.8.2] — 2026-10-13

### Corrigido
- **Dois daemons subindo juntos sobre um socket órfão (POSIX).** O roubo do mutex de
  reclaim de dono morto lia, apagava e recriava o arquivo sem garantir que ainda era o
  mesmo: um processo atrasado apagava o mutex que outro acabara de recriar como vivo, e os
  dois seguiam para o `listen`. Medido em Linux (WSL): 4 em 400 corridas com dois
  vencedores; depois da correção, 0 em 800. O roubo agora é `rename` + releitura, e
  devolve o arquivo se não era o morto. Era também o teste instável
  `corrida de roubo de mutex morto` do CI no Linux.

## [2.8.1] — 2026-10-13

### Adicionado
- **Aviso visível de versão nova no npm.** O `SessionStart` mostra na tela (`systemMessage`)
  `token-guard X disponível no npm (você usa Y)`, lido do cache da checagem (sem rede no
  hook): diz se o auto-update está cuidando ou se é preciso atualizar à mão. Com
  `TOKEN_GUARD_AUTO_UPDATE=off` o processo oculto continua renovando o cache, então o aviso
  não some. O aviso de "atualizado automaticamente" (2.8.0) segue como estava.

## [2.8.0] — 2026-10-13

### Corrigido
- **Hook http do Claude Code preso num endpoint antigo.** A porta era gravada no
  `settings.json` no install, e o daemon subia por conta própria, sem fallback nem
  registro: com a porta ocupada, ou depois de atualizar à mão, o Claude Code ficava em
  conexão recusada (fail-open, ferramentas sem guard) sem aviso. Agora o daemon tenta
  a porta preferida, depois a última registrada, depois qualquer livre; grava onde subiu
  em `~/.token-guard/daemon-http.json` e reaponta só os hooks http do token-guard no
  `settings.json`, de forma atômica e só quando a porta mudou (o Claude Code relê hooks
  alterados sem reiniciar). O `SessionStart` confere com uma rota de health autenticada
  (`GET /token-guard/health`) e corrige um `settings.json` defasado.
- `TOKEN_GUARD_HTTP_PORT` ocupada: o hook http fica desligado com o motivo registrado e o
  `SessionStart` avisa na tela (`systemMessage`), em vez de seguir calado.

### Adicionado
- **Auto-update** (`lib/auto-update.cjs`). O `init` registra os alvos de máquina em
  `~/.token-guard/install-state.json`. A cada início de sessão do Claude Code, um processo
  oculto e destacado checa a versão (mesmo cache de 24 h do `status`) e, havendo nova,
  roda o instalador dela nos mesmos alvos: runtime, hooks e MCP saem atualizados juntos.
  O resultado (sucesso ou falha, com log e comando manual) aparece na sessão seguinte.
  Falha não se repete na mesma versão antes de 24 h. Desliga com
  `TOKEN_GUARD_AUTO_UPDATE=off`. Quem está na 2.7.0 ou anterior precisa atualizar uma
  vez à mão (`npx @allansantos-dev/token-guard@2.8.0 init --target <alvos>`).

## [2.7.0] — 2026-10-12

### Adicionado
- **Aviso de peso de contexto** (`lib/ctxwatch.cjs`, no `UserPromptSubmit`, hook http e de comando).
  Medição nos transcripts do dia: sessões acima de 200k tokens de contexto foram ~68% do
  gasto, porque cada chamada relê o contexto inteiro do cache. Ao cruzar 120k tokens (e a cada
  +60k) o usuário recebe um `systemMessage` com o tamanho e o custo de reler, sugerindo
  `/compact` ou `/clear`. Vai ao humano, não ao modelo: não custa token. Compactar rearma o
  aviso. Lê só o fim do transcript; sem transcript ou com erro, silêncio (fail-open).

## [2.6.2] — 2026-10-10

### Corrigido
- **Contrato: os gatilhos `codigo`/`teste`/`docs` voltam a disparar no Claude Code.** O
  arquivo tocado só era registrado quando o resultado era truncado, e a 2.3.0 tirou até
  esse registro. O daemon também não gravava. Na prática, só a camada `sempre` entrava.
  Agora o pós-execução grava a evidência em toda chamada com caminho, no hook http, no
  de comando e no plugin Copilot, com a mesma função (`noteTouched`, em `lib/contract.cjs`).
- `TOKEN_GUARD_DAEMON_IDLE_MS=0` desativa o autoencerramento do daemon, como o
  SECURITY.md promete. Antes, `0` caía no padrão de 10 min.
- `init --target codex` e `init --target mcp` respeitam `--mode`, gravando
  `~/.token-guard/token-guard.config.json`. Antes, a flag era ignorada nesses dois alvos.
- O CI passa a rodar `test/update-check.test.cjs`, que já estava no `npm test`.
- `plugin.json` estava parado na versão 2.2.0.

### Documentação
- Novo **[docs/COMO-FUNCIONA.md](docs/COMO-FUNCIONA.md)**: o caminho de uma chamada de
  ferramenta, da decisão ao resultado e ao contrato, em cada harness.
- README, INSTALL, IDES, CONFIG, CONTRACT, TROUBLESHOOTING, SECURITY e CONTRIBUTING
  conferidos contra o código:
  - Codex nos alvos, na desinstalação e no diagnóstico;
  - remoção do autostart do daemon;
  - chaves `rules.bigResult`, `rules.dupRead` e `limits.resultChars*`;
  - arquivos de estado (`results/`, `-touched`, `-reads`) e o que cada um guarda;
  - bigResult substituindo o resultado no Claude Code;
  - as 4 ferramentas MCP;
  - publicação pelo CI com provenance.
- README publica o replay real (371 sessões, 75.445 chamadas, 190 bloqueios) ao lado da
  simulação. Também declara o que o dedupe de leitura ainda **não** faz: o stub não
  chega ao modelo (backlog A23).

## [2.6.1] — 2026-10-09

### Corrigido
- `package.json`: `bin` normalizado (`cli.cjs`), o que encerra o aviso
  "script name cli.cjs was invalid and removed" do `npm publish` (o executável já
  funcionava; o aviso aparecia desde a 2.5.0). A descrição do pacote passa a citar o
  Codex e o hook http do Claude Code.

## [2.6.0] — 2026-10-08

### Adicionado
- **Claude Code sem processo por chamada (backlog A16).** O hook de comando abria um
  Node a cada evento — numa máquina com antivírus que inspeciona cada processo novo,
  ~500 ms por chamada, quase nada disso sendo o guard. O Claude Code aceita hook
  `type: "http"`: `init --target claude` agora registra PreToolUse, PostToolUse e
  UserPromptSubmit como POST para o daemon em `127.0.0.1` (porta estável por usuário,
  token em `~/.token-guard/daemon-http.token`, header `X-Token-Guard`). Mesma decisão,
  mesmo envelope — os dois caminhos montam a resposta em `lib/claude-hooks.cjs`.
  `--command-hooks` mantém o modo antigo (política que bloqueie hook http).
- **SessionStart sobe o daemon antes da primeira ferramenta (backlog A17).** Um processo
  por sessão deixa o daemon de pé, na versão certa e com HTTP ligado; a 1ª chamada não
  espera mais o bring-up (1,2-1,4 s medidos) e o hook http não cai em conexão recusada.
- **Codex CLI** (`init --target codex`): hook `PreToolUse` `type: "mcp_tool"` chamando a
  ferramenta nova `token_guard_hook` do servidor MCP do token-guard, que fica de pé na
  sessão — sem processo por chamada, mesma `decide()`. Registra
  `[mcp_servers.token-guard]` no `config.toml` (só essa tabela; o resto do arquivo fica
  byte a byte) e o hook no fim de `hooks.json` (sem deslocar a aprovação por índice dos
  hooks existentes). O hook precisa ser aprovado em `/hooks` no Codex.

### Corrigido
- **Falsos positivos achados no replay de 2026-10 (176 sessões, 59 mil chamadas reais)**,
  auditados um a um — 205 → 190 bloqueios, todos os restantes conferidos como legítimos:
  - **o guard negava o próprio conselho:** o bigResult manda ler o integral salvo em
    `.token-guard/results/`, e o noisePath barrava essa leitura (8 casos); o broadScan
    recomenda limitar glob "por nome (`**/*Service*`)" e negava esse padrão;
  - noisePath barrava a saída de tarefa que o Claude Code manda ler em `%TEMP%` quando a
    sessão roda na pasta do usuário (o próprio `Temp` casava com `temp`);
  - shellDump: `Get-ChildItem -Recurse -Filter`/`-Depth`, `| Where-Object`, `Select-String`
    dentro de `ForEach-Object { }`, predicados do `find` (`-newer`, `-mtime`, `-size`…),
    `git ls-files --others/-mo` (conjuntos de status) e `find arquivo.ext` contam como
    limitados; corpo de heredoc (mensagem de commit) e texto entre aspas deixaram de ser
    lidos como comando. E o teto passou a valer **por comando**: um redirect na linha
    anterior não libera mais um `ls -R` na seguinte.
- **`bench/daemon-bench.cjs` deixou de ser portão (backlog A19).** O AC2 passava em 5 de 18
  execuções sem mudança de código. Agora é medição de caracterização: os critérios
  aparecem como referência, a saída é sempre 0 e não grava baseline.
- **Lock de singleton podia travar o daemon fora para sempre (backlog A18).** Pid vivo no
  lock não prova daemon vivo — depois de kill/reboot o SO reusa pids. O lock virou pista:
  quem decide é o `listen()`. Locks de pid morto são varridos quando o daemon sobe
  (42 acumulados em `%TEMP%/token-guard-locks` nesta máquina caíram para 2).
- **blindRead: correção impossível para PDF e notebook, e faixa que driblava a
  regra** — PDF sem `pages` agora ensina `pages` (e não estima tokens por
  byte, já que PDF custa por página); o Read do Claude Code ignora
  `offset/limit` em `.ipynb`, então a faixa não libera mais notebook grande e
  a orientação passa a ser extrair as células.
- **bigResult media o que o modelo não recebe** — em Edit/Write o
  `tool_response` traz o arquivo original inteiro, e no Bash do Claude Code o
  `bashEditDiff` (diff de arquivos editados pelo comando, só interface) inflava
  a medida: cada edição de arquivo grande injetava um aviso falso e gravava uma
  cópia em disco. Ferramentas de escrita e `bashEditDiff` ficam fora.
- **bigResult (pós-execução) media payload binário e quebrava o formato do
  Copilot** — (1) Read de imagem no Claude Code: o base64 contava como texto,
  disparava um "Truncated" falso e gravava ~400 KB por leitura; agora `base64`
  fica fora da medida. (2) Copilot: `toolResult` é sempre `ToolResultObject`,
  e o stub devolvido não tinha `textResultForLlm`/`resultType` — todo resultado
  grande era substituído por um objeto inválido (e a imagem em
  `binaryResultsForLlm` se perdia); agora só o texto é medido e truncado, o
  resto do objeto é preservado. (3) Objeto que o harness não substitui (Bash do
  Claude Code) recebia "Truncated" sem ter sido truncado; a mensagem agora diz
  que a saída entrou inteira. (4) `.token-guard/results` crescia sem limite;
  agora guarda os 50 mais recentes.
- **Payload acima de 4 MB derrubava o cliente do daemon** — o frame IPC
  estourava, o cliente tentava subir o daemon 3x e desarmava (stderr de erro e
  3 spawns inúteis). Agora vai direto pro caminho local.
- Tabela de famílias de ferramenta duplicada em `postresult.cjs`/`dupread.cjs`
  (já divergente no regex de shell) passa a vir de `rules.cjs`.
- **blindRead barrava leitura de imagem e de PDF com `pages`** — o Read do
  Claude Code entrega imagem ao modelo como imagem (sem linhas; custo segue a
  resolução, não os bytes), então uma PNG acima de 50 KB era negada com uma
  correção impossível ("releia uma faixa de linhas"). `.png/.jpg/.jpeg/.gif/.webp`
  agora ficam fora da regra (SVG é texto e continua nela). `hasReadRange`
  passou a reconhecer `pages` ("1-5") como faixa, então PDF grande lido por
  páginas não é mais negado.
- **Windows: named pipe órfão podia derrubar o daemon novo pra sempre** — o
  retry de reclaim de socket órfão em `adapters/daemon-server.cjs` só rodava
  em POSIX; no Windows, `EADDRINUSE` sem lock-record correspondente caía
  direto em desistência, sem tentar de novo na janela entre o processo antigo
  morrer e o kernel liberar o handle do named pipe. Adicionado retry-com-backoff
  específico de win32 (3 tentativas, 50ms).
- **`handleMessage()` tratava `id: 0` como requisição sem id** — `!msg.id` é
  `true` pra `id: 0` em JS, então a resposta era silenciosamente descartada.
  Corrigido para `msg.id === undefined || msg.id === null`.
- **`SEMVER_RE`/`compareVersions` (`lib/update-check.cjs`) não seguiam a
  precedência oficial do semver.org** — zero à esquerda em identificadores
  numéricos era aceito, e sufixos de pre-release/build eram ignorados na
  comparação (uma versão `X.Y.Z-beta.1` publicada como `latest` não
  disparava aviso). Ambos corrigidos para o algoritmo/regex oficiais.
- **`REAL_DEPS.readCache` aceitava `checkedAt: Infinity`**, fazendo o cache
  de aviso de atualização nunca expirar. Corrigido com `Number.isFinite`.

### Testes
- Cobertura E2E nova para `TOKEN_GUARD=off`/`warn` ponta a ponta com um
  daemon real de pé (`test/daemon-adapters-parity.test.cjs`).
- Regressão live win32 pro retry de named pipe órfão
  (`test/daemon-singleton.test.cjs`, gated à plataforma).
- `id: 0` como RPC id válido (`test/daemon-server.test.cjs`).
- Precedência de pre-release/build, rejeição de zero à esquerda,
  `writeCache` contra diretório pai inexistente, e `fetchLatest` rejeitando
  (`test/update-check.test.cjs`).
- `stdio` explícito em `test/daemon-singleton.test.cjs` para evitar ruído de
  stderr do filho vazando pro log de CI.

## [2.5.0] — 2026-09-22

Auditoria documentação-vs-código do repositório inteiro: nada de comportamento
mudou, o que mudou é o que o projeto afirma sobre si mesmo — mais o isolamento
das suítes de teste e dois benches que passaram a medir com dispersão em vez de
publicar uma constante.

### Corrigido
- **Documentação que divergia do código:**
  - `README.md` — o alcance da `allowlist` (vale nas regras que julgam caminho,
    `noisePath` e `blindRead`; não alcança `broadScan`/`shellDump`), a afirmação
    de que existia escopo "por sessão" (não existe: é por máquina ou por repo),
    as tabelas de `lib/` e `adapters/` que ignoravam metade dos módulos, e a
    seção de latência inteira (ver abaixo). `docs/CONFIG.md` recebeu o mesmo
    recorte da `allowlist`.
  - `SECURITY.md` — o daemon residente não estava documentado (endpoint por
    named pipe/socket, `chmod 700` no POSIX, sem porta TCP, autoencerramento por
    ociosidade, script de verificação da ACL); "O que grava" não listava
    `~/.token-guard/update-check.json` nem os locks de singleton; a checagem de
    versão no registry npm ganhou seção própria — o que sai, o que não sai, como
    desligar — e o bullet de "não existe telemetria" deixou de ser absoluto.
  - `CONTRIBUTING.md` — a árvore de arquitetura omitia 8 módulos de `lib/` e 3
    adapters.
  - `docs/PLAN-daemon-unico.md` — `status` seguia `PLANNED` com F1-F7 entregues
    (backlog A7); o baseline do §1 era de Node v24.14.1 e virou nota explícita de
    re-medição em v25.8.1; a decisão D8 ("sem idle-timeout") contradizia o código,
    que tem 10 min de ociosidade — a reversão e o motivo agora estão na própria
    linha D8.
- **A entrada da 2.3.0 afirmou que o custo medido do cold-start "some" com o
  daemon.** Vale para a decisão, não para o evento: no modo comando o harness
  continua fazendo `spawn(node)` a cada chamada, e é o spawn — não a lógica — que
  domina (479-589 ms medidos contra 370-452 ms de piso do próprio Node nesta
  máquina — em duas janelas de medição, o que o guard acrescenta sobre o piso
  ficou entre 27 e 219 ms, dentro da variação da própria máquina). O daemon tira
  a decisão do caminho quente (0,9-3,9 ms servidos por IPC) e troca N processos
  por um residente; ganho ponta a ponta exige um cliente que não nasça um
  processo Node novo (backlog A16). O README publica os quatro caminhos medidos,
  em faixa, e diz o que cada um significa.
- **`bench/daemon-bench.cjs` media uma rodada e tratava o resultado como
  veredito.** Cada execução agora mede três rodadas, cada uma contra um daemon
  recém-nascido, julga a mediana entre rodadas e reporta a dispersão crua em
  `rounds`. Reaproveitar o mesmo daemon entre rodadas inflava o pico de RSS
  (68,8 MB acumulados contra 63,3 MB por burst), o que mediria outra coisa que
  não o critério AC3. Consequência medida e registrada em A19: o limite da
  mediana de AC2 (<50 ms) não é reproduzível nesta máquina — 18 execuções sem
  mudança de código deram 25-117 ms de mediana (passa em 5, reprova em 13) e
  41-259 ms de p95 (passa em 17); AC1 e AC3 passaram em todas. Enquanto o limite
  não for recalibrado, o repositório não passa a versionar baseline para o Node em
  uso (v25): `--smoke` roda sem guarda de regressão em vez de comparar contra a
  execução mais sortuda.

### Adicionado
- **Quarto caminho em `bench/latency.cjs`: "hook a frio"** — derruba o daemon
  antes de cada iteração e mede o bring-up que só a primeira chamada da sessão
  paga (1 173-1 444 ms nesta máquina, contra 479-589 ms com o daemon de pé;
  backlog A17).
  O bench também passou a usar um `TOKEN_GUARD_SID` próprio: antes conversava com
  o daemon de trabalho do usuário e podia subir um por conta.
- **Isolamento de teste obrigatório** — `test/bootstrap.cjs` (HOME/USERPROFILE
  redirecionados para um tmpdir vazio, `TOKEN_GUARD_SID` próprio, `TOKEN_GUARD`
  removido do env) passou a ser carregado pelas 20 suítes que tocam
  `decide()`/hooks; sem o SID próprio, redirecionar só o HOME deixava os testes
  falando com o daemon vivo do desenvolvedor. `test/postresult`, `test/dupread` e
  `test/adapters.post` estavam órfãs — existiam no disco e nunca rodavam em
  `npm test` — e entraram na cadeia; `selftest.cjs` passou a usar `FX.cleanup()`.
- **6 checks em `test/daemon-server.test.cjs`** (19 → 25): o RPC `stats`
  (pid, RSS, uptime, contadores de cache) e a invalidação do cache do daemon
  quando a config global é criada ou editada. Provados não-vacuosos: remover
  `configFilesInEffect(root)` de `ruleSetHash` derruba exatamente esses dois
  últimos.
- **Backlog A16, A17, A18 e A19** — cliente que não seja um processo Node novo;
  bring-up bloqueante na primeira chamada; lock-record que acredita em
  `isAlive(pid)` e nunca é limpo quando o daemon morre por `kill`/reboot; limite
  da mediana de AC2 a recalibrar contra distribuição medida, hoje reprovando sem
  regressão e fixando a baseline versionada na execução mais sortuda.

## [2.4.0] — 2026-09-20

### Adicionado
- **Aviso opt-out de nova versão publicada no npm** — `token-guard status` e
  `token-guard --version` agora checam, sob demanda (nunca em background, nunca
  nos hooks/daemon), se há uma versão mais nova publicada no registry npm.
  Consulta no máximo 1x por dia (cache em `~/.token-guard/update-check.json`,
  TTL 24h); qualquer falha de rede ou disco é best-effort e silenciosa, nunca
  quebra o comando. Desligue com `TOKEN_GUARD_UPDATE_CHECK=off`. Ver
  `docs/PLAN-update-notify.md`.

## [2.3.2] — 2026-09-19

### Corrigido
- **Teste win32 do autostart do daemon (F7) não exercitava o ramo win32 fora
  do Windows** — `test/install.test.cjs` checava strings de saída específicas
  do dry-run win32 (`TOKEN_GUARD_SID=`, task `ONLOGON`) sem forçar a
  plataforma via `TOKEN_GUARD_FORCE_PLATFORM` (seam já usado pelos testes
  POSIX vizinhos, `install.cjs:264`). Em `ubuntu-latest` o ramo win32 de
  `install.cjs` nunca rodava, e as asserções falhavam silenciosamente por
  ausência das strings esperadas. Corrigido adicionando
  `TOKEN_GUARD_FORCE_PLATFORM: 'win32'` à chamada de `runInstall()` do teste.
  Achado no gate de CI do release 2.3.1 (falhava em `ubuntu-latest`, todas as
  versões de Node; Windows mascarava por rodar o ramo win32 de verdade).

## [2.3.1] — 2026-09-19

### Corrigido
- **Escape hatch `TOKEN_GUARD=warn` não se propagava pelo daemon** — com o
  daemon de pé, o RPC `check` seguia pro daemon mesmo com `TOKEN_GUARD=warn`
  setado no processo chamador; o daemon calcula `cfg` com o próprio env (sem
  `warn`) e devolvia `deny` em vez de `ask`, quebrando silenciosamente o modo
  de aviso pro mesmo motivo já corrigido pro `off` em 2.3.0 (`lib/daemon-client.cjs:29-32`).
  `hasTokenGuardEnvOverride()` agora corta ANTES de conectar no daemon pra
  `off`/`0`/`false`/`warn`, igual já fazia só pra `off`. Achado no gate de CI
  do release 2.3.0 (falhava em `ubuntu-latest`, todas as versões de Node;
  Windows mascarava por não reproduzir o cenário de daemon-de-pé no teste).

## [2.3.0] — 2026-09-19

**Daemon-único**: os três hooks do Claude Code (`hook-cmd`, `prompt-hook`,
`post-hook`) passam a falar, por padrão, com um daemon persistente por
usuário em vez de subir um processo Node novo a cada chamada — o custo
medido do cold-start (53 ms/263 ms/409 ms por hook) some. Fallback pro
caminho efêmero de sempre é automático e byte-idêntico sempre que o daemon
não está de pé, falha, ou está desligado via `TOKEN_GUARD=off`.

### Adicionado
- **Transporte IPC** (`lib/ipc-frame.cjs`) — framing length-prefixed sobre
  named pipe (Windows) / unix socket (POSIX), teto anti-DoS de 4 MB/frame.
- **Daemon server** (`adapters/daemon-server.cjs`) — serve `check` (paridade
  com `decide()`), `contract` (paridade com o fluxo de `prompt-hook.cjs`) e
  `postprocess` (paridade com `post-hook.cjs`), com cache invalidado por
  `ruleSetHash` e fail-open espelhando o comportamento síncrono existente.
- **Thin clients** (`lib/daemon-client.cjs`) — os 3 hooks tentam o daemon
  primeiro; qualquer falha (timeout, ECONNREFUSED, frame corrompido) cai no
  caminho local de sempre, sem diferença observável de stdout.
- **Lifecycle/singleton** (`lib/daemon-lifecycle.cjs`) — garantia real de
  singleton via `EADDRINUSE` do SO; lock-record como pré-checagem; reclaim
  de mutex de dono morto em POSIX (best-effort, gap conhecido no Windows —
  `docs/BACKLOG.md` A4).
- **Fault tolerance** — start-on-demand, self-heal e disarm-K (desiste de
  tentar o daemon após K falhas consecutivas na mesma sessão, evitando
  timeout repetido) em `lib/daemon-client.cjs`.
- **Benchmark numérico** (`bench/daemon-bench.cjs`, `npm run bench:daemon`)
  — prova as 3 métricas de aceite sobre o daemon REAL (não mock): latência
  isolada 1,24 ms (≤5ms), burst de 60 req mediana 35,8 ms/p95 58,8 ms
  (<50ms/≤150ms), pico de RSS 55,6 MB (≤70MB).
- **Autostart** (`install.cjs`, alvo `claude`) — Windows via Task Scheduler
  (`ONLOGON`) + `setx TOKEN_GUARD_SID` (fecha o gap de descoberta
  cliente↔daemon por PID); POSIX via `systemd --user` (Linux) / `launchd`
  (macOS). Idempotente, respeita `--dry-run`.

### Notas de migração
- Nenhuma ação necessária — o caminho efêmero continua sendo o fallback
  automático e permanente.
- No Windows, o daemon só fica "quente" entre chamadas depois de um novo
  logon/sessão (necessário para `TOKEN_GUARD_SID` valer); até lá, sobe
  on-demand a cada hook (mesmo custo de hoje, sem regressão).
- `TOKEN_GUARD=off` desliga o daemon E o caminho local — comportamento
  inalterado.

Detalhes completos: `docs/REQUEST-daemon-unico.md`, `docs/PLAN-daemon-unico.md`.

## [2.2.0] — 2026-08-23

Economia de SAÍDA, contrato com evidência real, replay sobre sessões reais e o
backlog de hardening zerado (16 itens → 13+4 fechados, só monitoramento restante
— mapa em `docs/BACKLOG.md`).

### Adicionado (rodada 2 — fechar tudo antes de lançar)
- **Replay de transcripts REAIS** (`bench/replay-transcripts.cjs`): percorre os
  JSONL de sessões passadas do Claude Code e roda o decide() atual sobre cada
  chamada histórica. Na máquina do autor: 65 sessões, 8.197 chamadas → 28 denies
  legítimos, ~437k tokens líquidos estimados — e a auditoria dos suspeitos
  expôs duas classes de falso positivo que nenhuma suíte pegava (abaixo).
- **bigResult substitui de verdade também no Claude Code**: v2.1.121 estendeu
  `updatedToolOutput` para todas as ferramentas; o post-hook emite o stub como
  substituição (versões antigas: orientação, nunca bloqueio).
- **Cursor ganha broadScan de volta**: o Cursor passou a expor `preToolUse`
  genérico com matcher por tipo de ferramenta — adapter traduz o evento e o
  instalador registra; todas as 4 regras disparam nas versões recentes.

### Adicionado (rodada 1)
- **Regra `bigResult` (pós-execução)** — `lib/postresult.cjs` + adapter
  PostToolUse: resultado de ferramenta acima de ~25k caracteres vira stub com
  preview (cabeça+cauda), versão integral gravada em `.token-guard/results/`
  e a alternativa barata da família pronta para reexecutar. No modo plugin do
  Copilot a substituição é REAL (`modifiedResult` do SDK); no Claude Code o
  hook de comando orienta (`additionalContext`) — diferença documentada em
  docs/IDES.md. Fail-open absoluto (objeto circular, root impossível → passa
  intacto).
- **Injeção automática do contrato** — adapter UserPromptSubmit fecha o
  circuito que estava aberto; e agora com **evidência real**: o PostToolUse
  acumula os arquivos tocados da sessão (dedupe, teto 50) e as seções
  `quando:codigo/teste/docs` entram conforme o tipo de trabalho. No modo
  plugin do Copilot, `onUserPromptSubmitted` injeta pelo mesmo estado.
- **mcp-cost acionável** — seção RECOMENDAÇÕES: servidores >1,5k tok de schema
  recebem sugestão de corte/slim; ferramentas >500 tok, de encurtar descrição.
  Recomendação condicional ao uso real; servidor que falhou nunca recebe
  recomendação inventada. E `--extra-files a.json,b.json` traz configs fora dos
  locais conhecidos (Zed, JetBrains, frotas próprias) para o inventário.
- **Skill token-economy v2** — levers externos validados por pesquisa:
  compaction, model routing, cache-friendly habits, CLI>MCP, slimming de MCP,
  sub-agentes — com fontes.
- `docs/BACKLOG.md`: melhorias óbvias fora de escopo ficam anotadas (origem +
  esforço) e são atacadas quando o escopo corrente fecha — política do dono,
  espelhada no Brain.
- Teste EPIPE (`test/epipe.test.cjs`): stdout destruído com o filho vivo —
  exit 0, zero stack trace. CI ganhou Node 16 na matriz (engines >=16 passou a
  ser testada de fato); `npm test` roda as dez suítes.

### Corrigido
- **Re-gate da rodada de features (reviewer + tester independentes), 7 achados**:
  - knobs novos fora de `DEFAULTS.limits` burlavam o `sanitize()`: config lixo
    (`"resultCharsWithoutTrim": "abc"` → NaN) truncava TODA saída de ferramenta.
    Chaves registradas nos defaults + validação local em `lib/postresult.cjs`;
  - `cfg` sem `limits` desligava bigResult silenciosamente (TypeError engolido
    pelo fail-open) — defaults locais resolvem, e o teste que passava pelo
    motivo errado foi reescrito;
  - registro VIVO em layout antigo coexistia com o novo (dois guards por
    evento para sempre) → substituído com aviso (`layout antigo substituído`);
  - matcher drift congelado para sempre em quem já tinha instalado → matcher
    atualizado automaticamente quando difere do atual;
  - dedup de PostToolUse/UserPromptSubmit olhava só `hooks[0]` (duplicava
    canônico escondido após hook forasteiro) → `reconcile()` único com flatMap;
  - flag de "obsoleto reparado" vazava entre eventos (mensagens mentirosas)
    → estado por evento;
  - EPIPE derrubava os hooks novos via evento de stream; e prompt-hook
    persistia estado ANTES de emitir (entrega falha = contrato perdido na
    sessão) → handler de erro + emitir antes de persistir;
  - colisão de session-id sanitizado (`sess/1` ≡ `sess:1`) suprimia injeção
    entre sessões distintas → sufixo sha1 do id original quando sanitizado.
- Backlog P1: `writeJson` do instalador atômico (temp + rename — crash não
  trunca mais o settings.json do usuário); matcher drift também no alvo `repo`;
  `CFG.load` memoizado (TTL 2s, env na chave) para o modo plugin deixar de
  re-walk a árvore a cada evento.
- `renderAdvice`: recomendações além da 8ª aparecem como "+N restantes";
  `renderText` tolera `charsPerToken` ausente/zero (via API programática).
- Identidade de sessão sem id do harness deriva da raiz (hash), em vez de um
  `'sem-sessao'` global que misturava estado entre repositórios.
- Removido `debug.log` esquecido na raiz.

### Corrigido (rodada 2 — achados do replay real)
- **noisePath barrava leituras legítimas FORA do workspace** (scratchpads e
  outputs de tarefa do próprio harness em `%TEMP%\claude\…`): o ancestral
  `Temp` casava com a lista de ruído quando o caminho escapava da raiz. Caminho
  fora do workspace não é ruído — é contexto escolhido. No replay real isso
  eram 69 denies injustos numa máquina só; agora são zero.
- `git ls-files docs/plans/` escopado era negado como dump inteiro; agora segue
  a mesma regra da busca por conteúdo: caminho explícito = barato, sem caminho
  = árvore inteira (barrado).

## [2.1.0] — 2026-08-22

Revisão completa pós-gate adversarial: revisor + tester independentes sem contexto
de autor, com achados confirmados por execução antes de cada correção (RED → GREEN).

### Corrigido

**Núcleo de decisão**
- `shellDump` bloqueava qualquer comando contendo a palavra "tree" — inclusive
  `git commit -m "fix tree view"` e `node scripts/tree.js`. Padrões agora estão
  ancorados na posição de comando (início ou pós-pipe).
- `shellDump` não conhecia as ferramentas padrão do agente moderno: `rg --files`,
  `rg <padrão> .`, `fd`, `gci -r` e `dir -Recurse` passavam. Agora são barrados
  como os equivalentes antigos (`ls -R`, `find .`). Busca de conteúdo via shell
  (`grep`/`rg`) passou a ser julgada por **escopo**, igual à regra broadScan:
  alvo explícito fora da raiz é barato.
- `blindRead` resolvia caminho relativo contra o cwd **do processo do hook**
  em vez do cwd declarado no payload: o guard silenciava quando os dois
  divergiam, e podia negar arquivo pequeno citando o tamanho de outro. Resolvido
  contra a raiz do workspace.
- `noisePath` era case-sensitive enquanto o allowlist era case-insensitive:
  `Node_Modules` burlava o guard em Windows/macOS. O casamento segue a caixa
  do filesystem da plataforma — e passa a julgar ruído **relativo à raiz do
  workspace**, corrigindo também repositórios clonados sob ancestral chamado
  `build`/`dist`/`temp`, que ficavam 100% bloqueados.
- `broadScan` negava `**/*.{ts,tsx}` — o mesmo padrão que o texto do próprio
  deny recomenda como alternativa (loop de nega). Grupo de chaves agora conta
  como filtro de extensão.
- Teto de resultado em string (`head_limit: "50"`) era ignorado; agora conta.
- Payload malformado (`toolInput` não-objeto) produzia deny absurdo com padrão
  vazio; fail-open cobre envelopes insuficientes. Listagem de diretório único
  (`list_directory {path}`) não é mais tratada como glob irrestrito.
- `offset: 0` sem `limit` contava como "faixa de linhas" e burlava blindRead;
  só número > 0 delimita leitura.
- `decide()` ganhou fail-open absoluto: payload hostil (getter que lança) não
  derruba nem bloqueia.
- Config com tipo inválido em uma chave (`noiseDirs: 42`, `limits: null`)
  descartava a config inteira ou desligava uma regra em silêncio; sanitização
  por chave restaura defaults individuais.

**Configuração global**
- O loader só lia `~/.copilot/token-guard.config.json`, mas o instalador grava
  config global também em `~/.claude/`, `~/.cursor/` e `~/.token-guard/` —
  `init --target claude --mode warn` rodava como `block` silenciosamente.
  O fallback agora lê os quatro homes, na ordem fixa; a config do repositório
  sempre vence.

**Instalador**
- Reinstalar clobberava `agents/scout.agent.md` e `skills/token-economy/SKILL.md`
  personalizados pelo usuário nos alvos copilot/claude/cursor/mcp (só o alvo
  `repo` preservava). Assets de usuário agora são preservados em todos os alvos;
  só `--force` atualiza.
- Registro de hook apontando para script inexistente era reportado como
  "já registrado" e nunca reparado — após um upgrade que mudasse layout, o guard
  ficava desligado em silêncio. Registro obsoleto agora é removido e reinstalado,
  com aviso explícito.
- O runtime instalado não incluía `mcp-cost.cjs`, `contract.cjs` nem
  `contract.default.md`, mas o `cli.cjs` instalado roteava para eles: os comandos
  `mcp-cost` e `contract` quebravam em qualquer cópia instalada.

**CLI/CI**
- `token-guard contract` lia `cfg.limits.charsPerToken` (campo não existe);
  o custo em tokens ignorava `charsPerToken` customizado.
- CI não rodava `test/mcp-cost.test.cjs` nem `test/contract.test.cjs`.
- (Rodada 2 do re-gate) Prefixo de atribuição de ambiente (`FOO=1 tree`,
  `A=1 B=2 find src`) burlava os padrões ancorados na posição de comando;
  `find /var/log` escapava porque a exclusão de switch do `find.exe` barrava
  qualquer alvo começando com `/`. Ambos corrigidos e cobertos por teste.

### Adicionado
- **A promessa central, medida**: `bench/savings.cjs` simula sessões inteiras
  (perfis de agente, truncamento real de tool result em ~25 k tokens, custo dos
  próprios denies contado) rodando o `decide()` real sobre movimentos caros
  canônicos — e `test/savings.test.cjs` trava o resultado: economia líquida
  positiva nos três perfis, zero escapes canônicos, overhead <2% do evitado e
  ponto de equilíbrio em ~94% de falsos positivos. Documentada na nova seção
  "A economia, medida" do README.
- **Contrato de saída documentado**: `lib/contract.cjs` + CLI `contract` +
  `contract.default.md` existiam sem nenhuma menção na documentação. Novos
  [docs/CONTRACT.md](docs/CONTRACT.md) e seção no README — incluindo o estado
  honesto: biblioteca e inspeção estáveis, adapter de injeção automática ainda
  pendente.
- `test/install.test.cjs`: casos de integração do instalador contra o FS real,
  com home falso (idempotência, reparo, preservação, loader × homes).
- `bench/latency.cjs`: os números de latência do README viraram medição
  reprodutível na máquina de quem lê.
- [docs/CONFIG.md](docs/CONFIG.md): referência de toda chave (incluindo a convenção
  `$comment*` e os valores extras de `TOKEN_GUARD`) e o estado em disco.
- [SECURITY.md](SECURITY.md): o que executa, o que lê, o que grava.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
- Suíte de regressão do gate adversarial embutida no selftest (21 casos novos).

### Alterado
- README deixa de publicar constantes de latência de máquina específica como se
  fossem universais; aponta o bench.

## [2.0.0] — 2026-08-21

### Adicionado
- **Camada `adapters/`**: o núcleo de decisão passa a ser compartilhado por quatro
  integrações distintas, sem duplicar regra de negócio.
- **Adapter Cursor** (`adapters/cursor-hook.cjs`): traduz `beforeReadFile`,
  `beforeShellExecution` e `beforeMCPExecution` para o contrato `{ permission }` do Cursor.
- **Adapter MCP** (`adapters/mcp-server.cjs`): MCP server stdio, zero dependências,
  expondo `token_audit`, `token_guard_status` e `token_guard_check`. Fallback universal
  para IDEs sem hook pré-ferramenta (VS Code, Windsurf, Zed, JetBrains).
- **Adapter Claude Code**: instalação em `~/.claude/settings.json` via `PreToolUse`,
  reaproveitando o hook de comando existente.
- **Instalador multi-alvo**: `install.cjs --target copilot|claude|cursor|mcp|repo|all`.
- **Medidor de preâmbulo MCP** (`lib/mcp-cost.cjs`, `mcp-cost.cjs`): mede quanto os
  servidores MCP declarados custam de contexto **antes da primeira pergunta**, por
  handshake real (`initialize` → `notifications/initialized` → `tools/list`).
  `--list` inventaria sem executar nada; sem ele, os servidores declarados
  **são executados**. Só mede: não instala, não desinstala, não mexe em config.
- `test/adapters.test.cjs` (23 casos) e `test/mcp-cost.test.cjs` (34 casos).
- CI em GitHub Actions: Linux + Windows × Node 18/20/22.
- `docs/IDES.md` com a matriz de cobertura real por IDE.

### Alterado
- `extension.mjs` e `token-guard.cjs` viraram shims finos sobre `adapters/`.
- `cli.cjs` ganhou `--target`, os comandos `mcp` e `contract`.

### Mantido
- Núcleo (`lib/`) inalterado: mesma decisão, mesmas quatro regras.
- Fail-open em qualquer erro.
- `TOKEN_GUARD=off` / `TOKEN_GUARD=warn` como escape hatch sem editar arquivo.

## [1.0.0]

- Versão inicial: hook `PreToolUse` para Copilot CLI, extensão in-process,
  auditoria de custo de contexto e as quatro regras.
