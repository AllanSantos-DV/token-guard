# Troubleshooting

## Instalei mas o guard não bloqueia nada

1. **Reinicie a sessão do agente.** Hooks carregam no boot da sessão.
2. **Repositório pequeno?** Abaixo de `limits.minRepoFilesForScanGuard` (400
   arquivos) os guards de varredura ficam de propósito — rode
   `npx token-guard audit` uma vez para calibrar com o número real.
3. **A ferramenta entra nas famílias vigiadas?** O casamento é por família
   (`read`/`grep`/`glob`/`shell`), não por nome exato — veja `lib/rules.cjs`.
4. Confira: `npx token-guard status`.

## Instalei um upgrade e o guard sumiu

Registro antigo apontando para script que não existe mais era mascarado como
"já registrado" em versões anteriores. Reinstale — versões atuais **reparam** o
registro obsoleto e avisam (`registro obsoleto reparado`).

## Meu `--mode warn` não está valendo (bloqueia mesmo assim)

Em versões anteriores, a config global gravada em `~/.claude/`, `~/.cursor/` ou
`~/.token-guard/` nunca era lida (só `~/.copilot/`). Atualize: o loader agora lê
os quatro homes. Conferência imediata: `npx token-guard status` mostra `_source`.

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
inválido na config do repo cai nos defaults **e diz isso** em `npx token-guard status`.
Chave com tipo errado volta ao default individual (não derruba as demais).

## Windows corporativo: tudo parece lento

O piso do spawn de Node domina (antivírus). Meça:
`node bench/latency.cjs` — compare hook vs `node -e "0"`. Se o custo for do
runtime, prefira o modo plugin (in-process) ou confie no `matcher` do hooks.json.
