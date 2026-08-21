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
| GitHub Copilot CLI | `copilot` | Extensão in-process (SDK) | ✅ sim | todas as 4 |
| GitHub Copilot App | `copilot` | Extensão in-process (SDK) | ✅ sim | todas as 4 |
| Copilot CLI (repo) | `repo` | `PreToolUse` via `.github/hooks/hooks.json` | ✅ sim | todas as 4 |
| Claude Code | `claude` | `PreToolUse` via `~/.claude/settings.json` | ✅ sim | todas as 4 |
| Cursor (IDE) | `cursor` | `beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution` | ⚠️ parcial | blindRead, noisePath, shellDump |
| Cursor CLI (`cursor-agent`) | `cursor` | só `beforeShellExecution` | ⚠️ mínimo | shellDump |
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

### Por que o Cursor é parcial

O Cursor não tem evento genérico de "antes de qualquer ferramenta". Os eventos são
nomeados, e **não existe evento para grep/glob/busca semântica**. Logo, `broadScan` não tem
onde disparar. Não é limitação do adapter — é do harness. Se o Cursor adicionar o evento,
o adapter passa a cobrir sem mudança no núcleo.

No `cursor-agent` (CLI), hoje só `beforeShellExecution` e `afterShellExecution` são
entregues, mesmo que você declare os outros no `hooks.json`.

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
npx token-guard init --target copilot,cursor
```

Se um repositório tem `.github/hooks/hooks.json` (alvo `repo`) e a máquina tem a extensão
(alvo `copilot`), o veredito é avaliado duas vezes e é idêntico. Não há dupla penalidade
para o usuário, apenas um pouco de trabalho redundante.

## Configuração MCP por IDE

Depois de `npx token-guard init --target mcp`, o snippet fica em `~/.token-guard/mcp.json`.
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

## Adicionando um IDE novo

Veja [CONTRIBUTING.md](../CONTRIBUTING.md) › *Adicionando suporte a um novo IDE*. A regra
é sempre a mesma: o adapter traduz envelope, o núcleo decide.
