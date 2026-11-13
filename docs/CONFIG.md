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
`TOKEN_GUARD=warn` (aposentado) vale `block`: o guard nunca pergunta ao usuário, a recusa ensina a reescrita.

## Chaves

| Chave | Tipo / Default | Efeito |
|---|---|---|
| `mode` | `"block"` \| `"off"` | `block`: nega e injeta a reescrita · `off`: desliga. `"warn"` (aposentado) vale `block`. |
| `charsPerToken` | número, `4` | Razão caracteres→token usada nas estimativas da auditoria e do mcp-cost. 4 é a média para código/texto latino. |
| `contextWindow` | número, `200000` | Janela de referência dos relatórios ("janelas de contexto"). |
| `rules.noisePath` | boolean, `true` | Barra leitura dentro de diretórios de build/dependência e de saída (`tmp`, `logs`, `.cache`…); o `Read` de imagem ou PDF numa pasta de saída passa (é captura feita para ser vista). |
| `rules.blindRead` | boolean, `true` | Barra leitura de arquivo grande sem faixa de linhas (PDF: sem `pages`). Em PDF e Office, a recusa sugere o `read_document` do Smart Tool quando ele está instalado. |
| `rules.broadScan` | boolean, `true` | Barra glob sem escopo e grep conteúdo sem teto nem filtro. |
| `rules.shellDump` | boolean, `true` | Barra comando de shell que despeja árvore. |
| `rules.bigResult` | boolean, `true` | Pós-execução: resultado acima de `limits.resultCharsWithoutTrim` vira stub + integral em `.token-guard/results/`. |
| `rules.dupRead` | boolean, `true` | Releitura idêntica (arquivo inalterado, ≥ 2000 caracteres) é substituída por um stub que diz como reler com `offset/limit`. O registro por sessão é zerado quando o Claude Code compacta, limpa ou retoma a sessão. |
| `rules.scout` | boolean, `true` | Rajada de leituras/buscas sem edição sugere o subagente `scout` (um aviso por rajada). |
| `mode` | `"block"` ou `"off"`, `block` | O geral. `off` desliga em todos os IDEs. Também pela tela (`token-guard setup`). |
| `targets` | objeto, `{}` | Modo por IDE: `{"claude":"off"}` desliga só ali. Chaves: `claude`, `codex`, `cursor`, `copilot`, `mcp`; valores `block` ou `off`; ausente = segue o geral. Geral `off` vence. |
| `ui.tray` | boolean, `true` | Ícone na bandeja do Windows, subido pelo daemon. `false` fecha o ícone e impede que suba. |
| `limits.scoutBurst` | número, `8` | Quantas leituras/buscas seguidas formam a rajada. Medido: 6 → 470 rajadas em 7 dias; 8 → 256; 10 → 157. |
| `cost.prices` | objeto | Preço por modelo em US$/Mtok para `token-guard cost` e para o custo estimado no aviso de contexto pesado. A primeira chave contida no nome do modelo vence, então a mais específica vem antes, ex.: `{"opus-5-5":{"in":4,"out":20,"cacheRead":0.05},"opus":{"in":5,"out":25}}`. `cacheRead` é o fator de leitura de cache sobre `in` (padrão 0,1); `long: {from, in, out}` é a faixa cobrada na chamada inteira quando o prompt passa de `from` tokens. Sem a chave, vale a tabela padrão da página oficial de preços. O preço de entrada (`in`) do primeiro modelo da tabela converte os tokens poupados em US$ aproximados no `status` e na tela de setup (tabela padrão: Opus 5.5, US$ 4/Mtok). Premissa, não fatura; modelo sem preço é listado e não contado. |
| `limits.readBytesWithoutRange` | número, `51200` | Acima disso (50 KB), ler sem faixa é barrado. Imagem raster (`.png/.jpg/.jpeg/.gif/.webp`) fica de fora: o Read a entrega como imagem, sem linhas. PDF conta `pages` como faixa. Em `.ipynb`, `offset/limit` não contam (o Read do Claude Code os ignora); só `view_range`. |
| `limits.minRepoFilesForScanGuard` | número, `400` | Repos menores ficam livres dos guards de varredura. |
| `limits.resultCharsWithoutTrim` | número, `25000` | Acima disso (caracteres de texto), o resultado de ferramenta é truncado pós-execução. |
| `limits.resultTrimKeepChars` | número, `8000` | Quanto do resultado sobrevive no stub (cabeça + cauda; em shell, também as linhas de erro/falha do trecho cortado). |
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

## A tela de setup grava aqui

`token-guard setup` (ou o ícone da bandeja) abre a tela. Ela escreve **só** em `~/.token-guard/token-guard.config.json`
(`mode`, `targets`, `rules`, `ui.tray`), o último dos homes globais no merge; as outras chaves do arquivo ficam como estão.
Um `token-guard.config.json` dentro de um repositório continua mandando naquele repositório. Arquivo ilegível não é sobrescrito: a
tela mostra o erro. Você pode editar o arquivo à mão; a tela acompanha a mudança.

O registro do que foi barrado e poupado fica em `~/.token-guard/events.jsonl` (uma linha por evento, aparado acima de 2 MB).
O registro do que o contrato injetou fica em `~/.token-guard/injections.jsonl` (origem, motivo, seções, tamanho; aparado acima de 256 KB).

## `contract.skip`

`{ "contract": { "skip": ["codigo"] } }` tira seções inteiras do contrato (`sempre`, `codigo`, `teste`, `docs`, `subagente`)
para quem já recebe as mesmas regras pelas instruções do próprio usuário. Detalhe em `docs/CONTRACT.md`.

## Estado em disco (`.token-guard/`)

Diretório criado na raiz do projeto onde a sessão nasceu; entra no `.gitignore` no alvo `repo`. O agente navegar
depois para outra pasta não muda isso, e uma sessão aberta fora de projeto (Área de Trabalho, pasta do usuário,
AppData) grava o mesmo conteúdo na pasta de dados do usuário, nunca na pasta visitada.

| Arquivo | Quem escreve | Conteúdo |
|---|---|---|
| `repo-stats.json` | `token-audit` (ou a ferramenta `token_audit`) | Estatísticas do último scan. O guard lê para relaxar os guards de varredura em repos pequenos e calibrar mensagens. Corrompido = tratado como ausente. |
| `sessions/<id>.json` | camada do contrato (`lib/contract.cjs`) | Seções de contrato já injetadas por sessão (id sanitizado, ≤80 chars). Poda automática após 7 dias. |
| `sessions/<id>-touched.json` | pós-execução (`lib/contract.cjs`) | Caminhos que a sessão tocou (até 50) — a evidência dos gatilhos `codigo`/`teste`/`docs`. |
| `sessions/<id>-reads.json` | pós-execução (`lib/dupread.cjs`) | Hash das leituras da sessão (até 32 arquivos), para o dedupe de leitura. |
| `results/*.txt` | `bigResult` (`lib/postresult.cjs`) | **Cópia integral** da saída de ferramenta que foi truncada — o agente relê por faixa. Mantém as 50 mais recentes. |

Instalações de escopo máquina não adicionam `.gitignore` nenhum ao repositório —
se quiser ignorar localmente, adicione a linha por conta própria.
