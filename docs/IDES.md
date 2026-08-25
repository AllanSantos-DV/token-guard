# Cobertura real por IDE

Este documento é deliberadamente honesto sobre onde o token-guard **bloqueia** e onde ele
apenas **orienta**. A diferença importa: prometer enforcement onde o harness não permite
seria vender fumaça.

## Por que a cobertura varia

O token-guard só consegue barrar uma chamada cara se o harness disparar um evento **antes**
de executar a ferramenta e aceitar um veredito de volta. Alguns IDEs expõem isso de forma
completa, outros parcialmente, outros não expõem.

O núcleo (`lib/`) é o mesmo em todos. O que muda é o quanto dele consegue rodar.

## Matriz

| IDE / Harness | Alvo | Mecanismo | Bloqueia? | Regras que disparam |
|---|---|---|---|---|
| GitHub Copilot CLI | `copilot` | Extensão in-process (SDK) | ✅ sim | todas as 4 + bigResult real |
| GitHub Copilot App | `copilot` | Extensão in-process (SDK) | ✅ sim | todas as 4 + bigResult real |
| Copilot CLI (repo) | `repo` | `PreToolUse` via `.github/hooks/hooks.json` | ✅ sim | todas as 4 |
| Claude Code | `claude` | `PreToolUse` via `~/.claude/settings.json` | ✅ sim | todas as 4 |
| Claude Code (saída) | `claude` | `PostToolUse` `updatedToolOutput` (v2.1.121+) | ✅ substitui | bigResult real |
| Cursor (IDE) | `cursor` | `preToolUse` genérico (recente) + os 3 nomeados | ✅ sim | **todas as 4** |
| Cursor CLI (`cursor-agent`) | `cursor` | subset dos eventos | ⚠️ mínimo | shellDump (+ o que o CLI entregar) |
| VS Code Copilot Chat | `mcp` | MCP server | ❌ não | orientação via `token_guard_check` |
| Windsurf | `mcp` | MCP server | ❌ não | orientação via `token_guard_check` |
| Zed | `mcp` | MCP server | ❌ não | orientação via `token_guard_check` |
| JetBrains (AI Assistant / Junie) | `mcp` | MCP server | ❌ não | orientação via `token_guard_check` |
| Claude Desktop | `mcp` | MCP server | ❌ não | orientação via `token_guard_check` |

### As quatro regras

| Regra | O que barra |
|---|---|
| `broadScan` | varredura sem escopo (`glob **/*`, grep sem filtro nem teto) |
| `blindRead` | leitura de arquivo grande sem faixa de linhas |
| `noisePath` | acesso a `node_modules`, `target`, `dist`, `.git` e afins |
| `shellDump` | comando de shell que despeja árvore (`ls -R`, `Get-ChildItem -Recurse` sem limite) |

### A quinta regra é pós-execução

`bigResult` não barra a chamada — ela age DEPOIS, quando um resultado legítimo
se revela gigante (>~25k caracteres): trunca com preview, salva a versão
integral em `.token-guard/results/` e devolve a alternativa barata da família.
A força varia por harness:

| Harness | bigResult | Mecanismo |
|---|---|---|
| Copilot CLI/App (plugin) | ✅ substitui de verdade | `onPostToolUse` › `modifiedResult` — o corpo inteiro nunca entra na janela |
| Claude Code | ⚠️ orienta | hook de comando não altera o resultado já lido; entrega o caminho do integral + a dica (o agente aprende a limitar a próxima) |

Fonte externa que motivou a regra: outputs de ferramenta são apontados como o
maior custo escondido de sessões agentivas; a Context Editing API da Anthropic
(`clear_tool_uses`) é a versão server-side da mesma ideia (−84% em eval deles).

### Cursor: cobertura completa nas versões recentes

O Cursor passou a expor `preToolUse` genérico (matcher por tipo de ferramenta:
Shell, Read, Write, Grep, Task, MCP:…). O adapter traduz o evento e o instalador
o registra junto dos três nomeados — **todas as 4 regras disparam** nas versões
recentes do IDE. Versões antigas sem `preToolUse` continuam cobertas pelos
eventos nomeados (blindRead, noisePath, shellDump).

No `cursor-agent` (CLI), a entrega continua reduzida (só shell) — limitação do
harness, não deste adapter.

### Por que o MCP não bloqueia

MCP é um protocolo de **oferta de ferramentas**, não de interceptação. O agente chama o
que quiser, quando quiser. O que o `token-guard` faz via MCP:

1. expõe `token_guard_check` — o agente consulta antes de fazer uma chamada cara e recebe
   a alternativa barata pronta;
2. expõe `token_audit` — o agente mede o repositório antes de explorá-lo;
3. instala a skill `token-economy`, que ensina o procedimento.

É economia por orientação. Funciona bem com modelos que seguem instrução, mas não é
garantia. **Onde houver hook nativo, use o hook.**

## Combinando alvos

Os alvos coexistem sem conflito — a decisão é a mesma função em `lib/decide.cjs`. Se você
usa Copilot e Cursor na mesma máquina:

```bash
npx @allansantos-dev/token-guard init --target copilot,cursor
```

Se um repositório tem `.github/hooks/hooks.json` (alvo `repo`) e a máquina tem a extensão
(alvo `copilot`), o veredito é avaliado duas vezes e é idêntico. Não há dupla penalidade
para o usuário, apenas um pouco de trabalho redundante.

## Configuração MCP por IDE

Depois de `npx @allansantos-dev/token-guard init --target mcp`, o snippet fica em `~/.token-guard/mcp.json`.
Cole no arquivo correspondente:

| IDE | Arquivo |
|---|---|
| VS Code | `.vscode/mcp.json` (projeto) ou config de usuário |
| Cursor | `~/.cursor/mcp.json` |
| Claude Desktop | `claude_desktop_config.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Zed | `settings.json` › `context_servers` |
| JetBrains | Settings › Tools › AI Assistant › MCP |

O formato do snippet:

```json
{
  "mcpServers": {
    "token-guard": {
      "command": "node",
      "args": ["<caminho>/.token-guard/runtime/adapters/mcp-server.cjs"]
    }
  }
}
```

Alguns IDEs usam `servers` em vez de `mcpServers`, ou pedem `type: "stdio"`. Ajuste a
chave externa; `command` e `args` são iguais em todos.

### Quanto os seus servidores MCP já custam

Cada servidor declarado nesses arquivos carrega o schema de todas as suas ferramentas no
preâmbulo de toda sessão, independentemente de uso. Para ver o número:

```bash
npx @allansantos-dev/token-guard mcp-cost --list   # inventário — nada é executado
npx @allansantos-dev/token-guard mcp-cost          # medição real, por handshake
```

Os arquivos varridos pelo medidor são os declarados em: `~/.claude.json`,
`~/.claude/settings.json`, `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`,
`claude_desktop_config.json` (Windows e macOS), `~/.token-guard/mcp.json`, mais
`.vscode/mcp.json` e `.cursor/mcp.json` do projeto atual. Zed (`context_servers`) e
JetBrains **não** são varridos — declare-os via `extraFiles` se usar a API. Um servidor
declarado em duas IDEs conta uma vez.

## Adicionando um IDE novo

Veja [CONTRIBUTING.md](../CONTRIBUTING.md) › *Adicionando suporte a um novo IDE*. A regra
é sempre a mesma: o adapter traduz envelope, o núcleo decide.
