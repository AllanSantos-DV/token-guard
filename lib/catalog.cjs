'use strict';
/**
 * catalog.cjs — as regras e os IDEs em linguagem de gente, para a tela de setup.
 *
 * É só texto e metadados: quem decide continua sendo rules.cjs. Os `id` batem com as chaves de
 * `rules` da config e os `target` com `targets` (o teste trava essa correspondência, para a tela
 * nunca oferecer um botão que a config não entende).
 *
 * `kind` diz o que a regra faz na prática: "barra" (nega a chamada e entrega a reescrita barata),
 * "enxuga" (corta o resultado depois de executar e guarda o integral em disco) ou "sugere"
 * (só avisa o agente). Nenhuma regra pergunta ao usuário: o bloqueio ensina.
 */

const RULES = [
  {
    id: 'broadScan', kind: 'barra', phase: 'antes',
    title: 'Varredura sem foco',
    what: 'Barra buscas que olham o repositório inteiro sem dizer onde, como listar todos os arquivos com "**/*".',
    why: 'Uma varredura assim devolve milhares de caminhos e enche a conversa à toa.',
    example: {
      tried: 'Glob  "**/*"',
      does: 'Barra e devolve a busca barata: o mesmo Glob limitado à pasta e ao tipo de arquivo que importam.',
    },
  },
  {
    id: 'blindRead', kind: 'barra', phase: 'antes',
    title: 'Leitura às cegas',
    what: 'Barra a leitura de um arquivo grande inteiro, sem dizer qual trecho interessa.',
    why: 'Quase sempre só um pedaço importa; o resto é custo repetido a cada mensagem seguinte.',
    example: {
      tried: 'Read  logs/app.log  (400 KB, sem faixa de linhas)',
      does: 'Barra e ensina a achar o trecho com uma busca e depois ler só as linhas ao redor.',
    },
  },
  {
    id: 'noisePath', kind: 'barra', phase: 'antes',
    title: 'Pasta de ruído',
    what: 'Barra leituras e buscas dentro de pastas que ninguém lê de propósito: node_modules, dist, build, .git e parecidas.',
    why: 'Código gerado ou de terceiros é enorme e quase nunca responde à pergunta.',
    example: {
      tried: 'Grep  "init"  em node_modules/',
      does: 'Barra e mostra como buscar no código do projeto, ou como olhar a dependência específica.',
    },
  },
  {
    id: 'shellDump', kind: 'barra', phase: 'antes',
    title: 'Comando que despeja tudo',
    what: 'Barra comandos de terminal cuja saída não tem limite, como listar a árvore inteira de pastas.',
    why: 'A saída inteira entra na conversa; um teto no comando resolve sem perder o que interessa.',
    example: {
      tried: 'Bash  ls -R .',
      does: 'Barra e devolve a listagem com teto, por exemplo ls <pasta> | head -50.',
    },
  },
  {
    id: 'bigResult', kind: 'enxuga', phase: 'depois',
    title: 'Resultado gigante',
    what: 'Quando uma ferramenta devolve um texto enorme, deixa só o começo e o fim na conversa e guarda o resto em um arquivo.',
    why: 'O texto inteiro seria relido a cada nova mensagem. O arquivo guardado continua à mão se for preciso.',
    example: {
      tried: 'Uma busca que devolveu 80 mil caracteres',
      does: 'Entrega o começo e o fim, e o caminho do arquivo com o resultado completo.',
    },
  },
  {
    id: 'dupRead', kind: 'enxuga', phase: 'depois',
    title: 'Arquivo lido de novo',
    what: 'Quando o mesmo arquivo grande é lido outra vez sem ter mudado, troca a segunda cópia por um aviso curto.',
    why: 'A primeira leitura já está na conversa; repetir só gasta espaço.',
    example: {
      tried: 'Read  src/app.js  de novo, idêntico ao de antes',
      does: 'Troca o conteúdo repetido por "idêntico à leitura anterior".',
    },
  },
  {
    id: 'scout', kind: 'sugere', phase: 'depois',
    title: 'Sugestão do scout',
    what: 'Depois de várias leituras seguidas sem editar nada, sugere ao agente usar o scout: um ajudante que investiga e devolve só a conclusão.',
    why: 'A investigação toda acontece fora da conversa principal, que fica leve.',
    example: {
      tried: '8 leituras e buscas seguidas, sem nenhuma edição',
      does: 'Avisa o agente que o scout resolve essa fase sem encher a conversa. Não barra nada.',
    },
  },
];

const TARGETS = [
  { id: 'claude', title: 'Claude Code', coverage: 'Barra e enxuga. Todas as regras valem.' },
  { id: 'codex', title: 'Codex', coverage: 'Barra comandos de terminal (o Codex lê arquivos pelo terminal). Precisa estar aprovado em /hooks.' },
  { id: 'cursor', title: 'Cursor', coverage: 'Barra no Cursor recente. No Cursor CLI, só comandos de terminal.' },
  { id: 'copilot', title: 'Copilot', coverage: 'Barra e enxuga no Copilot CLI e no Copilot App.' },
  { id: 'mcp', title: 'Outros IDEs (MCP)', coverage: 'Não consegue barrar: só orienta, quando o agente consulta o token-guard.' },
];

module.exports = { RULES, TARGETS };
