# Instalação

## Pré-requisito

Node.js 16+. Nada mais — o projeto é zero-dependency de propósito, para rodar em máquina
corporativa sem `npm install`.

## Instalação rápida

```bash
# 1. veja o tamanho do problema antes de instalar qualquer coisa
npx token-guard audit

# 2. instale em tudo que é de máquina, começando sem atrito
npx token-guard init --target all --mode warn

# 3. confirme que responde neste ambiente
npx token-guard test
```

Depois de uma semana em `warn`, vire para `block`:

```bash
npx token-guard init --target all --mode block --force
```

## Escolhendo o alvo

| Situação | Alvo |
|---|---|
| Quero economia em todos os meus repositórios, nesta máquina | `--target all` |
| Uso só o Copilot | `--target copilot` |
| Uso só o Claude Code | `--target claude` |
| Uso Cursor | `--target cursor` |
| Meu IDE não tem hook (VS Code, Windsurf, Zed, JetBrains) | `--target mcp` |
| Quero que o time inteiro herde ao clonar o repositório | `--target repo` |

Veja [IDES.md](IDES.md) para a cobertura real de cada um.

## Repositórios do cliente

Se você trabalha em repositórios que **não são seus** e não pode commitar arquivos de
configuração, use apenas alvos de máquina:

```bash
npx token-guard init --target all
```

Nada é escrito dentro do repositório. Tudo vai para o seu perfil de usuário:

```
~/.copilot/extensions/token-guard/    Copilot
~/.claude/token-guard/                Claude Code
~/.cursor/token-guard/                Cursor
~/.token-guard/runtime/               MCP
```

## Instalação para o time (viaja no git)

Se o repositório é seu e você quer que todo mundo herde a economia ao clonar:

```bash
npx token-guard init --target repo
git add .github/ token-guard.config.json .gitignore
git commit -m "chore: token-guard"
```

O instalador faz **merge** do `hooks.json` existente — nunca sobrescreve.

## Instalação a partir do código-fonte

```bash
git clone https://github.com/AllanSantos-DV/token-guard.git
cd token-guard
node install.cjs --target all
```

## Verificando

```bash
npm test                       # todas as suítes (núcleo, adapters, mcp-cost, contrato, instalação, economia, hooks)
npx token-guard status         # config ativa
node install.cjs --target all --dry-run   # simulação sem escrever nada
```

No agente, peça: *"mostre o status do token guard"*.

## Desinstalando

Tudo que o instalador cria, em um lugar só:

| Alvo | Runtime | Registro | Config global |
|---|---|---|---|
| `copilot` | `~/.copilot/extensions/token-guard/` | — (extensão) | `~/.copilot/token-guard.config.json` |
| `claude` | `~/.claude/token-guard/` | entrada em `~/.claude/settings.json` › `hooks.PreToolUse` | `~/.claude/token-guard.config.json` |
| `cursor` | `~/.cursor/token-guard/` | entradas em `~/.cursor/hooks.json` (`beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution`) | `~/.cursor/token-guard.config.json` |
| `mcp` | `~/.token-guard/runtime/` | bloco `token-guard` na config MCP do IDE | `~/.token-guard/mcp.json` |
| `repo` | `.github/token-guard/`, `.github/agents/`, `.github/skills/` | entrada em `.github/hooks/hooks.json` | `token-guard.config.json` na raiz |

1. Remova o registro e o runtime da tabela acima.
2. Apague as configs globais cujos homes você usou (só existem se você passou `--mode`).
3. Estado regenerável, seguro de apagar: `<repo>/.token-guard/` (cache + estado de sessão).
4. No alvo `repo`: reverta também a linha `.token-guard/` adicionada ao `.gitignore`.

Para desligar sem desinstalar:

```bash
TOKEN_GUARD=off      # desliga (aceita também 0 e false)
TOKEN_GUARD=warn     # só avisa
```

## Configuração

Crie `token-guard.config.json` na raiz do repositório. Para valer em **todos** os
repositórios desta máquina, o instalador grava no home do alvo
(`~/.copilot/`, `~/.claude/`, `~/.cursor/`, `~/.token-guard/`) quando você passa
`--mode` — o loader lê os quatro. A config do repositório sempre vence sobre as globais.

Referência completa de chaves: [CONFIG.md](CONFIG.md).

```json
{
  "mode": "block",
  "limits": {
    "readBytesWithoutRange": 51200,
    "minRepoFilesForScanGuard": 400
  },
  "rules": {
    "broadScan": true,
    "blindRead": true,
    "noisePath": true,
    "shellDump": true
  },
  "noiseDirsExtra": ["instantclient", "dumps"],
  "allowlist": ["docs/gerado"]
}
```

`noiseDirsExtra` e `sourceExtExtra` **somam** aos defaults, em vez de substituí-los.
