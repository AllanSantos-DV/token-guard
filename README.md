# token-guard

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
| `lib/config.cjs` | Config subindo a árvore, com fallback global e escape hatch por env. |
| `lib/audit.cjs` | A medição de custo de contexto. |

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
| `agents/scout.agent.md` | Sub-agente de investigação com contexto descartável. |
| `skills/token-economy/SKILL.md` | O procedimento, em divulgação progressiva. |
| `cli.cjs` | `init`, `audit`, `status`, `mcp`, `test` — a porta de entrada do `npx`. |
| `install.cjs` | Instala em 5 alvos, com **merge** seguro de todo arquivo de config. |
| `selftest.cjs` | 27 casos contra o hook real, nos formatos de payload de 4 runtimes. |
| `test/adapters.test.cjs` | 23 casos cobrindo a tradução dos adapters Cursor e MCP. |

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
npx token-guard test      # 27 casos contra o hook real
npx token-guard status    # confira a configuração ativa
```

Reinicie a sessão do agente para carregar o hook.

**Trabalha em repositório do cliente?** Use só alvos de máquina (`copilot`, `claude`,
`cursor`, `mcp`): nada é escrito dentro do repositório, tudo vai para o seu perfil.

O instalador **nunca sobrescreve** um `hooks.json`, um `settings.json`, um
`token-guard.config.json`, um agente ou uma skill que já existam — ele preserva e faz
merge. Rodar de novo é idempotente.

Detalhes em [docs/INSTALL.md](docs/INSTALL.md).

### O que fica no repositório (alvo `repo`)

```
.github/
  hooks/hooks.json                    ← merge: suas entradas + token-guard
  token-guard/
    token-guard.cjs                   ← o hook (shim → adapters/hook-cmd.cjs)
    token-audit.cjs                   ← o medidor
    selftest.cjs                      ← a bateria de testes
    adapters/{copilot-cli.mjs,hook-cmd,cursor-hook,mcp-server}.cjs
    lib/{payload,config,rules,decide,audit}.cjs
  agents/scout.agent.md
  skills/token-economy/SKILL.md
token-guard.config.json               ← ajustes deste repositório
.token-guard/                         ← cache (entra no .gitignore)
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

### Custo de latência (medido, não estimado)

Um kit de eficiência precisa declarar o próprio custo. Nesta máquina
(Windows corporativo, Node 25, antivírus ativo), mediana de execuções reais:

| Modo | Por chamada de ferramenta |
|---|---|
| Plugin (in-process) | **0,153 ms** |
| Hook de comando (spawn) | **330 ms** |
| | **2150× de diferença** |

A leitura importa: **quase todo o custo do modo comando é do runtime, não do guard.**
`node -e "0"` custa 216 ms nesta máquina e abrir um único `.cjs` vazio custa 299 ms
(antivírus escaneando). A lógica das quatro regras custa 0,15 ms — o que o modo
plugin expõe ao eliminar o processo.

Duas defesas, nesta ordem:

1. **Use o modo plugin** quando o alcance de máquina servir. O custo desaparece.
2. **No modo repositório**, o `matcher` do `hooks.json` impede o processo de nascer
   para ferramentas que nunca seriam barradas (`edit`, `create`, PR, issue). Com ele,
   supondo ~40% das chamadas nas famílias vigiadas, o custo fica em torno de
   **5 segundos por sessão**. Sem ele, ~12 s.

> Em máquina sem antivírus corporativo, ou em Linux/macOS, o piso do spawn costuma
> ser bem menor. Meça o seu: 330 ms é desta máquina, não uma constante universal.

---

- **Extensão `.cjs` em todos os arquivos**, de propósito: `.js` viraria ESM num repo com
  `"type": "module"` e o hook quebraria. `.cjs` é CommonJS sempre.
- **Payload lido por cascata**, cobrindo quatro runtimes:
  `toolCall.toolName/input` (VS Code Chat) · `tool_name/tool_input` (Claude Code CLI) ·
  `toolName/toolInput` (legado) · `toolName/toolArgs/workingDirectory` (extensão in-process).
- **Nunca faz spawn de `process.execPath`.** Dentro de um harness empacotado esse caminho
  aponta para o binário do harness, não para o Node — por isso a auditoria é uma
  biblioteca (`lib/audit.cjs`) que a extensão chama in-process.
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
node selftest.cjs              # 27 casos — o núcleo, contra o hook real
node test/adapters.test.cjs    # 23 casos — a tradução dos adapters
```

**Núcleo (27):** os quatro guards nos três formatos de payload, os caminhos que **devem**
passar (o mais importante: falso positivo é pior que falso negativo aqui) e os escape hatches.

**Adapters (23):** a tradução de envelope do Cursor e o protocolo JSON-RPC do MCP —
incluindo fail-open sob entrada corrompida, que é onde um guard mal escrito derruba a sessão.

Ambos saem com código 1 se qualquer caso falhar. O CI roda os dois em Linux e Windows,
sobre Node 18, 20 e 22.

---

## Licença

MIT. Use, copie, modifique e distribua à vontade.
