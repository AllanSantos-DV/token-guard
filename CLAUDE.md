# token-guard

Economia de contexto para agentes de IA, agnóstico de IDE. Pacote npm `@allansantos-dev/token-guard`
(o nome sem escopo é de outro autor). Mede o custo real do repositório em tokens, barra as chamadas que
estouram a janela devolvendo sempre a alternativa barata, mede o preâmbulo dos servidores MCP e governa
o contrato de saída. Adapters para Copilot CLI/App, Claude Code (hook http servido pelo daemon), Codex,
Cursor e MCP. Página pública: https://allansantos-dv.github.io/token-guard/ (branch `gh-pages`).

## Princípios (inegociáveis)

1. **Fail-open.** Erro interno libera a chamada; o guard nunca derruba a sessão.
2. **Zero dependências em runtime.** Só a stdlib do Node (>= 16).
3. **Todo bloqueio ensina.** O `deny` traz a reescrita barata pronta; nunca pergunta ao usuário.

## Mapa

- `lib/` núcleo puro, sem conhecer harness: `rules.cjs` (broadScan, blindRead, noisePath, shellDump),
  `decide.cjs`, `postresult.cjs` (bigResult), `dupread.cjs`, `contract.cjs`, `audit.cjs`, `mcp-cost.cjs`,
  `cost.cjs`, `scout.cjs`, `update-check.cjs` (única saída de rede), `auto-update.cjs`,
  `daemon-*.cjs`, `claude-hooks.cjs`.
- `adapters/` tradução de envelope por harness, sem regra de negócio (ela vai para `lib/`).
  `daemon-server.cjs` + `daemon-http.cjs` formam o daemon residente.
- `cli.cjs` (bin), `install.cjs` (`init --target ...`), `token-audit.cjs`, `mcp-cost.cjs`, `cost.cjs`.
- `agents/scout.agent.md`, `skills/`, `contract.default.md`, `config.default.json`.
- `docs/` guias do usuário (INSTALL, CONFIG, IDES, COMO-FUNCIONA, TROUBLESHOOTING, CONTRACT) e
  `docs/BACKLOG.md` (itens abertos e fechados por release).

## Testes

`npm test` roda todas as suítes em sequência (Node puro, sem framework; cada suíte imprime a própria
contagem). Suíte isolada: `node test/<nome>.test.cjs`. `test/bootstrap.cjs` dá a cada suíte um SID e um
daemon próprios: os testes não falam com o daemon do usuário. Nunca derrube o daemon real
(`~/.token-guard`) para testar.

## Fluxo de release

- Trabalho nasce em `develop`. Release: suítes verdes + backlog sem item técnico aberto, depois
  `develop` avança por fast-forward para `main`.
- Versão em `package.json` + seção no `CHANGELOG.md`; tag `vX.Y.Z` criada **só em `main`**. O push da tag
  dispara `.github/workflows/publish.yml` (gate `npm test` + `npm publish --provenance` por OIDC). Não
  publique à mão.
- Cada tag ganha um GitHub Release com as notas da seção do CHANGELOG.
- Pages: editar `index.html` no branch `gh-pages` e dar push; só conteúdo de produto (o que é, para quem,
  como usa, números medidos), nunca fases, revisões, testes internos ou backlog.

## Estilo

CommonJS (`.cjs`); ESM só onde o harness exige. Mensagens ao usuário em pt-BR. Comentários dizem o porquê.
Commits convencionais (`feat:`, `fix:`, `docs:`, `chore:`).
