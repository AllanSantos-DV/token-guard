# Daemon ocioso e CPU — 2026-11-09

## Causas
1. **Dois daemons:** eram daemons de teste órfãos (HOME isolado, execuções de `npm test` abortadas). Daemon com
   token http não tem autoencerramento por ociosidade, então nunca saem sozinhos.
2. **CPU parada:** com a pasta do perfil apagada, o `fs.watch` da pasta de config (daemon-ui) recebe `rename` em
   laço no Windows, sem `error`. Reprodução isolada em `watch.cjs`: o laço só termina fechando o watcher.
3. **Spawns de node:** nenhum harness instalado chama `token-guard.cjs` ou `post-hook.cjs` por chamada: Claude Code
   usa hooks `type: http`, Codex usa `mcp_tool` no servidor token-guard, e os dispatchers do Copilot não citam o
   token-guard. Os spawns vêm da suíte de testes: 13.076 / 302 ≈ 43 e 8.483 / 138 ≈ 61 execuções completas,
   compatível com 03/11 (dez releases, 2.16.0 a 2.17.0, cada uma com `npm test` local e gate). Os órfãos de
   `test/daemon-http-port.test.cjs` (pipe `token-guard-http-port-<pid>`) eram os dois daemons.

## Antes e depois (daemon com http, perfil apagado, 4 s de amostra)
- Antes: 3,48 s de CPU em 4 s. Depois: abaixo de 0,5 s (teste `daemon-idle-cpu.test.cjs`, 2 passaram).

## Spawns de uma execução completa de `npm test`
302 token-guard.cjs · 138 post-hook.cjs · 53 daemon-server.cjs · 36 prompt-hook.cjs · 28 hook-cmd.cjs ·
15 session-start.cjs · 5 subagent-start.cjs.

## Mudanças
- `daemon-ui.cjs`: watcher fecha se a pasta sumiu; batimento do stream só com clientes.
- `daemon-server.cjs`: ociosidade por `setTimeout` único reagendado.

## Como os docs anteriores foram aplicados
- Investigação do orquestrador: forneceu a amostra de CPU e a atribuição node←node.
- `tela-setup-bandeja-2026-10-30.md`: descreve o `fs.watch` da pasta de config e o stream da tela, onde está a causa.

## Hook http em conformidade com o hook-audit
- Fonte: documentação dos hooks do Claude Code (https://code.claude.com/docs/en/hooks, acesso 2026-11-09). O hook
  `type: "http"` aceita uma URL arbitrária e não restringe a query; o roteador do daemon ignora a query.
- A URL declara `hook-origin=token-guard` e `port-file=~/.token-guard/daemon-http.json`. A porta vem desse arquivo
  ou é uma porta livre escolhida pelo sistema; o daemon reescreve a URL a cada início. O código não tem porta padrão.
- O `hook-audit` do orchestrador lê a origem só de `--hook-origin=` num comando. Para o hook http ele precisa ler
  a query da URL e aceitar a porta quando o `port-file` declarado existe e registra a mesma porta.
- Um daemon com http só sai por ociosidade com `TOKEN_GUARD_DAEMON_IDLE_MS` explícito. A suíte define essa variável
  em `test/bootstrap.cjs`, então uma execução abortada não deixa órfão; o daemon do usuário não tem a variável.

## Prova da 2.19.1 no ambiente real (2026-11-10)
- Artefato: o tarball do `npm pack` (o mesmo que o `npm publish` envia), extraído e instalado com
  `init --target claude,codex`, os alvos registrados em `~/.token-guard/install-state.json`.
- Depois da instalação: o arquivo de execução e as três URLs do hook http têm a mesma porta, e a URL traz
  `hook-origin` e `port-file`. Um `ls -R` da sessão real foi barrado com a reescrita (`shellDump`). O servidor MCP
  instalado do Codex nega pelo `token_guard_hook`, e o daemon parado mediu 0 a 0,02 s de CPU em 3 s.
- O `hook-audit` do orchestrador lê a origem e o `port-file` da URL: os hooks http do token-guard saem com dono
  e sem porta literal.
- O hook `mcp_tool` não tem linha de comando, então a convenção do orchestrador (`src/hook-origin.mjs`, `IN_OUTPUT`)
  pede a origem no começo da saída de erro. A falha do `token_guard_hook` passou a começar com
  `[hook-origin=token-guard]`. O Codex trata erro de hook `mcp_tool` como falha do hook e deixa a chamada seguir
  (ver `refusal-hook-decisions-2026-10.md`), então o comportamento continua fail-open.

## Publicação da 2.19.1: pacote publicado e cópia instalada
- O `publish.yml` publicou com `npm publish --provenance` (149 arquivos; declaração de provenance no transparency log
  do sigstore). O `dist-tags.latest` passou a 2.19.1.
- O tarball do `npm pack` feito no checkout do Windows difere do publicado só no fim de linha. O checkout local tem
  `core.autocrlf=true` e grava CRLF; o CI em Linux empacota LF. Normalizado o fim de linha, o conteúdo é idêntico.
- Para a cópia instalada ser a publicada, a instalação final vem do registry pelo mesmo caminho do auto-update:
  `npx --yes @allansantos-dev/token-guard@<versão> init --target <alvos de install-state.json>`. Depois disso, todos
  os arquivos de código do runtime do Claude e do Codex são iguais byte a byte aos do pacote publicado.
- `agents/scout.agent.md` e `skills/token-economy/SKILL.md` na pasta de runtime do Claude não são reescritos, por
  desenho: `installUserAssets` (`install.cjs`) os trata como arquivos do usuário depois da primeira instalação, e só
  `--force` os atualiza.
