# Troubleshooting

## Instalei mas o guard não bloqueia nada

1. **Reinicie a sessão do agente.** Hooks carregam no boot da sessão.
2. **Repositório pequeno?** Abaixo de `limits.minRepoFilesForScanGuard` (400
   arquivos) os guards de varredura ficam de propósito — rode
   `npx @allansantos-dev/token-guard audit` uma vez para calibrar com o número real.
3. **A ferramenta entra nas famílias vigiadas?** O casamento é por família
   (`read`/`grep`/`glob`/`shell`), não por nome exato — veja `lib/rules.cjs`.
4. Confira: `npx @allansantos-dev/token-guard status`.

## Instalei um upgrade e o guard sumiu

Registro antigo apontando para script que não existe mais era mascarado como
"já registrado" em versões anteriores. Reinstale — versões atuais **reparam** o
registro obsoleto e avisam (`registro obsoleto reparado`).

## Meu `--mode warn` não pergunta nada, nega

`warn` foi aposentado: a pergunta caía no usuário, que sempre confirma, e o agente não aprendia nada. Agora vale `block`: a recusa traz o comando alternativo pronto e o agente o executa no turno seguinte. `--mode warn` grava `block` e avisa.

## Minha config global não está valendo

Em versões anteriores, a config global gravada em `~/.claude/`, `~/.cursor/` ou
`~/.token-guard/` nunca era lida (só `~/.copilot/`). Atualize: o loader agora lê
os quatro homes. Conferência imediata: `npx @allansantos-dev/token-guard status` mostra `_source`.

## Uma regra específica atrapalha este repositório

Não desligue o guard inteiro. No `token-guard.config.json` do repo:

```json
{ "rules": { "shellDump": false }, "allowlist": ["vendor/meu-legado"] }
```

`TOKEN_GUARD=off` é para emergência, não para o dia a dia.

## O guard bloqueou um comando legítimo

- Comando contendo palavra reservada no meio (ex.: `git commit -m "fix tree view"`):
  corrigido na 2.1.0 — atualize.
- `grep`/`rg` com escopo explícito fora da raiz passa; sem escopo é barrado de
  propósito (o custo é a saída, não a varredura).
- Caso restante: abra issue com o payload (apague caminhos sensíveis).

## Cursor bloqueia leitura de arquivo grande que eu pedi inteiro

Limitação do harness: `beforeReadFile` não informa faixa de linhas, então toda
leitura >50 KB é tratada como cega ([docs/IDES.md](IDES.md)). Peça com busca
primeiro, ou leia via shell com filtro.

## mcp-cost mostra "sem resposta"

- Transporte HTTP/SSE não é sondável por stdio — declarado como tal, não como zero.
- `.cmd`/`.bat` exigem shell no Windows (Node pós-CVE-2024-27980) — tratado.
- Aumente o teto: `--timeout 30000`. Inventário sem executar nada: `--list`.

## Config ignorada

Ordem de busca: sobe 12 níveis procurando `token-guard.config.json`; senão globals
mesclados de `~/.copilot|.claude|.cursor|.token-guard`; senão defaults. JSON
inválido na config do repo cai nos defaults **e diz isso** em `npx @allansantos-dev/token-guard status`.
Chave com tipo errado volta ao default individual (não derruba as demais).

## Windows corporativo: tudo parece lento

O piso do spawn de Node domina (antivírus). Meça:
`node bench/latency.cjs` — compare hook vs `node -e "0"`. Se o custo for do
runtime, prefira um caminho sem processo por chamada: o plugin no Copilot, o hook
http no Claude Code (padrão desde a 2.6.0 — confira em `~/.claude/settings.json` se
os hooks do token-guard são `type: "http"`) e o `mcp_tool` no Codex. No modo
repositório, confie no `matcher` do hooks.json.

## Claude Code: hook http não bloqueia

O hook http falha **aberto**: com o daemon fora do ar, a ferramenta passa sem guard.

- O `SessionStart` do token-guard sobe o daemon no início da sessão — reinicie a
  sessão depois de instalar. Se o daemon não fica pronto, ele avisa na tela
  (`systemMessage`) em vez de seguir calado.
- **Conexão recusada numa porta que não é a do daemon** (ex.: depois de atualizar à
  mão): desde a 2.8.0 a porta é dinâmica. O daemon tenta a preferida, depois a última
  registrada, depois qualquer livre; grava onde subiu em `~/.token-guard/daemon-http.json`
  e reaponta os hooks do token-guard no `~/.claude/settings.json` (o Claude Code relê
  hooks alterados sem reiniciar). O `SessionStart` confere de novo a cada sessão.
- `TOKEN_GUARD_HTTP_PORT` fixa a porta, sem fallback: ocupada, o hook http fica
  desligado e o `SessionStart` avisa o motivo (`daemon-http.json` › `error`).
- Política que restringe `allowedHttpHookUrls`: a porta pode mudar; fixe-a com
  `TOKEN_GUARD_HTTP_PORT` e inclua `http://127.0.0.1:<porta>/*` (o instalador avisa),
  ou reinstale com `init --target claude --command-hooks`.
- Daemon que cai **no meio** da sessão volta pelo vigia em até ~5 min (tarefa
  `TokenGuardDaemonWatch` no Windows, `StartInterval` no macOS, `Restart=on-failure` no
  Linux); até lá o hook http falha aberto.

## A tela de setup não abre ou o ícone não aparece

- `token-guard setup --no-open` imprime a URL (vale 60 s, uma vez). Se ele disser que o daemon não subiu o http, rode `token-guard status`.
- "bilhete inválido ou vencido": abra de novo pelo ícone ou por `token-guard setup`; cada bilhete serve uma vez.
- Tela com "Sem conexão": o daemon reiniciou; feche a aba e abra de novo.
- O ícone só existe no Windows e nasce com o daemon (também com `ui.tray` ligado e sem `TOKEN_GUARD_TRAY=off`). No Windows 11 ele costuma
  ficar no menu de ícones ocultos (seta ao lado do relógio); arraste para a barra se quiser. Cinza = daemon fora do ar; ele volta sozinho
  (vigia a cada ~5 min) ou clicando no ícone.
- Escolheu "Desligado" para um IDE e ele continua barrando? Um `token-guard.config.json` do repositório pode estar mandando; `token-guard status` mostra a origem da config.
- Variável de ambiente `TOKEN_GUARD=off` desliga tudo e a tela avisa; remova a variável para voltar a controlar por ela.

## Codex: o hook não dispara

- Hook novo do Codex fica desativado até ser aprovado em `/hooks`.
- O servidor MCP `token-guard` precisa estar conectado à sessão (`[mcp_servers.token-guard]`
  em `~/.codex/config.toml`).
- Só `shellDump` atua: o agente do Codex lê arquivos pelo shell, e o hook é só `Bash`.
