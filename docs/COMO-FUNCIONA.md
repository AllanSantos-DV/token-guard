# Como funciona

O caminho de uma chamada de ferramenta pelo token-guard, do harness ao veredito e de
volta. A regra que organiza tudo: **o núcleo decide, o adapter só traduz**. Uma
`decide()` em `lib/decide.cjs` serve todos os harnesses. O que muda de um para outro é
só o transporte até ela.

## 1. Antes da ferramenta: a decisão

```
agente planeja  Grep "**/*"  ──►  harness dispara o evento pré-execução
                                        │
                     adapter do harness (traduz o envelope)
                                        │
                lib/payload.cjs   normaliza nome, argumentos e cwd
                                        │
                lib/decide.cjs    triagem por família ── não vigiada? libera
                                        │
                lib/config.cjs    config do repo (sobe até 12 níveis) ou globais
                                        │
                lib/rules.cjs     broadScan · blindRead · noisePath · shellDump
                                        │
                   null (libera)  ou  { deny, reason, rule }
```

1. **Triagem por família.** A ferramenta é casada por família, não por nome exato:
   `view`/`read_file`/`Read`, `grep`/`Grep`, `glob`/`file_search`, `bash`/`powershell`…
   Um harness novo costuma cair numa família que já existe. Ferramenta fora das
   famílias vigiadas sai sem tocar no disco.
2. **Config.** `token-guard.config.json` subindo a árvore a partir do cwd do payload.
   Se não houver nenhuma, valem os globais (`~/.copilot`, `~/.claude`, `~/.cursor`,
   `~/.token-guard`). `TOKEN_GUARD=off` no ambiente vence tudo.
3. **Regras.** Cada regra julga uma coisa só: escopo da busca (`broadScan`), leitura
   grande sem faixa (`blindRead`), caminho de build/dependência (`noisePath`) ou dump
   de árvore pelo shell (`shellDump`). Com `.token-guard/repo-stats.json` (gravado por
   `token-guard audit`), repositórios com menos de 400 arquivos ficam livres dos guards
   de varredura.
4. **Veredito.** Sempre `deny` (nunca `ask`: o usuário sempre confirma, então perguntar não
   treina ninguém). O `reason` **sempre** traz a reescrita concreta — o comando ou a chamada
   de ferramenta, com os argumentos do pedido — pronta para o agente reexecutar. Nunca é um
   deny cego.
5. **Fail-open.** Payload inválido, config corrompida, regra que lança: tudo vira
   "libera". Um guard de economia não pode derrubar a sessão que deveria baratear.

## 2. O transporte, por harness

| Harness | Evento | Como chega à `decide()` | Processo por chamada? |
|---|---|---|---|
| Copilot CLI / App | `onPreToolUse` da extensão | in-process (`adapters/copilot-cli.mjs`) | não |
| Claude Code | `PreToolUse` `type: "http"` | POST para o daemon em `127.0.0.1` (`adapters/daemon-http.cjs`) | não |
| Codex CLI | `PreToolUse` `type: "mcp_tool"` | ferramenta `token_guard_hook` do servidor MCP da sessão (`adapters/mcp-server.cjs`) | não |
| Cursor | `preToolUse` + eventos nomeados | comando (`adapters/cursor-hook.cjs`) | sim |
| Copilot CLI (alvo `repo`) e Claude Code `--command-hooks` | `PreToolUse` de comando | `adapters/hook-cmd.cjs` → daemon por IPC, ou local | sim |
| VS Code, Windsurf, Zed, JetBrains | — (MCP não intercepta) | o agente consulta `token_guard_check` | — (só orienta) |

O custo de um hook de comando é nascer um Node, não a decisão. Por isso os três
harnesses principais têm um caminho sem processo por chamada. Os números ficam no
[README](../README.md#custo-de-latência-meça-na-sua-máquina).

## 3. O daemon

Um processo por usuário (`adapters/daemon-server.cjs`), que serve a mesma `decide()`
já carregada:

- **Endpoint:** named pipe (Windows) ou socket UNIX (POSIX) para os hooks de comando.
  Com o hook http do Claude Code, também TCP só em `127.0.0.1`, protegido por token no
  header `X-Token-Guard`.
- **Singleton:** quem decide é o `listen()`. O lock em disco é só uma pista, então um
  pid reusado depois de reboot não trava o daemon fora.
- **Cache de veredito:** chaveado pela raiz mais o hash das regras e de todas as
  configs em efeito, e invalidado quando qualquer uma delas muda no disco.
- **Ciclo de vida:** sobe no logon (autostart do alvo `claude`), no `SessionStart` do
  Claude Code ou sob demanda, no primeiro hook. Encerra após 10 min ocioso, exceto com
  o hook http ligado, em que ele é o único caminho. Um handshake de versão troca um
  daemon velho depois de um upgrade.
- **Falha:** o cliente de comando desarma depois de 3 falhas seguidas e decide
  localmente. O hook http, com o daemon fora, libera a chamada (fail-open).

Ele não guarda conversa nenhuma, só o cache de veredito.

## 4. Depois da ferramenta: o resultado

O evento pós-execução (`PostToolUse` no Claude Code, `onPostToolUse` no Copilot) faz
três coisas, nesta ordem:

1. **Evidência do contrato.** O arquivo que a ferramenta tocou entra em
   `.token-guard/sessions/<id>-touched.json`.
2. **bigResult.** Um resultado com mais de 25 mil caracteres de texto vira stub (cabeça e
   cauda). O integral vai para `.token-guard/results/`, e a dica da família vem junto
   ("refaça com `head_limit`", "leia por faixa"). No Copilot e no Claude Code ≥ 2.1.121
   o stub **substitui** o resultado. Payload binário (imagem em base64) e o arquivo
   original que Edit/Write devolvem ficam fora da medida.
3. **dupRead.** O hash da leitura fica registrado por sessão. A troca da releitura
   idêntica por um ponteiro ainda não chega ao modelo ([backlog](BACKLOG.md)).

## 5. No prompt: o contrato de saída

Os guards cuidam do que **entra** na janela, e o contrato cuida do que o agente
**escreve**. No Claude Code, o `SubagentStart` injeta o bloco `subagente` no scout. No `UserPromptSubmit` (Claude Code) e no `onUserPromptSubmitted`
(Copilot), a seção `sempre` de `contract.default.md` entra uma vez por sessão. As
seções `quando: codigo`, `quando: teste` e `quando: docs` entram no prompt seguinte
àquele em que a sessão tocou um arquivo do tipo. A evidência vem do passo 4.1, nunca
de classificar a frase do usuário. Detalhes em [CONTRACT.md](CONTRACT.md).

## 6. Fora do caminho quente: medir

- `token-guard audit` mede o custo do repositório em tokens, camada por camada (tudo,
  sem ruído, só fonte, só a lista de caminhos), e grava o `repo-stats.json` que calibra
  os guards.
- `token-guard mcp-cost` mede o preâmbulo dos servidores MCP declarados por handshake
  real (`initialize` → `tools/list`). Ele **executa** os servidores; `--list` só
  inventaria.
- `npm run replay` roda a `decide()` atual sobre as chamadas reais dos transcripts do
  Claude Code e mostra o que seria barrado hoje.

Nada disso abre conexão de saída. A única requisição de rede do projeto é a checagem
de versão de `status`/`--version` ([SECURITY.md](../SECURITY.md)).
