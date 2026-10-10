# Referência de configuração

`token-guard.config.json` na raiz do repositório (ou nos homes globais listados abaixo).
Tudo é opcional: o que você omitir usa o default embutido em `lib/config.cjs`.
Um template comentado vive em `config.default.json`.

## Onde a config é procurada

1. Subindo a árvore a partir do diretório de trabalho do payload (até 12 níveis).
2. Se nada encontrado: globals mesclados na ordem `~/.copilot/` → `~/.claude/` →
   `~/.cursor/` → `~/.token-guard/` (o instalador só os grava quando você passa `--mode`;
   os alvos `codex` e `mcp` gravam em `~/.token-guard/`).
3. A config do repositório vence sobre as globais.

Escape hatch por ambiente (vence tudo): `TOKEN_GUARD=off` (ou `0`, `false`) desliga;
`TOKEN_GUARD=warn` degrada qualquer deny para "ask".

## Chaves

| Chave | Tipo / Default | Efeito |
|---|---|---|
| `mode` | `"block"` \| `"warn"` \| `"off"` | `block`: nega e injeta a correção · `warn`: pede confirmação mostrando a correção · `off`: desliga. |
| `charsPerToken` | número, `4` | Razão caracteres→token usada nas estimativas da auditoria e do mcp-cost. 4 é a média para código/texto latino. |
| `contextWindow` | número, `200000` | Janela de referência dos relatórios ("janelas de contexto"). |
| `rules.noisePath` | boolean, `true` | Barra leitura dentro de diretórios de build/dependência. |
| `rules.blindRead` | boolean, `true` | Barra leitura de arquivo grande sem faixa de linhas. |
| `rules.broadScan` | boolean, `true` | Barra glob sem escopo e grep conteúdo sem teto nem filtro. |
| `rules.shellDump` | boolean, `true` | Barra comando de shell que despeja árvore. |
| `rules.bigResult` | boolean, `true` | Pós-execução: resultado acima de `limits.resultCharsWithoutTrim` vira stub + integral em `.token-guard/results/`. |
| `rules.dupRead` | boolean, `true` | Registra o hash de cada leitura por sessão (dedupe de leitura; a substituição ainda não chega ao modelo — ver [BACKLOG](BACKLOG.md)). |
| `limits.readBytesWithoutRange` | número, `51200` | Acima disso (50 KB), ler sem faixa é barrado. Imagem raster (`.png/.jpg/.jpeg/.gif/.webp`) fica de fora: o Read a entrega como imagem, sem linhas. PDF conta `pages` como faixa. Em `.ipynb`, `offset/limit` não contam (o Read do Claude Code os ignora); só `view_range`. |
| `limits.minRepoFilesForScanGuard` | número, `400` | Repos menores ficam livres dos guards de varredura. |
| `limits.resultCharsWithoutTrim` | número, `25000` | Acima disso (caracteres de texto), o resultado de ferramenta é truncado pós-execução. |
| `limits.resultTrimKeepChars` | número, `8000` | Quanto do resultado sobrevive no stub (cabeça + cauda). |
| `noiseDirsExtra` | string[], `[]` | **Soma** aos defaults de diretórios de ruído. |
| `noiseDirs` | string[] | Substitui a lista inteira (use só para isso). |
| `sourceExtExtra` | string[], `[]` | **Soma** extensões contadas como código-fonte na auditoria. |
| `sourceExt` | string[] | Substitui a lista inteira. |
| `allowlist` | string[] | Substrings de caminho liberadas (case-insensitive) nas regras que julgam caminho — `noisePath` e `blindRead`. Não alcança `broadScan`/`shellDump`, que julgam escopo/teto da busca. |
| `$comment*` | qualquer | Ignorada pelo loader: convenção de comentário em JSON (`$comment`, `$comment_mode`, …). |

### Defaults embutidos

As listas completas de `noiseDirs` e `sourceExt` vivem em `lib/config.cjs`
(`DEFAULTS`) — fonte única da verdade. `config.default.json` é só o template
comentado que o instalador copia.

### Tipos inválidos

Uma chave com tipo errado (`"limits": null`, `"noiseDirs": 42`) não derruba a
config inteira nem desliga regras em silêncio: cada chave inválida volta ao
default individualmente.

## Estado em disco (`.token-guard/`)

Diretório criado na raiz do repositório; entra no `.gitignore` no alvo `repo`.

| Arquivo | Quem escreve | Conteúdo |
|---|---|---|
| `repo-stats.json` | `token-audit` (ou a ferramenta `token_audit`) | Estatísticas do último scan. O guard lê para relaxar os guards de varredura em repos pequenos e calibrar mensagens. Corrompido = tratado como ausente. |
| `sessions/<id>.json` | camada do contrato (`lib/contract.cjs`) | Seções de contrato já injetadas por sessão (id sanitizado, ≤80 chars). Poda automática após 7 dias. |
| `sessions/<id>-touched.json` | pós-execução (`lib/contract.cjs`) | Caminhos que a sessão tocou (até 50) — a evidência dos gatilhos `codigo`/`teste`/`docs`. |
| `sessions/<id>-reads.json` | pós-execução (`lib/dupread.cjs`) | Hash das leituras da sessão (até 32 arquivos), para o dedupe de leitura. |
| `results/*.txt` | `bigResult` (`lib/postresult.cjs`) | **Cópia integral** da saída de ferramenta que foi truncada — o agente relê por faixa. Mantém as 50 mais recentes. |

Instalações de escopo máquina não adicionam `.gitignore` nenhum ao repositório —
se quiser ignorar localmente, adicione a linha por conta própria.
