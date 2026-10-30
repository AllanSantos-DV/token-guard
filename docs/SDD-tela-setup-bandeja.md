# SDD — Tela de setup e ícone na bandeja do daemon

Status: implementado na 2.14.0. Pedido do dono (palavras dele, fonte da verdade do desenho): *"se tem daemon deveria
ter uma tela de setup e um tray icon pra facilitar o user a configurar tipo de bloqueio e etc, além de mostrar e
configurar o que ele faz, além de ter modo de bloqueio por global ou ide ou algo do tipo. Hoje as config não são
human face, são tudo voltado pra config que máquina faz."*

## 1. O fluxo desenhado (e só ele)

1. O **ícone na bandeja** mostra o estado do daemon (protegendo, em parte, desligado, daemon fora) e abre a tela com um clique.
2. A **tela de setup**, em português de gente, deixa o usuário:
   - ligar ou desligar cada regra (`broadScan`, `blindRead`, `noisePath`, `shellDump`, `bigResult`, `dupRead`, `scout`),
     ver **o que ela faz, por que e um exemplo**;
   - ver **o que já foi barrado e poupado**;
   - escolher o **modo de bloqueio global ou por IDE** (Claude Code, Codex, Cursor, Copilot, MCP).
3. A escolha vai para a **config que já existe**; CLI, hooks e tela leem a mesma fonte.

Fora deste fluxo não entra nada no desenho principal. O que parece útil e não foi pedido está na seção 8, desligado.

## 2. Reuso (nada recriado)

| Já existia | Uso |
|---|---|
| `adapters/daemon-http.cjs` (127.0.0.1, token `X-Token-Guard`, porta preferida com reserva) | a tela e o fluxo do ícone são rotas do mesmo servidor; nenhuma porta nova |
| `lib/config.cjs` (`load`, `activeRules`, `DEFAULTS`, cache de 2 s, merge dos homes globais) | ganhou `targets` e `ui.tray`; `load(root, target)` aplica o modo do IDE |
| `lib/daemon-client.cjs` (`realSpawn`, `shutdownDaemon`), `lib/daemon-status.cjs` (`probeHealth`) | `token-guard setup` sobe/reinicia o daemon e confere a saúde |
| `adapters/run-daemon.cmd` | o ícone sobe o daemon por ele quando o daemon está fora |
| `test/bootstrap.cjs` (home, SID e daemon isolados) | testes silenciosos; ganhou `TOKEN_GUARD_TRAY=off` |

## 3. Modelo de configuração

```json
{ "mode": "block",
  "targets": { "claude": "off" },
  "rules": { "scout": false },
  "ui": { "tray": true } }
```

- `mode` é o geral (`block` | `off`), como sempre foi.
- `targets.<ide>` = `block` | `off`; ausente = segue o geral. Geral `off` vence qualquer IDE.
- `rules` e `ui.tray` booleanos. Valor inválido volta ao default **por chave** (fail-open).
- A tela grava em `~/.token-guard/token-guard.config.json`, o último dos homes globais no merge, por escrita atômica, sem
  tocar nas demais chaves e **sem sobrescrever arquivo ilegível** (o erro aparece na tela). Config de repositório continua
  mandando no próprio repositório.
- Quem pergunta se identifica: `decide(payload, {target})` e `CFG.load(root, target)`. IDE desligado devolve `mode: "off"`,
  então todo consumidor que já respeitava o modo global respeita o do IDE sem regra nova. O daemon inclui o IDE na chave do
  cache de vereditos.
- Identificação do IDE: Cursor, Codex (ponte `token_guard_hook`), MCP e Copilot (extensão) declaram o próprio alvo; o hook de
  comando/http distingue Copilot (`toolCall`) de Claude Code pelo envelope.
- Pós-processamento (`bigResult`, `dupRead`, `scout`): guard desligado, global ou do IDE, não corta, não registra e não sugere.

## 4. Eventos: o que foi barrado e poupado

O daemon grava uma linha por evento em `~/.token-guard/events.jsonl` (`lib/events.cjs`): `deny`, `trim` (bigResult),
`dup` (dupRead), `scout`. **Tokens só onde são medidos**: o corte do `bigResult` e o stub do `dupRead` sabem quantos caracteres
deixaram de entrar (4 caracteres ≈ 1 token); um `deny` não mede o que evitou e entra só na contagem. O arquivo é aparado
(últimas 8 000 linhas) acima de 2 MB, na subida do daemon e a cada 200 registros de qualquer processo. O detalhe (caminho ou comando) é local e
limitado a 120 caracteres. **Bloqueios** são registrados por todos os caminhos (daemon, hook sem daemon, extensão do Copilot, Cursor, MCP/Codex); a
tela é empurrada quando o arquivo muda. **Cortes e duplicatas** só são registrados quando o daemon atende o pós-processamento.

## 5. Entrada na tela e segurança

1. Quem tem o token do dono (CLI `token-guard setup`, ícone) faz `POST /token-guard/ui/ticket` e recebe um **bilhete de uso
   único, 60 s**. O navegador abre `/token-guard/ui?ticket=…`; o daemon troca por cookie `HttpOnly; SameSite=Strict;
   Path=/token-guard` e redireciona para a URL limpa. O token do dono nunca vai à barra de endereço.
2. Toda rota da tela exige `Host` = loopback desta porta (barra DNS rebinding). Escrita exige cookie **e** token anti-CSRF no
   header (embutido no HTML da sessão), e `Origin`, se presente, tem de ser a própria origem.
3. CSP com nonce (`default-src 'none'`), sem recurso externo, `frame-ancestors 'none'`, `no-store`.
4. A tela monta o DOM com `textContent`; comando/caminho de evento nunca vira HTML.
5. Sem token ainda (instalação sem o alvo `claude`), `setup` cria o do usuário (`~/.token-guard/daemon-http.token`, modo
   0600); daemon de pé sem http é reiniciado, como o `SessionStart` já faz.

## 6. Empurrado, não consultado

- Tela: `GET /token-guard/ui/stream` (SSE, cookie). Recebe um snapshot na conexão e outro a cada evento ou mudança de config.
- Ícone: `GET /token-guard/stream` (SSE, token do dono). Recebe estado, rótulo, contagem do dia e `show`.
- A mudança de config feita **por fora** (CLI, editor) também chega: o daemon observa a pasta `~/.token-guard` (`fs.watch`).
- Rajadas viram um empurrão só (coalescência de 100 ms). Heartbeat de 25 s mantém o fluxo vivo.
- O formulário do ícone tem um timer de 400 ms que só lê uma tabela local escrita pela thread do fluxo; nenhuma consulta de rede
  em laço.

## 7. O ícone

- Helper PowerShell 5.1 (`adapters/tray.ps1`, `System.Windows.Forms.NotifyIcon`): zero dependências. Nasce com o daemon
  (`lib/tray.cjs`), sob `conhost.exe --headless` com stdin em pipe (o stdin fechado impede o conhost de executar o filho),
  um por usuário (mutex `Local\TokenGuardTray`).
- Escudo desenhado em tempo de execução, estados que **não dependem só de cor**: verde com visto (protegendo), âmbar com traço
  curto (em parte), vermelho com barra (desligado), cinza com ponto (daemon fora).
- Clique ou "Abrir configurações" pede o bilhete e abre o navegador padrão; com o daemon fora, sobe `run-daemon.cmd`. "Fechar o
  ícone" encerra só o ícone. Desligar "Ícone na bandeja" na tela fecha o ícone na hora.
- Silêncio garantido: `TOKEN_GUARD_TRAY=off` (o bootstrap dos testes), `ui.tray: false`, fora do Windows. macOS/Linux abrem a
  tela por `token-guard setup`; não há helper de bandeja para eles (BACKLOG A40, decisão do dono).

## 8. Propostas opcionais — DESLIGADAS, fora do desenho principal, a decidir pelo dono

| Proposta | Estado |
|---|---|
| Pausar/retomar o bloqueio direto no menu do ícone | desligada; hoje a chave geral está na tela |
| Regras diferentes por IDE (hoje só liga/desliga o IDE inteiro) | desligada |
| Modo "só avisar, sem barrar" | desligado; o `warn` foi aposentado porque o usuário sempre confirmava e o agente não aprendia |
| Ícone no macOS/Linux | desligado (A40) |

## 9. Testes

`test/targets.test.cjs` (modo por IDE, catálogo ⇄ config, escrita validada e preservadora, eventos, daemon por alvo e guard
desligado no pós-processamento), `test/setup-ui.test.cjs` (daemon real isolado: bilhete, cookie, Host, CSRF, CSP, SSE de tela e de
ícone, `setup --no-open`), `test/tray.test.cjs` (quando sobe, como sobe, parser do PowerShell 5.1, um ícone por estado). Nenhum
abre janela ou ícone; nenhum toca o daemon do usuário.
