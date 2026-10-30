# Documento grande: quem é dono do redirect quando token-guard e Smart Tool coexistem — 2026-10-30

Análise de leitura, sem implementação das opções. O que foi implementado: a dica condicional do
`read_document` na recusa do `blindRead` (CHANGELOG 2.15.0).

Material usado: `docs/research/refusal-hook-decisions-2026-10.md` (token-guard: só o `deny` leva
texto ao agente; `ask` não funciona no Codex), `smart-tool/docs/research/2026-10-19-hook-redirect-transparente.md`
(redirect transparente em vez de bloqueio; coexistência de hooks no mesmo evento) e
`harness-padroes-cliente/docs/research/2026-10-28-fase-4-instalacao-real-medicao-fail-open.md`
(hook fora do ar = fail-open silencioso, com `gap` só no retorno do daemon).

## (a) Coexistência hoje, no mesmo evento

- Na máquina do dono os dois hooks http de `PreToolUse` casam `Read`: o do Smart Tool
  (`:8765/hooks/pretool`, matcher com `Read|Grep|Glob|Bash|…`) e o do token-guard
  (`:44448/token-guard/pre`, `Read|Grep|Glob|Bash|…`). Rodam em paralelo com o mesmo `tool_input`
  original; a regra documentada de conflito é só de decisão (`deny` > `defer` > `ask` > `allow`), e a
  combinação de `updatedInput` de hooks diferentes não é documentada (nenhum hook sabe o que o outro
  fez).
- O Smart Tool hoje **libera** `Read` sempre (`router.py:139`, "Reading a specific file is never
  replaced by semantic search"). Então o PDF grande sem `pages` é negado só pelo token-guard, e não há
  redirect duplo nem contraditório.
- O conflito real aparece se os dois passarem a tratar documento: o `deny` do token-guard vence o
  redirect do Smart Tool (decisão > reescrita). O agente receberia a recusa "passe `pages`" e a
  transparência do Smart Tool nunca dispararia; se o Smart Tool também negasse, o agente veria dois
  textos diferentes para a mesma leitura. Um redirect transparente de `Read` ainda dependeria de
  `PostToolUse` trocar a saída (Claude Code ≥ 2.1.121; o Codex não troca saída), com a leitura nativa
  rodando antes — a verificar na máquina antes de desenhar.
- Deny e redirect são opostos: por evento, um só dono.

## (b) Opção 1 — o hook do Smart Tool redireciona documento grande; token-guard sai de cena com o Smart Tool ativo

- Pontos de encaixe: `smartToolPresent` (já existe) vira o portão do `blindRead` para
  `.pdf/.docx/.pptx/.xlsx`; no Smart Tool, `router._mechanical_decision` deixa de liberar documento.
- Riscos: "registrado" não é "ativo". Se o daemon do Smart Tool está fora, o hook dele falha aberto
  (fail-open, doc da fase 4) e o token-guard, que se retirou, também não barra: o PDF de 200 páginas
  entra inteiro. No Codex o redirect é o `cat` de resposta (só `allow`), não substitui `Read`. Subagente
  sem a ferramenta do Smart Tool (`agent_has_smart_tool`) fica sem caminho. Quem tem só um produto não
  é afetado, mas quem tem os dois depende de um sinal de "ativo" que ninguém emite hoje.
- Esforço: Smart Tool M (regra, PostToolUse, testes nos dois harnesses); token-guard S.

## (c) Opção 2 — token-guard trata documento só quando o Smart Tool está ausente

- É a opção 1 vista do outro lado: com os dois instalados o token-guard cala. Mesmo buraco de cobertura
  quando o Smart Tool cai, e o mesmo requisito de um sinal de saúde. A variante em vigor (a que foi
  implementada) é diferente e mais simples: o token-guard **sempre** barra, e a mensagem muda conforme o
  Smart Tool exista; o Smart Tool é dono da ferramenta, o token-guard é dono do bloqueio. Não há
  redirect nem decisão duplicada.
- Riscos da variante em vigor: a dica cita uma ferramenta que o subagente pode não ter (o texto é
  condicional, "se estiver disponível"), e a detecção por arquivo de config não prova que o servidor está
  de pé. Ambos degradam para o texto de sempre (`pages`/`pdftotext`).
- Esforço: feito (S).

## (d) Opção 3 — conversor leve de documento no próprio token-guard

- Pontos de encaixe: novo `lib/doc2text.cjs` e um subcomando do CLI; a recusa passaria a dizer
  `token-guard doc "<arquivo>" --pages 1-5`.
- Viabilidade com zero dependências: `.docx/.pptx/.xlsx` são zip + XML, e `zlib` é da stdlib (leitor de
  zip e extração de `w:t`/`a:t`/células: S a M). PDF é outra ordem: streams Flate, fontes com ToUnicode,
  PDF escaneado, criptografado ou com layout em colunas dão texto ruim ou vazio (M a L, qualidade
  incerta), e o `pdftotext` não existe na máquina típica do Windows.
- Riscos: duplica o `read_document`, que ainda vai ganhar um agente leve de leitura; dois extratores
  divergem na contagem de tokens e no recorte de páginas. O token-guard é um guarda, não um leitor: a
  regra 3 dele é a recusa trazer a reescrita barata, e um leitor próprio muda o produto.
- Esforço: M (office) a L (PDF).

## Recomendação

1. Manter o que foi feito: o token-guard é o único dono do `deny` de leitura; o Smart Tool é dono da
   ferramenta (`read_document`) e a recusa só a cita quando ele está registrado.
2. Se o Smart Tool quiser redirecionar documento por conta própria, o token-guard só pode sair de cena
   com um sinal explícito de que o hook do Smart Tool está de pé (por exemplo um endpoint de saúde que o
   token-guard consulta com timeout curto, fail-open para "continue barrando"); presença no config não
   basta.
3. Não construir o conversor próprio (opção 3) agora: o `.docx/.pptx/.xlsx` é viável, mas o PDF, que é o
   caso real, não sai com qualidade sem dependência, e o Smart Tool já cobre o caso.
