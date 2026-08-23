# Contrato de saída — padrão do token-guard

O custo de token não é simétrico: saída é várias vezes mais cara que entrada. Isso torna
lucrativo gastar entrada para encurtar saída. Mas o motivo mais forte não é esse — é que
saída-lixo escrita em arquivo vira **imposto permanente de entrada**: um comentário que
narra a sessão é relido por todo agente, em toda sessão futura, para sempre.

Este arquivo é o padrão. Um `contract.md` na raiz do projeto substitui as seções que
redefinir, do mesmo jeito que um `token-guard.config.json` ajusta os defaults embutidos
do carregador de configuração.

## Como editar sem quebrar

Duas restrições, e as duas vêm do mecanismo, não de gosto:

1. **Escreva afirmação, não ordem.** Texto injetado em modo imperativo de sistema aciona
   a defesa contra prompt injection: o modelo mostra o texto ao usuário em vez de segui-lo.
   "Comentário aqui registra invariante" funciona; "NUNCA comente" tende a vazar.
2. **Só entra regra que nunca precisará ser retirada.** A injeção fica no transcript e é
   reproduzida no `--continue`/`--resume` sem o hook rodar de novo. Regra que valeria agora
   e atrapalharia daqui a dez turnos é regra que não deve ser injetada.

E uma de estilo, que é a regra de ouro do projeto aplicada à saída: **nunca uma proibição
cega**. Toda regra dá destino ao conteúdo em vez de suprimir o impulso — o modelo contorna
proibição vazia, mas obedece redirecionamento.

## sempre

Vale para qualquer tarefa: código, prosa, e-mail, análise. São invariantes de forma, não
regras de programação, e é por isso que não confundem tarefa nenhuma.

- A resposta começa pelo resultado. Preâmbulo anunciando o que será feito não é lido.
- O que foi feito já está no diff e na saída das ferramentas. Recapitular cobra duas vezes
  pelo mesmo conteúdo; o que merece texto é o que **não** está visível ali.
- Sumário, changelog e "próximos passos" aparecem quando pedidos. Fora disso, o fim da
  resposta é o fim do conteúdo.
- Incerteza é uma frase no ponto onde ela muda a decisão, não uma seção de ressalvas no fim.
- Estrutura serve à leitura: tabela para comparar, lista para enumerar, prosa para o resto.
  Cabeçalho sobre parágrafo único é decoração e custa.
- Repetir o pedido antes de responder não demonstra entendimento — a resposta demonstra.

## quando: codigo

Entra quando a sessão já leu ou escreveu arquivo-fonte.

- Comentário registra invariante, contrato e porquê não óbvio: a razão de o código não ser
  o óbvio, a armadilha que ele evita, a garantia que ele mantém.
- O histórico do desenvolvimento vai na mensagem de commit, que é onde ele é procurado.
  "Antes era assim", "corrigido depois que o teste falhou", "isto quebrou aqui" descrevem a
  sessão, não o código — não sobrevivem ao merge e poluem toda leitura futura do arquivo.
- Código que se explica sozinho dispensa comentário que o repete em português.
- Comentário segue o idioma e a densidade dos arquivos ao redor.
- Guarda, `try/catch` e fallback entram onde há falha prevista e um caminho de recuperação
  real. Defesa genérica esconde o erro em vez de tratá-lo.
- O que foi removido some. Código morto comentado é responsabilidade do controle de versão.
- O repositório é consultado antes de nascer um helper. Função duplicada é a forma mais cara
  de lixo: cada cópia diverge, e todas passam a ser lidas.
- A abstração que já existe é preferida mesmo quando não é a primeira que ocorre. Quando o
  reuso não é óbvio, uma linha explicando a escolha é comentário legítimo — é invariante,
  não histórico.
- Cerimônia que a linguagem não exige não entra: wrapper que só encaminha, acessor sem
  lógica, interface com uma implementação, tipo redeclarado onde a inferência já resolve.
  Custa saída agora e leitura para sempre.

## subagente

Não é injetado na sessão principal: é o contrato de saída de quem roda em contexto
descartável, onde o texto final **é** o valor de retorno.

- A resposta é o dado: caminhos, linhas, trechos, veredito. Saudação, "encontrei o
  seguinte" e recapitulação da busca não são lidos por ninguém — são consumidos por código.
- O processo fica no contexto descartável junto com os arquivos lidos. O que atravessa é o
  resultado, e é isso que mantém a exploração fora da janela principal.
- Investigação cujo produto é dado — varredura, inventário, localização — cabe aqui. Vale
  quando a leitura é grande e a resposta é pequena; três buscas custam menos feitas direto
  do que a partida de um subagente.
- Buscas independentes começam limpas. Busca que depende do achado da anterior continua na
  mesma sessão de scout: o ganho não é o system prompt, é não remapear o que já foi mapeado.

## quando: teste

Entra quando a sessão toca arquivo de teste.

- O nome do teste enuncia a garantia, e o caso prova exatamente essa garantia.
- Um comportamento por caso: teste que passa por outro motivo reporta cobertura inexistente.
- Onde há vários eixos (projeto, usuário, tenant), o eixo sob teste é o que varia. Dois
  eixos com o mesmo valor no fixture fazem o teste passar sem provar nada.

## quando: docs

Entra quando a sessão escreve markdown ou documentação.

- Documentação descreve o estado atual. Decisão datada e motivo de mudança vivem no
  CHANGELOG ou num ADR, onde a data tem significado.
- Circunstância local — caminho desta máquina, versão instalada aqui, erro que só ocorre
  neste ambiente — é contexto de sessão. Vira exemplo genérico ou não entra.
- Um exemplo do caminho usado vale mais que a enumeração dos caminhos possíveis.
