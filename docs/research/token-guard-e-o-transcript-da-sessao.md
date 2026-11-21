# O Token Guard pode danificar o transcript da sessão do Claude Code?

Pergunta: algum caminho do token-guard (hooks, daemon, compactação ou corte, leitores de sessão) pode produzir o aviso
"part of this session's file is missing or damaged"? Análise só de leitura; nenhum transcript real foi aberto para
escrita e nenhum código mudou.

## Veredito

Não. Nenhum caminho do token-guard escreve, anexa, trunca, move, renomeia, apaga, trava ou restaura um `.jsonl` de
`~/.claude/projects`. O único código que abre transcript é de leitura, em dois pontos, e os dois abrem em modo `'r'`.

## Caminhos que tocam o transcript

| # | Arquivo:linha | Operação | Abertura | Concorre com o Claude? |
| - | - | - | - | - |
| 1 | `lib/ctxwatch.cjs:30-34` (`lastUsage`) | lê até 512 KiB do fim (`openSync 'r'`, `fstat`, `readSync`), fecha em `finally` (`:46-48`) | só leitura | Sim: roda no `UserPromptSubmit`, com o Claude vivo e gravando |
| 2 | `lib/cost.cjs:126` (`usageLines`) | lê o arquivo inteiro em blocos (`fs.promises.open 'r'`, `fh.read`), fecha em `finally` (`:146-148`) | só leitura | Sim, se o usuário roda `token-guard cost` ou abre a tela do daemon durante uma sessão |
| 3 | `lib/cost.cjs:210-237` (`jsonlIn`, `listTranscripts`) | `readdirSync` e `statSync` | metadados | Sim, sem efeito |
| 4 | `adapters/daemon-ui.cjs:136` | `execFile` de `cost.cjs --repos` em processo à parte; vira o caminho 2 | só leitura | Sim, sob demanda da tela |
| 5 | `bench/replay-transcripts.cjs:81` | `readFileSync` do transcript inteiro | só leitura | Só quando o dono roda `npm run replay`; fora do pacote em execução |
| 6 | `lib/claude-hooks.cjs:71` | só repassa `transcript_path` do payload; não abre nada | n/a | n/a |
| 7 | `lib/sessions-alive.cjs:22-28` | `readdirSync` de `~/.claude/sessions` e `process.kill(pid, 0)` (sinal 0 só testa existência) | metadados | Sim, sem efeito |

Nada em `~/.claude` é escrito fora de `settings.json` e `agents/scout.agent.md`: `install.cjs:184,889` e
`adapters/daemon-http.cjs:97` (merge de hooks, com troca atômica por `renameSync(tmp, file)`), `lib/uninstall.cjs:50,148,224-228`
(remove só hooks do token-guard, o agente scout e a pasta `~/.claude/token-guard`). Nenhum desses é transcript.

## Outros vetores verificados

- Encerramento de processo: os únicos `kill` são do daemon do próprio token-guard (`lib/daemon-client.cjs:344`, com pid
  provado pelo health do daemon, "nunca de arquivo"; `adapters/daemon-server.cjs:494`, filho que ele mesmo criou). Nunca
  o `claude`, nem processo por nome. O daemon é independente do ciclo de vida do Claude: fechar a sessão não passa por ele.
- Recortes e podas (`lib/postresult.cjs`, `pruneSaved`): operam sobre o texto do resultado da ferramenta no envelope do
  hook, em memória. Não tocam o arquivo; o Claude é quem grava o que quiser do resultado.
- Estado próprio (`~/.token-guard/*`, `.token-guard/sessions`): escrita só em pasta do token-guard (`lib/contract.cjs`,
  `lib/ctxwatch.cjs:99-101`, `lib/events.cjs`).
- Lock: nenhum. O Node abre em Windows com `FILE_SHARE_READ|WRITE|DELETE`, então a leitura não impede o Claude de anexar,
  renomear ou apagar (medido abaixo). `sessions-alive.cjs:53` abre `r+` só em lock do Codex (`~/.codex`), não do Claude.
- Backup ou restauração de transcript: não existe.

## Medição (cópia isolada)

Cópia de um transcript real (384.828 bytes) para pasta temporária; `lastUsage` e `analyze` do código real do produto:

- Leitura isolada: SHA-256 e mtime idênticos antes e depois.
- Concorrência: um processo chamou `lastUsage` em laço por 3 s (1.205 leituras) enquanto outro anexava linhas sem
  parar: 161.580 anexos, 0 erros, cauda anexada byte a byte igual ao esperado e prefixo original com o mesmo hash.
- Com um handle de leitura aberto, `rename` do arquivo e de volta funcionou (compartilhamento de exclusão do Node), ou
  seja, o token-guard não segura o arquivo preso.

## Leitura do quadro maior

O token-guard só lê; o dano descrito na pesquisa do Agent Launcher (`agent-launcher/docs/research/2026-11-18-aviso-de-sessao-danificada.md`)
tem outra assinatura: bloco de bytes nulos após append interrompido por desligamento inesperado do Windows (Kernel-Power 41
e EventLog 6008 às 16:20 de 13/11) e `parentUuid` órfão, ambos gerados pelo próprio Claude Code (issues
anthropics/claude-code #49876 e #21617). Um leitor `'r'` não gera nenhuma das duas.

## Como a pesquisa anterior foi aplicada

- `agent-launcher/.../aviso-de-sessao-danificada.md`: a assinatura do dano (nulos de append interrompido, cadeia
  `parentUuid` quebrada) e a regra do Claude Code que dispara o aviso serviram para decidir o que procurar: escrita,
  truncamento e lock. Os mesmos filtros foram aplicados ao token-guard.
- `daemon-followups-flaky.md`: confirma que o `uncaughtException` do daemon é tratado em `lib/daemon-lifecycle.cjs` e
  que o daemon só fecha sockets seus; reforça que nenhum caminho de encerramento atinge processo do Claude.

## Fontes

Código lido em `develop` (5453a1d). Issues citadas lidas pela pesquisa do launcher em 2026-11-18; não reabertas aqui.
