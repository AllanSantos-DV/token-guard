# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/).
Versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [Não lançado]

### Adicionado
- `docs/BACKLOG.md`: melhorias óbvias encontradas fora de escopo ficam
  anotadas (com origem e esforço estimado) e são atacadas quando o escopo
  corrente fecha — política do dono, espelhada no Brain.
- **Regra `bigResult` (pós-execução)** — `lib/postresult.cjs` + adapter
  PostToolUse: resultado de ferramenta acima de ~25k caracteres vira stub com
  preview (cabeça+cauda), versão integral gravada em `.token-guard/results/`
  e a alternativa barata da família pronta para reexecutar. No modo plugin do
  Copilot a substituição é REAL (`modifiedResult` do SDK); no Claude Code o
  hook de comando orienta (`additionalContext`) — diferença documentada em
  docs/IDES.md. Fail-open absoluto (objeto circular, root impossível → passa
  intacto).
- **Injeção automática do contrato** — adapter UserPromptSubmit fecha o
  circuito que estava aberto: a camada "sempre" do contrato entra 1× por
  sessão, direto no contexto, com estado em `.token-guard/sessions/`.
  Limitação declarada: gatilhos por evidência ainda sem injeção automática.
- **mcp-cost acionável** — o relatório ganhou seção RECOMENDAÇÕES: servidores
  >1,5k tok de schema recebem sugestão de corte/slim; ferramentas >500 tok,
  sugestão de encurtar descrição. Toda recomendação é condicional ao uso real
  (o medidor não vê uso); servidor que falhou não recebe recomendação inventada.
- **Skill token-economy v2** — levers externos validados por pesquisa:
  compaction, model routing, cache-friendly habits, CLI>MCP, slimming de MCP,
  sub-agentes — com fontes.
- Suítes novas: `test/postresult.test.cjs` (11), `test/adapters.post.test.cjs`
  (8), `test/adapters.prompt.test.cjs` (9) — `npm test` roda as nove; CI idem.

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
- `test/install.test.cjs`: 9 casos de integração do instalador contra o FS real,
  com home falso (idempotência, reparo, preservação, loader × homes).
- `bench/latency.cjs`: os números de latência do README viraram medição
  reprodutível na máquina de quem lê.
- [docs/CONFIG.md](docs/CONFIG.md): referência de toda chave (incluindo a convenção
  `$comment*` e os valores extras de `TOKEN_GUARD`) e o estado em disco.
- [SECURITY.md](SECURITY.md): o que executa, o que lê, o que grava.
- [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).
- Suíte de regressão do gate adversarial embutida no selftest (21 casos novos).

### Alterado
- `npm test` roda as cinco suítes; CI idem (Linux+Windows × Node 18/20/22),
  mais simulação de instalação e auditoria do próprio repo.
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
- `test/contract.test.cjs` (42 casos) sobre `lib/contract.cjs`.
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
