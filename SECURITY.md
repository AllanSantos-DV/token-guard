# Segurança e privacidade

O token-guard é um kit local: sem servidor, sem telemetria, sem conta. O que ele
faz com a sua máquina e os seus dados:

## O que executa

- **Hooks**: o guard roda como processo (`node adapters/hook-cmd.cjs`) ou in-process
  (extensão Copilot) dentro da sua sessão de agente. Ele **lê** o payload da
  ferramenta e decide; nunca executa o comando que está avaliando.
- **`mcp-cost` sem `--list` EXECUTA os servidores MCP declarados** nas suas configs
  (`command` de cada um), via handshake JSON-RPC por stdio, com timeout. São
  processos que sua IDE já rodaria — mas quem chama precisa saber que há spawn.
  No Windows, `.cmd`/`.bat` passam obrigatoriamente por shell (exigência do Node
  pós-CVE-2024-27980), com a linha montada e escapada aqui.
- **Daemon residente** (`node adapters/daemon-server.cjs`): processo único por usuário
  que serve a mesma decisão por IPC, para os hooks não pagarem um `spawn` por evento.
  Escuta em named pipe local (`\\.\pipe\token-guard-<sid>`) no Windows ou socket UNIX
  (`$XDG_RUNTIME_DIR|/tmp/token-guard-<uid>.sock`, `chmod 700`) no POSIX — sem porta TCP,
  sem alcance de rede. Autoencerra após 10 min sem requisição
  (`TOKEN_GUARD_DAEMON_IDLE_MS`, 0 desativa). Verificação da ACL do pipe:
  `scripts/verify-daemon-security.ps1`.
- `npx @allansantos-dev/token-guard audit` só varre o disco em leitura.

## O que lê

- Payloads das chamadas de ferramenta (caminhos, argumentos de busca/comando) —
  em memória, para decidir. Nada disso é enviado para fora da máquina.
- `token-guard.config.json` e as configs MCP declaradas nas IDEs conhecidas.

## O que grava

- `<repo>/.token-guard/repo-stats.json` — estatísticas agregadas do scan.
- `<repo>/.token-guard/sessions/<id>.json` — seções de contrato já injetadas,
  com o id de sessão sanitizado (≤80 chars, sem separador de caminho). Poda após 7 dias.
- `~/.token-guard/update-check.json` — `{ latestVersion, checkedAt }` da checagem de
  versão descrita abaixo.
- Lock de singleton do daemon: `<socket>.lock` no POSIX,
  `%TEMP%/token-guard-locks/<pipe>.lock` no Windows — pid e versão de protocolo.
- Nos alvos de máquina: runtime e config sob o seu perfil (`~/.copilot`, `~/.claude`,
  `~/.cursor`, `~/.token-guard`). Nada é escrito no repositório a menos que você
  escolha `--target repo`.

## A única saída de rede

`cli.cjs status` e `cli.cjs --version` fazem **um GET a**
`https://registry.npmjs.org/@allansantos-dev/token-guard` para avisar se há versão
nova (`lib/update-check.cjs`). O que isso significa, explicitamente:

- **Nada sobre você vai na requisição** — é o documento público do pacote, sem corpo,
  sem identificador, sem contagem de uso. O registry vê o que vê de qualquer `npm view`:
  um IP e um user-agent.
- **Só nesses dois comandos.** O caminho quente (hooks, plugin in-process, daemon, MCP)
  nunca abre socket de rede — um veredito jamais depende de estar on-line.
- **No máximo 1× por 24 h**, por causa do cache em `~/.token-guard/update-check.json`.
- **Desligável:** `TOKEN_GUARD_UPDATE_CHECK=off`. Falha de rede é silenciosa
  (best-effort): o comando segue normalmente.

## O que NÃO existe

- Telemetria, métricas de uso, "phone home" — a checagem de versão acima é a única
  requisição que sai, e ela não carrega dado nenhum seu.
- Dependência npm nenhuma em runtime (superfície de supply chain = zero).
- Avaliação remota de código de config: JSON parseado, campos lidos, nada mais.

## Reportar

Vulnerabilidades: abra uma issue privada em
<https://github.com/AllanSantos-DV/token-guard/security/advisories/new>.
