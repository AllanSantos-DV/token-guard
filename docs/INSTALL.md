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
node selftest.cjs              # 27 casos contra o hook real
node test/adapters.test.cjs    # adapters Cursor e MCP
npx token-guard status         # config ativa
```

No agente, peça: *"mostre o status do token guard"*.

## Desinstalando

1. Remova a entrada do `token-guard` do arquivo de hooks do harness:
   - Copilot: apague `~/.copilot/extensions/token-guard/`
   - Claude Code: remova a entrada em `~/.claude/settings.json` › `hooks.PreToolUse`
   - Cursor: remova as entradas em `~/.cursor/hooks.json`
   - MCP: remova o bloco `token-guard` da config MCP do IDE
2. Apague os diretórios de runtime listados acima.

Para desligar sem desinstalar:

```bash
TOKEN_GUARD=off      # desliga
TOKEN_GUARD=warn     # só avisa
```

## Configuração

Crie `token-guard.config.json` na raiz do repositório (ou em `~/.copilot/` para valer em
todos). O arquivo do repositório sempre vence.

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
