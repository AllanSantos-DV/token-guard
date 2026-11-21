/**
 * Gera boards/transcript-sessao.json: board narrado (VXK, modo board) com o resultado da análise "o token-guard
 * pode danificar o transcript da sessão?". Rodar: node boards/transcript-sessao.gen.mjs && node ~/.vxk/bin/vxk.mjs build boards/transcript-sessao.json --out boards/transcript-sessao.html
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const D = '2026-11-19';
const REC = 'Nenhuma mudança no token-guard; seguir a investigação no Claude Code';
const OPCOES = [
  { rotulo: `${REC} (recomendado)`, descricao: 'Recomendado. O token-guard só lê o transcript, provado no código e medido numa cópia. Nenhum código nem versão muda; a investigação segue no Claude Code (fechamento e desligamento do Windows) e nos outros produtos da lista.' },
  { rotulo: 'Adicionar uma trava defensiva de leitura', descricao: 'Acrescentar ao token-guard uma checagem que pula o transcript quando o arquivo está sendo gravado. Não resolve nada medido, porque a leitura já não bloqueia nem altera o arquivo; só acrescenta código e risco.' }
];
const opJson = `<script type="application/json" id="orq-opcoes">${JSON.stringify(OPCOES).replace(/</g, '\\u003c')}</script>`;

const CSS = `<style>
.tg{--ink:#eef2fb;--mut:#a9b4cc;--ln:#2b3553;--card:#121b33;--ok:#4be3b5;--c:#7aa7ff;color:var(--ink)}
.tg-s{border:1px solid var(--ln);border-top:6px solid var(--c);border-radius:16px;padding:22px 26px;background:#0c1222;margin:6px 0}
.tg-h h3{margin:0 0 6px;font-size:24px}.tg-h p{margin:0 0 10px;color:var(--mut);font-size:16px}
.tg-g{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.tg-c{background:var(--card);border:1px solid var(--ln);border-left:6px solid var(--k,var(--c));border-radius:12px;padding:12px 16px;font-size:16px;line-height:1.5}
.tg-c b.t{display:block;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-bottom:4px}
.tg-rec{margin-top:12px;border-radius:12px;padding:12px 16px;background:#13261f;border:1px solid #2f6b55;font-size:17px}
@media (max-width:760px){.tg-g{grid-template-columns:1fr}}
</style>`;
const card = (t, x, k = 'var(--c)') => `<div class="tg-c" style="--k:${k}"><b class="t">${t}</b>${x}</div>`;
const scene = (cor, titulo, sub, corpo) =>
  `${CSS}<div class="tg"><section class="tg-s" style="--c:${cor}"><header class="tg-h"><h3>${titulo}</h3><p>${sub}</p></header>${corpo}</section></div>`;

const blocks = [];
blocks.push({ type: 'hero', kicker: `token-guard · análise somente leitura · 19/11/2026`,
  title: 'O token-guard pode danificar o transcript da sessão? Não.',
  subtitle: 'Todo caminho do produto que toca o arquivo foi listado com arquivo e linha. Só dois abrem o transcript, os dois só para leitura, e uma medição numa cópia isolada não achou nenhum efeito.',
  say: 'A pergunta era se o token-guard pode danificar o arquivo de transcript da sessão do Claude Code, aquele que gera o aviso de arquivo ausente ou danificado. A resposta é não. Eu listei todos os caminhos do produto que tocam esse arquivo. Só dois o abrem, e os dois abrem só para leitura. Uma medição numa cópia isolada confirmou que a leitura não muda nada.' });

blocks.push({ type: 'html', html: scene('#4be3b5', 'Os caminhos que tocam o transcript', 'Nenhum escreve, anexa, trunca, move, renomeia, apaga, trava ou restaura o arquivo.',
  `<div class="tg-g">
${card('lib/ctxwatch.cjs:30-34', 'Lê até 512 KiB do fim, abertura somente leitura, fecha no finally. Roda a cada prompt, com o Claude vivo.', 'var(--ok)')}
${card('lib/cost.cjs:126', 'Lê o arquivo em blocos, somente leitura, fecha no finally. Roda só sob demanda: comando cost ou tela do daemon.', 'var(--ok)')}
${card('lib/cost.cjs:210-237 e adapters/daemon-ui.cjs:136', 'Só lista a pasta e olha data e tamanho; a tela do daemon chama o mesmo leitor em outro processo.', 'var(--ok)')}
${card('bench/replay-transcripts.cjs:81', 'Leitura inteira, manual, só quando o mantenedor roda o replay.', 'var(--ok)')}
${card('lib/claude-hooks.cjs:71 e lib/sessions-alive.cjs:22-28', 'Repassa o caminho sem abrir; lista a pasta de sessões e testa se o processo existe (sinal zero).', 'var(--ok)')}
${card('Encerramento de processo', 'Só o próprio daemon: lib/daemon-client.cjs:344 e adapters/daemon-server.cjs:494. Nunca o claude, nunca por nome.', 'var(--ok)')}
</div>`),
  say: 'Os caminhos. O aviso de peso de contexto lê o final do arquivo, em modo somente leitura, a cada prompt. O comando de custo lê o arquivo inteiro, também só leitura, e só roda quando alguém pede. O resto só lista pastas ou repassa o caminho sem abrir. Os únicos encerramentos de processo são do próprio daemon do token-guard, nunca do Claude. As escritas em pasta do Claude são só o arquivo de configuração de hooks e o agente scout, nunca um transcript.' });

blocks.push({ type: 'html', html: scene('#7aa7ff', 'Medição numa cópia isolada', 'Transcript real de 384.828 bytes copiado para pasta temporária; código real do produto.',
  `<div class="tg-g">
${card('Leitura isolada', 'Hash SHA-256 e data de modificação idênticos antes e depois.')}
${card('Leitura contra escrita', '1.205 leituras em 3 s enquanto outro processo anexava 161.580 linhas: 0 erros, cauda byte a byte igual, prefixo com o mesmo hash.')}
${card('Sem trava', 'Com um leitor aberto, renomear o arquivo e voltar funcionou: o produto não prende o arquivo.')}
${card('Causa mais provável', 'Bytes nulos de gravação interrompida por desligamento inesperado do Windows e cadeia quebrada, ambos gerados pelo próprio Claude Code. Verificado só nesta máquina.')}
</div>`),
  say: 'A medição. Copiei um transcript real para uma pasta temporária e usei o código real do produto. A leitura isolada não mudou o hash nem a data do arquivo. Com um processo lendo em laço e outro anexando mais de cento e sessenta mil linhas, não houve erro e a cauda ficou idêntica. Um leitor aberto não impediu renomear o arquivo, então não há trava. O dano que a pesquisa do Agent Launcher encontrou tem outra assinatura, de gravação interrompida pelo desligamento do Windows, e vem do próprio Claude Code. Isso só foi verificado nesta máquina.' });

blocks.push({ type: 'html', html: scene('#ffc15e', 'Recomendação', 'Duas opções; a primeira é a recomendada.',
  `<div class="tg-g">
${OPCOES.map((o, i) => card(`Opção ${i + 1}${i === 0 ? ' · recomendada' : ''}`, `<b>${o.rotulo.replace(' (recomendado)', '')}</b><br>${o.descricao.replace(/^Recomendado\. /, '')}`, i === 0 ? 'var(--ok)' : 'var(--c)')).join('\n')}
</div>
<div class="tg-rec"><b>Recomendação:</b> ${REC}.</div>
${opJson}`),
  say: 'A decisão. Recomendo a primeira opção: nenhuma mudança no token-guard e seguir a investigação no Claude Code, no fechamento da sessão e no desligamento do Windows. A segunda opção seria acrescentar uma trava defensiva de leitura, mas a leitura já não bloqueia nem altera o arquivo, então só acrescentaria código e risco. A escolha é sua.' });

blocks.push({ type: 'table', title: 'De onde vem cada afirmação', head: ['Afirmação', 'Fonte', 'Endereço', 'Acessado em'],
  rows: [
    ['Caminhos que abrem o transcript e modo de abertura', 'Código do token-guard na branch develop', 'file:token-guard/lib/ctxwatch.cjs; file:token-guard/lib/cost.cjs', D],
    ['Kill só do daemon próprio, com pid provado', 'Código do token-guard', 'file:token-guard/lib/daemon-client.cjs; file:token-guard/adapters/daemon-server.cjs', D],
    ['Medição na cópia isolada', 'Script rodado nesta máquina', 'file:token-guard/docs/research/token-guard-e-o-transcript-da-sessao.md', D],
    ['Assinatura do dano (bytes nulos, parentUuid órfão) e desligamento de 13/11', 'Pesquisa do Agent Launcher', 'file:agent-launcher/docs/research/2026-11-18-aviso-de-sessao-danificada.md', D],
    ['Issues do Claude Code sobre o mesmo dano', 'GitHub anthropics/claude-code (lidas pela pesquisa do launcher em 18/11/2026)', 'https://github.com/anthropics/claude-code/issues/49876; https://github.com/anthropics/claude-code/issues/21617', '2026-11-18']
  ],
  say: 'Por fim, as fontes: o código do token-guard na branch develop, a medição registrada na pasta de pesquisa do projeto, e a pesquisa do Agent Launcher com as issues do Claude Code sobre o mesmo dano.' });

const board = { engine: 'vxk', mode: 'board', title: 'token-guard e o transcript da sessão: pode danificar?', slug: 'token-guard-transcript-sessao',
  badge: `VXK · board · token-guard · transcript da sessão · 19/11/2026`, accent: '#4be3b5', language: 'pt-BR', narrate: true,
  voice: 'pt-BR-Chirp3-HD-Iapetus', voiceStrict: true, audioFormat: 'mp3',
  labels: { explain: '▶ Apresentar', pause: '⏸ Pausar', resume: '▶ Continuar', prev: '◀ Anterior', next: 'Próximo ▶', index: '☰ Índice', indexTitle: 'Tópicos', indexClose: 'Fechar' },
  blocks };
writeFileSync(join(HERE, 'transcript-sessao.json'), JSON.stringify(board, null, 2) + '\n');
console.log(`${blocks.length} blocos`);
