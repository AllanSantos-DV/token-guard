# token-guard

**[Site &raquo;](https://allansantos-dv.github.io/token-guard/)** &middot; com medidor interativo de janela de contexto, n&uacute;meros medidos e matriz de cobertura.

**Economia de contexto para agentes de IA — agnóstico de IDE, como configuração versionada, não como produto.**

Um kit portátil que qualquer pessoa instala em qualquer repositório, em qualquer IDE.
Sem plugin proprietário, sem marketplace, sem servidor, sem licença, sem dependência npm.
Só Node stdlib e arquivos de texto que entram no seu git.

Funciona em **Copilot CLI/App, Claude Code, Cursor** e — via MCP — em qualquer IDE que
fale o protocolo (VS Code, Windsurf, Zed, JetBrains).
A cobertura varia por harness e está documentada sem maquiagem em [docs/IDES.md](docs/IDES.md).

---

## O problema, em um número

Rode isto num repositório grande de verdade:

```bash
node token-audit.cjs /caminho/do/repo
```

Você vai descobrir, entre outras coisas, quanto custa **só a lista de nomes dos arquivos** —
antes de o agente ler uma única linha de código. Em monorepos, essa listagem sozinha
costuma valer dezenas de janelas de contexto.

A janela é fixa. O repositório não. Portanto **a seleção do que entra é a arquitetura** —
e é exatamente ela que este kit governa.

---

## O que vem na caixa

### Núcleo — não conhece nenhum IDE

| Peça | O que faz |
|---|---|
| `lib/decide.cjs` | A decisão, compartilhada por **todos** os adapters — para que nunca divirjam. |
| `lib/payload.cjs` | Leitor de payload agnóstico: normaliza o envelope de 4+ runtimes. |
| `lib/rules.cjs` | As quatro regras: `broadScan`, `blindRead`, `noisePath`, `shellDump`. |
| `lib/config.cjs` | Config subindo a árvore, com fallback global (4 homes) e escape hatch por env. |
| `lib/audit.cjs` | A medição de custo de contexto. |
| `lib/mcp-cost.cjs` | A medição do preâmbulo MCP: quanto os servidores declarados custam por sessão — com recomendações acionáveis por servidor e ferramenta. |
| `lib/contract.cjs` | O contrato de saída: regras por gatilho de evidência, injetadas 1×/sessão via UserPromptSubmit ([docs](docs/CONTRACT.md)). |
| `lib/postresult.cjs` | A regra `bigResult`: resultado de ferramenta gigante vira stub + versão integral em disco + alternativa barata. |

### Adapters — só tradução de envelope, zero regra de negócio

| Adapter | Harness | Bloqueia? |
|---|---|---|
| `adapters/copilot-cli.mjs` | Copilot CLI / Copilot App (in-process, ~0,15 ms) | ✅ |
| `adapters/hook-cmd.cjs` | Copilot CLI (`hooks.json`) e Claude Code (`settings.json`) | ✅ |
| `adapters/cursor-hook.cjs` | Cursor — `beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution` | ⚠️ parcial |
| `adapters/mcp-server.cjs` | Qualquer IDE com MCP — VS Code, Windsurf, Zed, JetBrains | ❌ só orienta |

### Ferramentas e procedimento

| Peça | O que faz |
|---|---|
| `token-audit.cjs` | Mede o custo de contexto de qualquer repositório e grava o cache que calibra os guards. |
| `mcp-cost.cjs` | Mede o custo fixo de preâmbulo dos servidores MCP declarados, por handshake real. |
| `agents/scout.agent.md` | Sub-agente de investigação com contexto descartável. |
| `skills/token-economy/SKILL.md` | O procedimento, em divulgação progressiva. |
| `cli.cjs` | `init`, `audit`, `status`, `mcp`, `mcp-cost`, `contract`, `test` — a porta de entrada do `npx`. |
| `install.cjs` | Instala em 5 alvos, com **merge** seguro de todo arquivo de config. |
| `selftest.cjs` | o núcleo contra o hook real, nos formatos de payload dos runtimes. |
| `test/adapters.test.cjs` | tradução dos adapters Cursor e MCP. |
| `test/mcp-cost.test.cjs` | handshake, descoberta e diagnóstico do medidor de MCP. |
| `test/contract.test.cjs` | parsing, evidência e estado do contrato. |
| `test/install.test.cjs` | integração do instalador: idempotência, reparo de registro obsoleto e preservação de assets. |
| `test/savings.test.cjs` | a promessa central travada: economia líquida > 0. |
| `test/postresult.test.cjs` | a regra bigResult (truncar sem perder o destino). |
| `test/adapters.post.test.cjs` / `test/adapters.prompt.test.cjs` | os hooks PostToolUse e UserPromptSubmit ponta a ponta. |

Cada suíte imprime a própria contagem — não confie em números copiados daqui.

---

## Instalação

```bash
# 1. veja o tamanho do problema antes de instalar qualquer coisa
npx token-guard audit

# 2. instale onde você trabalha, começando sem atrito
npx token-guard init --target all --mode warn

# 3. confirme que responde neste ambiente
npx token-guard test
```

Alvos disponíveis:

```bash
npx token-guard init --target copilot   # Copilot CLI / App    (bloqueia)
npx token-guard init --target claude    # Claude Code          (bloqueia)
npx token-guard init --target cursor    # Cursor               (bloqueia parcial)
npx token-guard init --target mcp       # VS Code, Windsurf…   (só orienta)
npx token-guard init --target repo      # .github/ do repo     (viaja no git)
npx token-guard init --target all       # tudo que é de máquina
```

Depois:

```bash
npx token-guard audit     # veja o tamanho do problema neste repo
npx token-guard test      # todas as suítes
npx token-guard status    # confira a configuração ativa
```

Reinicie a sessão do agente para carregar o hook.

**Trabalha em repositório do cliente?** Use só alvos de máquina (`copilot`, `claude`,
`cursor`, `mcp`): nada é escrito dentro do repositório, tudo vai para o seu perfil.

O instalador **nunca sobrescreve** um `hooks.json`, um `settings.json`, um
`token-guard.config.json`, um agente ou uma skill que já existam — ele preserva e faz
merge. Rodar de novo é idempotente. Exceção honesta: um registro de hook apontando
para script que **não existe mais** (layout de versão antiga) é reparado, não
mascarado — deixar no lugar seria guard desligado em silêncio.

Detalhes em [docs/INSTALL.md](docs/INSTALL.md).

### O que fica no repositório (alvo `repo`)

```
.github/
  hooks/hooks.json                    ← merge: suas entradas + token-guard
  token-guard/
    token-guard.cjs                   ← o hook (shim → adapters/hook-cmd.cjs)
    token-audit.cjs                   ← o medidor
    selftest.cjs                      ← a bateria de testes
    cli.cjs                           ← init/audit/status/mcp-cost/contract/test
    adapters/{copilot-cli.mjs, hook-cmd.cjs, cursor-hook.cjs, mcp-server.cjs}
    lib/{payload,config,rules,decide,audit,mcp-cost,contract}.cjs
  agents/scout.agent.md
  skills/token-economy/SKILL.md
token-guard.config.json               ← ajustes deste repositório
.token-guard/                         ← cache e estado de sessão (entra no .gitignore)
```

Tudo isso é versionado. **Quem clonar o repositório herda a economia** — não há
máquina para configurar, nem passo manual de onboarding.

---

## A regra de ouro: nunca um deny cego

Todo bloqueio devolve ao agente a **alternativa barata, pronta para reexecutar**.
Um guard que só diz "não" transfere o problema para a pessoa; um guard que ensina
resolve o problema e treina o agente ao mesmo tempo.

Exemplo real de bloqueio:

```
token-guard/broadScan: the pattern "**/*" is unbounded in both breadth and type,
so it returns the path of about 215.112 files. A bare file listing is pure overhead:
it answers "what exists", never "where is the thing I need".
DO THIS INSTEAD: bound it on at least one axis — (a) by type: "**/*.java";
(b) by directory: pass paths=["src/main/java"]; (c) by name: "**/*Service*.java".
To find code by meaning rather than by filename, search content instead of listing paths.
(PT-BR) ...
```

O agente lê isso, corrige e segue. Não há intervenção humana no meio.

---

## As quatro regras

| Regra | Barra | Libera |
|---|---|---|
| **broadScan** | `glob "**/*"` sem escopo; busca em modo conteúdo sem teto nem filtro | `**/*.java`, `src/**`, `paths:["src"]`, `head_limit`, modo `files_with_matches` |
| **blindRead** | Ler arquivo > 50 KB sem faixa de linhas | Qualquer leitura com `view_range` / `offset+limit`; arquivos pequenos |
| **noisePath** | Caminhos em `node_modules`, `target`, `dist`, `.git`, `venv`, `.mcp-memory`… | Qualquer caminho na `allowlist` |
| **shellDump** | `Get-ChildItem -Recurse`, `ls -R`, `dir /s`, `find .`, `tree`, `grep -r` sem limite | Os mesmos comandos com filtro (`-name`) ou teto (`\| head -50`, `\| Select-Object -First 50`) |

### Por que não barramos toda busca ampla

O custo de uma busca não é a varredura — é a **saída**. Um `grep` em todo o repositório
que devolve três linhas é barato e é frequentemente o movimento certo. Por isso
`files_with_matches` passa sempre, e só o modo conteúdo *sem teto e sem filtro* é barrado.

Repositórios com menos de 400 arquivos ficam livres dos guards de varredura:
abaixo disso o custo é irrelevante e a disciplina só atrapalha.

---

## Configuração

`token-guard.config.json` na raiz do repositório. Tudo é opcional.

```json
{
  "mode": "block",
  "rules": { "noisePath": true, "blindRead": true, "broadScan": true, "shellDump": true },
  "limits": { "readBytesWithoutRange": 51200, "minRepoFilesForScanGuard": 400 },
  "noiseDirsExtra": ["generated", "protos-out"],
  "allowlist": ["node_modules/@minha-lib/types"]
}
```

- `mode`: `block` (nega e corrige) · `warn` (pede confirmação mostrando a correção) · `off`
- `noiseDirsExtra` / `sourceExtExtra` **somam** aos defaults.
  Use `noiseDirs` / `sourceExt` (sem `Extra`) só para substituir a lista inteira.
- `allowlist`: substrings de caminho sempre liberadas.

### Escape hatches

| Situação | Como sair |
|---|---|
| Emergência pontual | `TOKEN_GUARD=off` no ambiente |
| Testar sem atrito | `TOKEN_GUARD=warn` |
| Uma regra não serve a este repo | `"rules": { "shellDump": false }` |
| Um caminho específico é legítimo | `"allowlist": ["..."]` |

Um guard sem saída de emergência vira dívida. Estas quatro existem de propósito.

---

## O outro custo: o preâmbulo MCP

A auditoria mede o que o agente **lê durante** a sessão. Ela não vê o que já estava
carregado **antes da primeira pergunta**: o schema de cada ferramenta de cada servidor MCP
declarado. Esse custo é fixo, silencioso e pago em toda sessão, use você a ferramenta ou não.

```bash
npx token-guard mcp-cost --list      # só inventaria: nada é executado
npx token-guard mcp-cost             # mede de verdade, por handshake
```

Não há como estimar isso de fora: o tamanho do schema só existe depois que o servidor
responde `tools/list`. Então o medidor faz o handshake real do protocolo —
`initialize` → `notifications/initialized` → `tools/list` — sobre stdio, e conta os
caracteres do que voltou. **Isso significa que os servidores declarados são executados.**
Use `--list` quando quiser apenas o inventário.

Uma medição real, nesta máquina:

```
7 declarados · 4 sondados · 3 sem resposta

GitHub          26 ferram.   3.957 tok
Playwright      33 ferram.   3.454 tok
firebase-mcp    12 ferram.   1.883 tok
token-guard      3 ferram.     400 tok

74 ferramentas em 4 servidores ≈ 9.695 tokens = 0,048 janela(s), em toda sessão
```

Servidores que não respondem aparecem numa seção própria, com o motivo — eles continuam
custando janela, só não sabemos quanto. Transporte HTTP não é sondável por stdio e é
declarado como tal, em vez de ser contado como zero.

| Flag | Efeito |
|---|---|
| `--list` | Inventaria sem executar nada. |
| `--server NOME` | Mede um servidor só. |
| `--timeout MS` | Teto por handshake (padrão 15000). |
| `--json` | Dados crus. |

O medidor **só mede**. Não instala, não desinstala, não desliga servidor nenhum — a decisão
de cortar uma ferramenta é sua, e depende de quanto você a usa.

---

## A economia, medida (e a limitação dela)

A promessa central tem número próprio — e premissas declaradas:

```bash
node bench/savings.cjs        # simulação da economia líquida por sessão
node test/savings.test.cjs    # a promessa travada: se virar 0, a suíte falha
```

No repositório de referência (~215 mil arquivos), com truncamento real de
tool result (~25 k tokens) e o custo dos próprios denies contado na conta,
a simulação de sessões mostra **economia líquida de ~85–205 k tokens por sessão**
(0,4–1 janela de contexto), conforme o agente aprenda rápido ou repita o erro.
O overhead das mensagens de deny é ruído (<2% do evitado). Em repos pequenos o
kit não atrapalha por design. O ponto de equilíbrio é alto: os guards só deixam
de valer se **~94% dos bloqueios forem falsos positivos**.

Limitação honesta: é simulação paramétrica ancorada em tamanhos medidos com
sequência sintética de chamadas — não replay de transcripts vivos. Os três
números que sustentam as premissas são medidos por este mesmo kit:
`token-audit` (tamanho do repo), `mcp-cost` (preâmbulo) e o bench acima.

---

## Escopo, ciclo de vida e custo

**Não existe escopo "por sessão".** Não há daemon do guard, versão residente nem
estado entre sessões. Há dois modos de execução, e a diferença é de política:

| | **Máquina** (`--target copilot\|claude\|cursor\|mcp`) | **Repositório** (`--target repo`) |
|---|---|---|
| Onde | `~/.copilot/`, `~/.claude/`, `~/.cursor/`, `~/.token-guard/` | `.github/` do repo |
| Alcance | Todos os repos **desta máquina** | Só este repo, **mas viaja no git** |
| Quem herda | só você | **quem clonar** |
| Execução | in-process (Copilot) ou comando (Claude/Cursor) | comando por chamada |
| Custo por chamada | **0,15 ms** in-process · **330 ms** por comando | **330 ms** |
| Extras | expõe `token_audit` e `token_guard_status` ao agente | — |
| Repositório do cliente | ✅ nada é commitado | ❌ exige commit |

Os modos podem coexistir: todos importam a mesma decisão de `lib/decide.cjs`, então
o veredito é idêntico — apenas avaliado duas vezes. Para o dia a dia, escolha um.

### Custo de latência (meça na sua máquina)

Um kit de eficiência precisa declarar o próprio custo. O README não publica
constantes: publique a SUA medição.

```bash
node bench/latency.cjs        # plugin vs hook de comando vs piso do Node
```

Na máquina do autor (Windows corporativo, Node 25, antivírus ativo) a mediana
foi **0,153 ms** in-process contra **330 ms** por spawn — quase todo o custo do
modo comando é o runtime (`node -e "0"` custava 216 ms ali), não o guard. Em
máquina sem antivírus corporativo os dois números caem juntos; a razão entre
eles permanece. Duas defesas, nesta ordem:

1. **Use o modo plugin** quando o alcance de máquina servir. O custo desaparece.
2. **No modo repositório**, o `matcher` do `hooks.json` impede o processo de nascer
   para ferramentas que nunca seriam barradas (`edit`, `create`, PR, issue). Com ele,
   supondo ~40% das chamadas nas famílias vigiadas, o custo fica em torno de
   **5 segundos por sessão**. Sem ele, ~12 s.

---

- **Extensão `.cjs` em todos os arquivos**, de propósito: `.js` viraria ESM num repo com
  `"type": "module"` e o hook quebraria. `.cjs` é CommonJS sempre.
- **Payload lido por cascata**, cobrindo quatro runtimes:
  `toolCall.toolName/input` (VS Code Chat) · `tool_name/tool_input` (Claude Code CLI) ·
  `toolName/toolInput` (legado) · `toolName/toolArgs/workingDirectory` (extensão in-process).
- **Nunca faz spawn de `process.execPath`.** Dentro de um harness empacotado esse caminho
  aponta para o binário do harness, não para o Node — por isso a auditoria é uma
  biblioteca (`lib/audit.cjs`) que a extensão chama in-process.
- **`package-lock.json` é artefato de desenvolvimento** (integridade do repositório);
  em runtime o kit não tem dependência nenhuma para instalar. O import do SDK no
  adapter Copilot (`@github/copilot-sdk`) é provido pelo próprio host na hora em
  que a extensão carrega — nunca via npm deste pacote.
- **Ferramentas casadas por família**, não por nome exato:
  `view`/`read_file`/`Read`, `grep`/`grep_search`/`Grep`, `glob`/`file_search`/`Glob`,
  `bash`/`powershell`/`run_in_terminal`. Harness novo costuma cair numa família existente.
- **Falha sempre para o lado seguro.** Regra quebrada, payload inválido, stdin ausente,
  config corrompido: tudo resulta em liberar. Um guard de economia jamais pode
  derrubar a sessão que deveria baratear.

---

## Adoção sugerida

| Quando | O quê | Esforço |
|---|---|---|
| Dia 1 | `token-guard init --target all --mode warn` + rodar a auditoria | nenhum |
| Semana 1 | Ler os avisos que apareceram, ajustar `allowlist` e `noiseDirsExtra` | baixo |
| Semana 2 | Virar para `"mode": "block"` | nenhum |
| Contínuo | Rodar a auditoria a cada release e acompanhar a tendência | baixo |

Comece medindo. Sem o número de antes, não há como provar o de depois.

---

## Testes

```bash
npm test                          # todas as suítes
node selftest.cjs                 # o núcleo, contra o hook real
node test/adapters.test.cjs       # a tradução dos adapters
node test/mcp-cost.test.cjs       # o medidor de preâmbulo MCP
node test/contract.test.cjs       # o contrato de saída
node test/install.test.cjs        # o instalador contra o FS real
node test/savings.test.cjs        # a economia líquida travada
npm run test:hooks                # bigResult + UserPromptSubmit ponta a ponta
```

Cada suíte imprime a própria contagem e sai com código 1 se qualquer caso falhar.
O CI roda todas em Linux e Windows sobre Node 18, 20 e 22 — mais a simulação de
instalação (`--dry-run`) e a auditoria do próprio repositório.

**Núcleo:** os quatro guards nos três formatos de payload (mais o envelope do SDK
in-process), os caminhos que **devem** passar (o mais importante: falso positivo é
pior que falso negativo aqui) e os escape hatches. Inclui as regressões do gate
adversarial: dumps modernos (`rg --files`, `fd`, `gci -r`), falsos positivos de
palavra solta (`tree` num commit), casing de filesystem e resolução de caminho
relativo contra o cwd do payload.

**Adapters:** a tradução de envelope do Cursor e o protocolo JSON-RPC do MCP —
incluindo fail-open sob entrada corrompida, que é onde um guard mal escrito derruba a sessão.

**MCP cost:** o handshake contra servidores stdio sintéticos — servidor que loga texto
puro no stdout, que devolve erro JSON-RPC, que morre no boot, e que responde mas **nunca
encerra** (medido no timeout, não descartado). Mais a descoberta sem executar nada e o
diagnóstico: o motivo relatado tem que ser a causa, não o rodapé de versão do Node.

**Contrato:** parsing por seção, evidência acumulada, estado por sessão no disco,
poda por TTL e id de sessão que não escapa do diretório.

**Instalação:** idempotência real, reparo de registro apontando para script morto
e preservação de agente/skill personalizados.

---

## Contrato de saída

A economia tem dois lados. Os guards cuidam da **entrada**; o contrato cuida da
**saída**: regras de forma (`contract.default.md`) divididas por gatilho de
evidência — `sempre`, `quando: codigo` quando a sessão tocou código-fonte,
`quando: teste`, `quando: docs` — mais um bloco `subagente` para contexto descartável.

Um `contract.md` na raiz substitui seções inteiras do padrão. Inspecione com:

```bash
npx token-guard contract                          # seções, custo e ordem
npx token-guard contract --touched src/a.ts       # simula a evidência da sessão
npx token-guard contract --subagente              # bloco pronto p/ colar no scout
```

Estado honesto: a biblioteca (`lib/contract.cjs`) e o CLI de inspeção são estáveis;
o adapter que injeta automaticamente a cada turno ainda não existe — hoje o consumo
é manual (`--subagente` no prompt do scout). Detalhes em [docs/CONTRACT.md](docs/CONTRACT.md).

---

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Instalação, desinstalação completa, repositórios de cliente |
| [docs/IDES.md](docs/IDES.md) | Cobertura real por IDE/harness, sem maquiagem |
| [docs/CONFIG.md](docs/CONFIG.md) | Referência de toda chave de config + estado em disco |
| [docs/CONTRACT.md](docs/CONTRACT.md) | O contrato de saída, mecanismo e status |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Guard silencioso, config ignorada, diagnósticos |
| [SECURITY.md](SECURITY.md) | O que executa, o que lê, o que grava — dados e privacidade |

---

## Licença

MIT. Use, copie, modifique e distribua à vontade.
