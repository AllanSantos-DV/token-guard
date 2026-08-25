# Contribuindo

Obrigado por querer melhorar o token-guard. Este projeto tem três princípios inegociáveis;
qualquer PR é lido à luz deles.

## Princípios

1. **Fail-open, sempre.** Um guard de economia jamais pode derrubar a sessão que ele
   deveria baratear. Qualquer erro interno → libera a chamada. Sem exceção.
2. **Zero dependências em runtime.** Só o que vem no Node. Isso é o que permite rodar
   dentro de harness empacotado, em máquina corporativa, sem `npm install`.
3. **Todo bloqueio ensina.** Nunca um `deny` cego: a razão devolvida precisa conter a
   alternativa barata, pronta para o agente reexecutar.

## Arquitetura

```
lib/            núcleo puro, agnóstico de IDE — NÃO conhece nenhum harness
  payload.cjs     normaliza o envelope de entrada de qualquer runtime
  rules.cjs       as quatro regras (broadScan, blindRead, noisePath, shellDump)
  decide.cjs      decide(payload) -> null | { decision, reason, rule }
  config.cjs      carrega token-guard.config.json subindo a árvore
  audit.cjs       medição de custo de contexto

adapters/       tradução de envelope. Uma camada fina por harness.
  copilot-cli.mjs   extensão in-process do Copilot CLI/App (SDK)
  hook-cmd.cjs      hook PreToolUse por linha de comando (Copilot CLI + Claude Code)
  cursor-hook.cjs   eventos beforeReadFile/beforeShellExecution/beforeMCPExecution
  mcp-server.cjs    MCP server stdio — fallback universal (advisory)
```

**Regra de ouro:** adapter nunca contém regra de negócio. Se você precisou colocar
lógica de decisão dentro de um adapter, ela pertence a `lib/`.

## Adicionando suporte a um novo IDE

1. Descubra o envelope de entrada e o contrato de saída do harness.
2. Se o envelope tiver campos novos, adicione o alias em `lib/payload.cjs` — não no adapter.
3. Crie `adapters/<harness>.cjs` fazendo apenas: ler payload → `decide()` → traduzir veredito.
4. Adicione o alvo em `install.cjs`: nome no array `VALID`, função no mapa `RUNNERS`.
5. Cubra o adapter em `test/adapters.test.cjs`.
6. Documente em `docs/IDES.md`.

## Rodando os testes

```bash
npm test                       # todas as suítes — cada uma imprime a própria contagem
node install.cjs --target all --dry-run
```

Não há framework de teste: os testes são Node puro, pelo mesmo motivo do princípio 2.
Cada suíte imprime a própria contagem — não confie em números hardcoded de README.

## Estilo

- CommonJS (`.cjs`) no núcleo e nos adapters de linha de comando; ESM (`.mjs`) só onde o
  harness exige.
- Comentários explicam **por quê**, não **o quê**.
- Mensagens ao usuário em pt-BR; nomes de símbolo em inglês quando for termo técnico.

## Commits

Formato convencional: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## Publicando no npm

O nome sem escopo (`token-guard`) pertence a outro autor no registry — o pacote
nosso é o **`@allansantos-dev/token-guard`** (escopo já configurado no
package.json com `"access": "public"`).

```bash
npm whoami                       # precisa estar logado como allansantos-dev
npm publish                      # publishConfig já força --access public
npx @allansantos-dev/token-guard@latest audit   # fumaça pós-publicação
```

Só publique a partir de uma tag de release (`v2.2.0`, `v2.3.0`…) e com
`npm test` verde.
