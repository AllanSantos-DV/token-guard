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
- `npx @allansantos-dev/token-guard audit` só varre o disco em leitura.

## O que lê

- Payloads das chamadas de ferramenta (caminhos, argumentos de busca/comando) —
  em memória, para decidir. Nada é enviado para fora da máquina.
- `token-guard.config.json` e as configs MCP declaradas nas IDEs conhecidas.

## O que grava

- `<repo>/.token-guard/repo-stats.json` — estatísticas agregadas do scan.
- `<repo>/.token-guard/sessions/<id>.json` — seções de contrato já injetadas,
  com o id de sessão sanitizado (≤80 chars, sem separador de caminho). Poda após 7 dias.
- Nos alvos de máquina: runtime e config sob o seu perfil (`~/.copilot`, `~/.claude`,
  `~/.cursor`, `~/.token-guard`). Nada é escrito no repositório a menos que você
  escolha `--target repo`.

## O que NÃO existe

- Telemetria, métricas, "phone home".
- Dependência npm nenhuma em runtime (superfície de supply chain = zero).
- Avaliação remota de código de config: JSON parseado, campos lidos, nada mais.

## Reportar

Vulnerabilidades: abra uma issue privada em
<https://github.com/AllanSantos-DV/token-guard/security/advisories/new>.
