# Scout com haiku × modelo atual — medição (P1) e falsos positivos do A34

Data: 2026-10-24. Decisão: **manter o modelo do scout** (herda o da conversa). Haiku não ficou equivalente.

## Método (P1)

- Precedência do modelo de um subagente: parâmetro da chamada → `model` do frontmatter →
  `CLAUDE_CODE_SUBAGENT_MODEL` → modelo da conversa. O `scout.agent.md` não fixa `model`, então hoje herda.
- 4 perguntas reais de investigação sobre este repositório, cada uma respondida uma vez por haiku e uma vez por
  sonnet, com o mesmo prompt (ler `agents/scout.agent.md` e seguir o formato dele), em paralelo, só leitura.
- Gabarito: eu li o código das respostas (`lib/ctxwatch.cjs`, `lib/dupread.cjs`, `adapters/daemon-server.cjs`,
  `lib/daemon-client.cjs`, `install.cjs`, `docs/INSTALL.md`) e conferi cada afirmação.
- Critério: o veredito responde a pergunta, os fatos conferem, e nenhuma resposta central falta.
- Limite declarado: n = 1 por célula (4 pares). Detecta diferença grande, não a pequena.

| Pergunta | haiku | sonnet | tokens (haiku / sonnet) | chamadas de ferramenta |
|---|---|---|---|---|
| A. limiares e anti-repetição do ctxwatch | correta (120k, +60k, estado por sessão, sem config) | correta, mesma resposta | 42,1k / 47,9k | 5 / 9 |
| B. ociosidade do daemon e descoberta do endpoint | correta | correta, separa melhor pipe e HTTP | 57,9k / 58,0k | 12 / 11 |
| C. critério e exceções do dupRead | correta, 7 exceções | correta, 9 exceções e acha que `checkRepeat` não tem chamador | 49,5k / 59,2k | 7 / 10 |
| D. como o install registra e remove hooks | **errada no ponto central**: "não existe desinstalação, não há como desinstalar" | correta: não há comando, mas `docs/INSTALL.md` "Desinstalando" lista o que remover | 45,7k / 49,9k | 13 / 11 |

Resultado: equivalente em A e B, ligeiramente mais rasa em C, e em D o haiku afirmou que não havia como
desinstalar sem abrir o `docs/INSTALL.md` (a pergunta pedia o que o uninstall remove). Uma resposta confiante e
errada sai mais cara de desfazer do que a economia do modelo. Diferença de tokens medida: de 0% a 12% a menos
com haiku; o preço por token menor do haiku não foi medido aqui.

Condição para voltar a medir: n ≥ 3 por pergunta e perguntas cuja resposta atravessa código e docs.

## Achado colateral (A35)

Os quatro scouts (dois haiku, dois sonnet) relataram que o `Read` de `agents/scout.agent.md` e de
`lib/dupread.cjs` voltou como stub `[dupRead] conteúdo idêntico…` sem que eles tivessem lido o arquivo antes.
Os subagentes compartilham o `sessionId` do pai e o `dupRead` guarda o hash por sessão: a leitura do pai (ou de um
irmão rodando em paralelo) faz o stub aparecer numa janela que nunca viu o conteúdo. Isso fere a razão de ser do
scout (janela própria). Fora do escopo desta entrega; anotado no `docs/BACKLOG.md`.

## A34 — falsos positivos e recall

Corpus: 68.147 comandos Bash/PowerShell distintos de 508 pastas de transcripts locais; 30.206 casam `grep`/`rg`.
Comparação guard 2.12.1 × corrigido (só o veredito do `shellDump` para busca de conteúdo).

| | antes | depois |
|---|---|---|
| comandos de busca negados | 5 | 6 |
| liberados pela correção | — | 0 |
| novos negados | — | 1: `rg -n 'NO_SUCH_TOKEN_QQZ'` (busca sem caminho nem teto, deny correto) |

A primeira versão negava 3 novos; dois eram `grep -rn "x" . | cut -d: -f1 | sort | uniq -c`, saída agregada
e barata que o antigo só liberava por acidente (tomava `uniq` por alvo). `uniq` entrou na lista de tetos
(`CAP_HINTS`) e os dois voltaram a passar.

Recall: as 8 fixtures novas de deny (`rg TODO`, `rg -n "x"`, `grep -r TODO`, `grep -rn "foo bar"`,
`rg -g '*.ts' TODO`, `rg -e A -e B`, `rg TODO 2>&1`, `rg TODO && echo done`) passavam no guard antigo; as 7 de
allow (padrão + diretório, glob + padrão + diretório, `-e` + diretório, padrão citado com espaço + diretório,
`git diff | rg TODO`, `grep -r TODO README.md`, `uniq -c`) passam nos dois.

Causa: o alvo era "o último argumento que não é flag", que sem caminho é o próprio padrão. Agora o alvo são os
argumentos posicionais menos o padrão (o primeiro, salvo `-e`/`-f`), pulando o valor das flags que o levam
(`-g`, `-t`, `-m`, `-A/-B/-C`, `--glob`…), com aspas respeitadas, e parando em pipe, redirect e `&&`.
Busca depois de um pipe filtra o stdin e segue liberada.
