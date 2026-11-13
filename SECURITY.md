# Segurança e privacidade

O token-guard é um kit local: sem servidor remoto, sem telemetria, sem conta. O que ele
faz com a sua máquina e os seus dados:

## O que executa

- **Hooks**: o guard roda in-process (extensão Copilot), como hook http servido pelo
  daemon local (Claude Code), como ferramenta do servidor MCP chamada pelo hook
  `mcp_tool` (Codex) ou como processo (`node adapters/hook-cmd.cjs`, modo comando)
  dentro da sua sessão de agente. Ele **lê** o payload da
  ferramenta e decide; nunca executa o comando que está avaliando.
- **`mcp-cost` sem `--list` EXECUTA os servidores MCP declarados** nas suas configs
  (`command` de cada um), via handshake JSON-RPC por stdio, com timeout. São
  processos que sua IDE já rodaria — mas quem chama precisa saber que há spawn.
  No Windows, `.cmd`/`.bat` passam obrigatoriamente por shell (exigência do Node
  pós-CVE-2024-27980), com a linha montada e escapada aqui.
- **Daemon residente** (`node adapters/daemon-server.cjs`): processo único por usuário
  que serve a mesma decisão por IPC, para os hooks não pagarem um `spawn` por evento.
  Escuta em named pipe local (`\\.\pipe\token-guard-<sid>`) no Windows ou socket UNIX
  (`$XDG_RUNTIME_DIR|/tmp/token-guard-<uid>.sock`, `chmod 700`) no POSIX. Autoencerra após
  10 min sem requisição (`TOKEN_GUARD_DAEMON_IDLE_MS`; `0` ou negativo desativa). Com o hook http
  ligado (abaixo) ele é o único caminho dos hooks e só se autoencerra se `TOKEN_GUARD_DAEMON_IDLE_MS` for definido. Verificação da ACL do pipe:
  `scripts/verify-daemon-security.ps1`.
- **Hook http do Claude Code** (desde a 2.6.0, `init --target claude`): o daemon também
  escuta em **TCP `127.0.0.1`** (nunca em outra interface), na última porta registrada em `~/.token-guard/daemon-http.json`
  (ou numa livre, que passa a ser a registrada). A cada início o daemon reescreve a URL dos hooks do token-guard no
  `~/.claude/settings.json` com essa porta; a URL declara `hook-origin=token-guard` e `port-file`, o arquivo dono da porta.
  Toda requisição precisa do header `X-Token-Guard` com o token de
  `~/.token-guard/daemon-http.token` (32 bytes aleatórios, gravado pelo instalador com
  permissão só do dono, copiado para o `~/.claude/settings.json`); sem ele, 401 e nada é
  decidido. Sem o arquivo de token, a porta nem abre. Qualquer processo local pode tentar
  conectar — o token é o que separa. `--command-hooks` dispensa a porta.
- **Tela de setup e ícone da bandeja** (desde a 2.14.0): o mesmo servidor http serve `/token-guard/ui*` e `/token-guard/stream`. A tela
  só abre com um bilhete de uso único (60 s) pedido com o token do dono; vira cookie `HttpOnly; SameSite=Strict`. Escrita exige o cookie
  e um token anti-CSRF; `Host` precisa ser o loopback desta porta; CSP com nonce, sem recurso externo. No Windows o daemon sobe um
  helper PowerShell (`adapters/tray.ps1`) oculto, que lê o estado por esse http com o token do dono. `token-guard setup` cria o token
  (`~/.token-guard/daemon-http.token`, só do dono) se a instalação ainda não tem.
- `npx @allansantos-dev/token-guard audit` só varre o disco em leitura.

## O que lê

- Payloads das chamadas de ferramenta (caminhos, argumentos de busca/comando) —
  em memória, para decidir. Nada disso é enviado para fora da máquina.
- `token-guard.config.json` e as configs MCP declaradas nas IDEs conhecidas.

## O que grava

O estado de sessão (`<repo>/.token-guard/`, abaixo) só é criado dentro do projeto onde a sessão nasceu
(pasta com `.git`, `package.json` ou outro marcador de projeto). Pastas por onde o agente navega depois,
e sessões abertas fora de um projeto (Área de Trabalho, Documentos, AppData, pasta do usuário, raiz de
disco), não ganham pasta nenhuma: o mesmo estado vai para a pasta de dados do usuário
(`%LOCALAPPDATA%	oken-guardstate` no Windows, `~/Library/Application Support/token-guard/state` no
macOS, `$XDG_STATE_HOME/token-guard/state` ou `~/.local/state/token-guard/state` no Linux).

- `<repo>/.token-guard/repo-stats.json` — estatísticas agregadas do scan.
- `<repo>/.token-guard/sessions/<id>.json` — seções de contrato já injetadas,
  com o id de sessão sanitizado (≤80 chars, sem separador de caminho). Poda após 7 dias.
- `<repo>/.token-guard/sessions/<id>-touched.json` — caminhos que a sessão tocou (até 50),
  evidência dos gatilhos do contrato; `<id>-reads.json` — hash das leituras (dedupe).
- `<repo>/.token-guard/results/*.txt` — **cópia integral da saída de ferramenta** que o
  `bigResult` truncou, para o agente reler por faixa. Fica no repositório, local; as 50
  mais recentes são mantidas. Trate como a própria saída: pode conter o que a ferramenta
  mostrou (inclusive segredo que um comando tenha impresso).
- `~/.token-guard/update-check.json` — `{ latestVersion, checkedAt }` da checagem de
  versão descrita abaixo.
- `~/.token-guard/daemon-http.token` — token do hook http e da tela (gravado com `--target claude` ou por `token-guard setup`).
- `~/.token-guard/events.jsonl` — um evento por bloqueio ou poupança (quando, IDE, regra, ferramenta, e o caminho ou comando
  limitado a 120 caracteres, tokens poupados quando medidos, e a raiz do repositório da sessão, para a poupança por repositório). Fica só na máquina; aparado acima de 2 MB. Pode conter um comando
  que a ferramenta tentou rodar.
- `~/.token-guard/token-guard.config.json` — o que a tela de setup grava (`mode`, `targets`, `rules`, `ui.tray`).
- `~/.token-guard/daemon-http.json` — `{ port, url, pid, version }` de onde o hook http
  subiu (ou `error`, se não subiu). O daemon reescreve, só quando a porta muda, as URLs
  dos hooks http do token-guard em `~/.claude/settings.json` — nenhuma outra entrada.
- `~/.token-guard/daemon.log` — uma linha JSON por partida e saída do daemon (`start`, `exit`, `previous-unclean`, `http-on`, `http-off`:
  pid, versão, código, motivo, porta do hook http e quantos hooks foram reapontados); sem conteúdo de chamadas, aparado acima de 128 KB.
- `~/.token-guard/install-state.json` — alvos de máquina instalados (para o auto-update);
  `auto-update.json` / `auto-update.log` / `auto-update.lock` — resultado, saída do
  instalador e trava da última atualização automática.
- Lock de singleton do daemon: `<socket>.lock` no POSIX,
  `%TEMP%/token-guard-locks/<pipe>.lock` no Windows — pid e versão de protocolo.
- Autostart do daemon (só `--target claude`): tarefas agendadas `TokenGuardDaemon` (logon) e
  `TokenGuardDaemonWatch` (vigia a cada 5 min) e a variável de usuário `TOKEN_GUARD_SID` no Windows; unit `token-guard-daemon.service`
  (systemd --user) no Linux; `com.token-guard.daemon.plist` (LaunchAgents) no macOS.
- Nos alvos de máquina: runtime e config sob o seu perfil (`~/.copilot`, `~/.claude`,
  `~/.codex` — `config.toml` e `hooks.json` recebem só a entrada do token-guard —,
  `~/.cursor`, `~/.token-guard`). Nada é escrito no repositório a menos que você
  escolha `--target repo`.

## A única saída de rede

`cli.cjs status` e `cli.cjs --version` fazem **um GET a**
`https://registry.npmjs.org/@allansantos-dev/token-guard` para avisar se há versão
nova (`lib/update-check.cjs`). O que isso significa, explicitamente:

- **Nada sobre você vai na requisição** — é o documento público do pacote, sem corpo,
  sem identificador, sem contagem de uso. O registry vê o que vê de qualquer `npm view`:
  um IP e um user-agent.
- **Só nesses dois comandos e no auto-update** (abaixo). O caminho quente (hooks, plugin in-process, daemon, MCP)
  nunca abre conexão de saída — o único listener TCP é o do hook http, em loopback.
  Um veredito jamais depende de estar on-line.
- **No máximo 1× por 24 h**, por causa do cache em `~/.token-guard/update-check.json`.
- **Desligável:** `TOKEN_GUARD_UPDATE_CHECK=off`. Falha de rede é silenciosa
  (best-effort): o comando segue normalmente.

**Auto-update (desde a 2.8.0).** Depois de um `init` em alvo de máquina, o
`SessionStart` do Claude Code também faz essa checagem (mesmo cache de 24 h), num
processo oculto e destacado. Havendo versão nova, roda
`npx --yes @allansantos-dev/token-guard@<versão> init --target <alvos registrados>`:
baixa o pacote do npm e executa o instalador dele, com os seus privilégios de usuário.
Só entram versão semver e alvo conhecido no comando. O resultado é mostrado na sessão
seguinte. Desligue com `TOKEN_GUARD_AUTO_UPDATE=off` (ou `TOKEN_GUARD_UPDATE_CHECK=off`).

Depois de um auto-update bem-sucedido, o token-guard **apaga** do cache do npm o que o `npx` deixou de versões antigas
dele: as pastas `<cache>/_npx/<hash>` e, em `<cache>/_cacache`, o conteúdo e a linha do índice dos tarballs dessas versões.
Só apaga pasta cujo único pacote pedido é o `@allansantos-dev/token-guard` e entrada cuja chave é o tarball dele,
nunca a da versão recém-instalada; falha na instalação não apaga nada, e erro ao apagar é ignorado. Para achar o cache,
roda `npm config get cache` (oculto, local, sem rede) e respeita o `cache=` do `.npmrc`.

## O que NÃO existe

- Telemetria, métricas de uso, "phone home" — a checagem de versão e o download do
  auto-update acima são as únicas requisições que saem, e não carregam dado nenhum seu.
- Dependência npm nenhuma em runtime (superfície de supply chain = zero).
- Avaliação remota de código de config: JSON parseado, campos lidos, nada mais.

## Reportar

Vulnerabilidades: abra uma issue privada em
<https://github.com/AllanSantos-DV/token-guard/security/advisories/new>.
