# Instalação

## Pré-requisito

Node.js 16+. Nada mais — o projeto é zero-dependency de propósito, para rodar em máquina
corporativa sem `npm install`.

## Instalação rápida

```bash
# 1. veja o tamanho do problema antes de instalar qualquer coisa
npx @allansantos-dev/token-guard audit

# 2. instale em tudo que é de máquina
npx @allansantos-dev/token-guard init --target all

# 3. confirme que responde neste ambiente
npx @allansantos-dev/token-guard test
```

## Escolhendo o alvo

| Situação | Alvo |
|---|---|
| Quero economia em todos os meus repositórios, nesta máquina | `--target all` |
| Uso só o Copilot | `--target copilot` |
| Uso só o Claude Code | `--target claude` |
| Uso o Codex CLI | `--target codex` |
| Uso Cursor | `--target cursor` |
| Meu IDE não tem hook (VS Code, Windsurf, Zed, JetBrains) | `--target mcp` |
| Quero que o time inteiro herde ao clonar o repositório | `--target repo` |

Veja [IDES.md](IDES.md) para a cobertura real de cada um.

## Repositórios do cliente

Se você trabalha em repositórios que **não são seus** e não pode commitar arquivos de
configuração, use apenas alvos de máquina:

```bash
npx @allansantos-dev/token-guard init --target all
```

Nada é escrito dentro do repositório. Tudo vai para o seu perfil de usuário:

```
~/.copilot/extensions/token-guard/    Copilot
~/.claude/token-guard/                Claude Code
~/.codex/token-guard/                 Codex (respeita $CODEX_HOME)
~/.cursor/token-guard/                Cursor
~/.token-guard/runtime/               MCP
```

## Instalação para o time (viaja no git)

Se o repositório é seu e você quer que todo mundo herde a economia ao clonar:

```bash
npx @allansantos-dev/token-guard init --target repo
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
npm test                       # todas as suítes (no clone do repositório)
npx @allansantos-dev/token-guard test           # o núcleo, contra o hook real
npx @allansantos-dev/token-guard status         # config ativa
node install.cjs --target all --dry-run   # simulação sem escrever nada
```

No agente, peça: *"mostre o status do token guard"*.

## Desinstalando

Tudo que o instalador cria, em um lugar só:

| Alvo | Runtime | Registro | Config global |
|---|---|---|---|
| `copilot` | `~/.copilot/extensions/token-guard/` | — (extensão) | `~/.copilot/token-guard.config.json` |
| `claude` | `~/.claude/token-guard/` | entradas em `~/.claude/settings.json` › `hooks`: `PreToolUse`, `PostToolUse`, `UserPromptSubmit` (http) e `SessionStart` (comando); token em `~/.token-guard/daemon-http.token`; autostart do daemon (abaixo) | `~/.claude/token-guard.config.json` |
| `codex` | `~/.codex/token-guard/` | tabela `[mcp_servers.token-guard]` em `~/.codex/config.toml` + entrada `mcp_tool` (server `token-guard`) em `~/.codex/hooks.json` › `PreToolUse` | `~/.token-guard/token-guard.config.json` |
| `cursor` | `~/.cursor/token-guard/` | entradas em `~/.cursor/hooks.json` (`preToolUse`, `beforeReadFile`, `beforeShellExecution`, `beforeMCPExecution`) | `~/.cursor/token-guard.config.json` |
| `mcp` | `~/.token-guard/runtime/` (+ o snippet `~/.token-guard/mcp.json`) | bloco `token-guard` na config MCP do IDE | `~/.token-guard/token-guard.config.json` |
| `repo` | `.github/token-guard/`, `.github/agents/`, `.github/skills/` | entrada em `.github/hooks/hooks.json` | `token-guard.config.json` na raiz |

1. Remova o registro e o runtime da tabela acima.
   No alvo `claude`, remova também o autostart do daemon:
   - Windows: `schtasks /delete /tn TokenGuardDaemon /f` e `reg delete HKCU\Environment /v TOKEN_GUARD_SID /f`
   - Linux: `systemctl --user disable --now token-guard-daemon` e apague `~/.config/systemd/user/token-guard-daemon.service`
   - macOS: `launchctl unload -w ~/Library/LaunchAgents/com.token-guard.daemon.plist` e apague o arquivo
2. Apague as configs globais cujos homes você usou (só existem se você passou `--mode`).
3. Estado regenerável, seguro de apagar: `<repo>/.token-guard/` (cache + estado de sessão).
4. No alvo `repo`: reverta também a linha `.token-guard/` adicionada ao `.gitignore`.

Para desligar sem desinstalar:

```bash
TOKEN_GUARD=off      # desliga (aceita também 0 e false)
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
