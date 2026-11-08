/**
 * Gera boards/backlog-l6-l7-l8.json: board narrado (VXK, modo board) com a decisão do dono sobre L6, L7 e L8
 * de docs/BACKLOG.md. Números de exemplo medidos nesta máquina em 2026-11-08 (lib/events.cjs:summary, cost.cjs).
 * Rodar: node boards/backlog-l6-l7-l8.gen.mjs && node ~/.vxk/bin/vxk.mjs build boards/backlog-l6-l7-l8.json --out boards/backlog-l6-l7-l8.html
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const D = '2026-11-08';

const REC = 'Construir L7 e L6; L8 só com o rótulo explícito de estimativa';
const OPCOES = [
  { rotulo: `${REC} (recomendado)`, descricao: 'Recomendado. cost --here mostra o custo só deste repositório; status passa a mostrar barrados e tokens poupados (hoje e total); o valor em US$ aparece sempre com a palavra estimativa e a conta usada (tokens × preço de entrada de cost.prices).' },
  { rotulo: 'Construir L7 e L6; não construir L8', descricao: 'cost --here e a economia no status entram; a tela de setup e o status continuam só com tokens, sem valor em dinheiro.' },
  { rotulo: 'Construir só L7', descricao: 'Só cost --here entra. O status segue mostrando só a configuração; a economia continua só na tela de setup e no ícone.' },
  { rotulo: 'Construir só L6', descricao: 'Só a economia no status entra. cost continua somando todos os projetos, sem filtro pelo repositório atual.' },
  { rotulo: 'Não construir nenhum agora', descricao: 'A 2.18.2 sai como está. Os três itens ficam no backlog como decididos (não feitos).' }
];
const opJson = `<script type="application/json" id="orq-opcoes">${JSON.stringify(OPCOES).replace(/</g, '\\u003c')}</script>`;

const CSS = `<style>
.tg{--ink:#eef2fb;--mut:#a9b4cc;--ln:#2b3553;--card:#121b33;--ok:#4be3b5;--am:#ffc15e;--bad:#ff7a6b;--c:#7aa7ff;color:var(--ink)}
.tg-s{border:1px solid var(--ln);border-top:6px solid var(--c);border-radius:16px;padding:22px 26px;background:#0c1222;margin:6px 0}
.tg-h{display:flex;gap:14px;align-items:center;margin-bottom:10px}
.tg-no{font:700 15px/1 system-ui;background:var(--c);color:#0c1222;border-radius:10px;padding:8px 11px}
.tg-h h3{margin:0;font-size:24px}.tg-h p{margin:4px 0 0;color:var(--mut);font-size:16px}
.tg-g{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}
.tg-c{background:var(--card);border:1px solid var(--ln);border-left:6px solid var(--k,var(--c));border-radius:12px;padding:12px 16px;font-size:16.5px;line-height:1.5}
.tg-c b.t{display:block;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin-bottom:4px}
.tg-term{background:#060a14;border:1px solid var(--ln);border-radius:12px;padding:14px 18px;font:15px/1.55 ui-monospace,Consolas,monospace;white-space:pre;overflow-x:auto;color:#cfd8ea}
.tg-term .n{color:var(--ok);font-weight:700}
.tg-cap{color:var(--mut);font-size:14px;margin:6px 0 0}
.tg-rec{margin-top:12px;border-radius:12px;padding:12px 16px;background:#13261f;border:1px solid #2f6b55;font-size:17px}
@media (max-width:760px){.tg-g{grid-template-columns:1fr}}
</style>`;

const card = (t, x, k = 'var(--c)') => `<div class="tg-c" style="--k:${k}"><b class="t">${t}</b>${x}</div>`;
const scene = (no, cor, titulo, sub, corpo) =>
  `<div class="tg"><section class="tg-s" style="--c:${cor}"><header class="tg-h"><span class="tg-no">${no}</span><div><h3>${titulo}</h3><p>${sub}</p></div></header>${corpo}</section></div>`;

const blocks = [];

blocks.push({ type: 'hero', kicker: `token-guard · backlog aberto · ${D.split('-').reverse().join('/')}`,
  title: 'Três itens que mudam o que você vê no token-guard: quais construir?',
  subtitle: 'L6 (economia no status), L7 (custo só deste repositório) e L8 (economia em dólares estimados). Para cada um: o que você veria, o que muda no uso, custo e risco, e uma recomendação. No fim, as opções.',
  say: 'Esta página pede uma decisão sua sobre o token-guard. Há três itens abertos no backlog, e os três mudam o que você vê, por isso não entram sem você. O L seis mostra no comando status quantas chamadas foram barradas e quantos tokens foram poupados. O L sete faz o comando cost mostrar o custo só do repositório onde você está. E o L oito mostra os tokens poupados também em dólares, sempre como estimativa. Para cada um, vou mostrar o que você veria, o que muda no uso, o custo e o risco, e a minha recomendação. No fim, as opções. Aperte Apresentar e a página passa sozinha, com voz; o índice leva a qualquer tópico e a velocidade se ajusta.' });

blocks.push({ type: 'backlog', title: 'Backlog aberto: 3 itens que dependem de você', source: 'token-guard/docs/BACKLOG.md, seção “Candidatos da lente irmã (2.18.2)” (somente lido)',
  items: [
    { title: 'L6 · token-guard status mostra barrados e tokens poupados (hoje e total)', badge: 'Decidir',
      explicacao: 'Hoje o status mostra só a configuração (modo, regras, daemon, hook). Quantas chamadas foram barradas e quantos tokens foram poupados só aparecem na tela de setup e no ícone da bandeja. A proposta acrescenta duas linhas ao status com esses números, os mesmos da tela de setup.',
      recomendacao: 'Construir. Os números já são calculados (lib/events.cjs); é só mostrar no terminal o que a tela já mostra. Não muda nenhuma regra. Precedente: o RTK mostra a economia no próprio terminal (rtk gain), com divisão por dia.',
      fontes: [{ url: 'https://www.rtk-ai.app/docs/analytics/gain/', acessadoEm: D, titulo: 'RTK: rtk gain, economia de tokens no terminal' }] },
    { title: 'L7 · token-guard cost --here: custo só das sessões deste repositório', badge: 'Decidir',
      explicacao: 'Hoje o cost soma todos os projetos da máquina: o total de um dia mistura orchestrador, vox-engine, token-guard e o resto. Com --here, ele conta só as sessões cuja pasta de trabalho fica dentro do repositório onde você roda o comando.',
      recomendacao: 'Construir primeiro. O cost já guarda a pasta de cada sessão; falta só o filtro. Sem --here, nada muda. Precedente: o ccusage filtra o custo por projeto (--project) e agrupa por projeto (--instances).',
      fontes: [{ url: 'https://ccusage.com/guide/cli-options', acessadoEm: D, titulo: 'ccusage: opções --project e --instances' }] },
    { title: 'L8 · Tokens poupados também em US$ estimados (setup e status)', badge: 'Decidir',
      explicacao: 'Ao lado de “tokens poupados”, um valor em dólares: tokens poupados × preço de entrada do modelo, da mesma tabela cost.prices do token-guard cost. É estimativa sobre estimativa: os tokens já são estimados (4 caracteres por token) e o preço real depende do cache.',
      recomendacao: 'Construir só com o rótulo explícito de estimativa e a conta usada visível. Sem o rótulo, não construir. Pelo preço oficial, o mesmo token custa 20 vezes menos lido do cache; o RTK avisa que tokens poupados não viram economia igual na conta.',
      fontes: [
        { url: 'https://platform.claude.com/docs/en/about-claude/pricing', acessadoEm: D, titulo: 'Anthropic: preços (Opus 5.5 US$ 4/Mtok de entrada, cache lido 0,05×)' },
        { url: 'https://www.rtk-ai.app/docs/resources/savings-explained/', acessadoEm: D, titulo: 'RTK: como a economia chega (ou não) à conta' }
      ] }
  ],
  say: 'Este é o backlog aberto: três itens, todos esperando a sua decisão. L seis: o status mostrar as chamadas barradas e os tokens poupados, hoje e no total; recomendo construir. L sete: o cost com a opção here, que conta só as sessões deste repositório; recomendo construir primeiro. L oito: os tokens poupados também em dólares estimados; recomendo construir só com o rótulo explícito de estimativa. Agora, item por item.' });

blocks.push({ type: 'html', html: CSS + scene('L6', '#7aa7ff', 'L6 · A economia no token-guard status', 'Os números que hoje só estão na tela de setup e no ícone, também no terminal.',
  `<div class="tg-term">  token-guard · C:\\…\\Projetos\\token-guard
  ──────────────────────────────────────────
  modo:            block
  regras ativas:   broadScan, blindRead, noisePath, shellDump, bigResult, dupRead, scout
  daemon (http):   porta 44448 · ok
<span class="n">  barrados:        hoje 2 · total 102 (desde 30/10)
  tokens poupados: hoje ~44k · total ~1,2M</span></div>
<p class="tg-cap">As duas linhas em verde são o que entra. Números medidos nesta máquina hoje; o texto exato fica para a construção.</p>
<div class="tg-g">
${card('O que muda no uso', 'Quem usa só o terminal (Codex, Cursor, CI) vê a economia sem abrir a tela de setup. Quem já usa a tela vê o mesmo número nos dois lugares.')}
${card('O que conta como barrado', 'Toda recusa do token-guard é um <b>deny que ensina</b>: a chamada não roda e o agente recebe a alternativa barata pronta. Não existe “perguntar ao usuário”. Barrado = chamada trocada pela versão barata.', 'var(--ok)')}
${card('Custo', 'Pequeno. lib/events.cjs:summary já calcula hoje e total; o status só não importa esse módulo ainda.', 'var(--ok)')}
${card('Risco', 'Baixo. O status é lido por você, não entra no contexto do agente; nenhuma regra muda. Se o arquivo de eventos estiver ilegível, a linha some e o resto do status segue (fail-open).', 'var(--am)')}
</div>
<div class="tg-rec"><b>Recomendação:</b> construir.</div>`),
  say: 'L seis: a economia no comando status. Hoje o status mostra só a configuração: modo, regras, daemon, hook. Com o L seis, entram duas linhas: barrados hoje e no total, e tokens poupados hoje e no total. Nesta máquina, hoje, seriam duas chamadas barradas e cerca de quarenta e quatro mil tokens poupados; no total, desde trinta de outubro, cento e duas barradas e cerca de um vírgula dois milhão de tokens. O que muda no uso: quem usa só o terminal, como no Codex, no Cursor ou num servidor de integração, vê a economia sem abrir a tela de setup. Barrado aqui quer dizer uma recusa que ensina: a chamada não roda e o agente recebe a alternativa barata pronta; o token-guard nunca pergunta a você. O custo é pequeno, porque os números já são calculados. O risco é baixo: o status é lido por você, não entra no contexto do agente, e nenhuma regra muda. Recomendação: construir.' });

blocks.push({ type: 'html', html: scene('L7', '#4be3b5', 'L7 · token-guard cost --here', 'O custo só das sessões deste repositório, em vez da soma de todos os projetos.',
  `<div class="tg-g">
<div><b style="color:var(--mut);font-size:13px;letter-spacing:.06em;text-transform:uppercase">Hoje · cost --since 1d</b><div class="tg-term">  60 sessões · 25101 chamadas · um total só
    orchestrador        4255 chamadas
    native-java         2595 chamadas
    skill-repo          2265 chamadas
    …todos os projetos misturados</div></div>
<div><b style="color:var(--mut);font-size:13px;letter-spacing:.06em;text-transform:uppercase">Com L7 · cost --since 1d --here</b><div class="tg-term">  <span class="n">só sessões dentro de</span>
  <span class="n">…\\Projetos\\token-guard</span>
  total estimado: US$ (só deste repo)
  10 sessões mais caras (deste repo)</div></div>
</div>
<p class="tg-cap">À esquerda, a saída real das últimas 24 h nesta máquina (sem os valores em dólar, que hoje saem da tabela padrão desatualizada, item C10). À direita, o formato; o valor depende das sessões deste repositório.</p>
<div class="tg-g">
${card('O que muda no uso', 'Você responde “quanto custou trabalhar neste projeto?” com um comando, sem somar linhas à mão nem misturar com outros projetos.')}
${card('Custo', 'Pequeno. O cost já guarda a pasta de trabalho de cada sessão (readTranscript); falta só o filtro “pasta dentro do repositório”.', 'var(--ok)')}
${card('Risco', 'Muito baixo. É um filtro novo e opcional: sem --here, a saída fica idêntica à de hoje. Sessão sem pasta registrada fica de fora do --here, e a saída diz quantas ficaram.', 'var(--am)')}
${card('Por que primeiro', 'É o que responde a pergunta de custo mais comum, sem tocar em nada que já existe.', 'var(--ok)')}
</div>
<div class="tg-rec"><b>Recomendação:</b> construir, primeiro dos três.</div>`),
  say: 'L sete: o cost com a opção here. Hoje, o comando cost soma todos os projetos da máquina. Nas últimas vinte e quatro horas, por exemplo, deu sessenta sessões e mais de vinte e cinco mil chamadas, misturando orchestrador, native java, skill repo e o resto, num total só. Com o L sete, você roda cost com a opção here dentro de um repositório e vê só as sessões cuja pasta de trabalho fica dentro dele. O que muda no uso: você responde quanto custou trabalhar neste projeto com um comando, sem somar à mão. O custo é pequeno, porque o cost já guarda a pasta de cada sessão; falta só o filtro. O risco é muito baixo: sem a opção here, a saída fica idêntica à de hoje. Recomendação: construir, e primeiro dos três.' });

blocks.push({ type: 'html', html: scene('L8', '#ffc15e', 'L8 · Tokens poupados em US$ estimados', 'Na tela de setup e no status, ao lado dos tokens, um valor em dólares, sempre rotulado como estimativa.',
  `<div class="tg-term">  tokens poupados: hoje ~44k · total ~1,2M
<span class="n">  ≈ US$ 0,18 hoje · ≈ US$ 4,83 no total  (estimativa: tokens × preço de entrada do opus, US$ 4/Mtok)</span></div>
<p class="tg-cap">Conta com os números de hoje e o preço oficial de entrada do Opus 5.5 (US$ 4/Mtok). A tabela padrão do token-guard ainda diz US$ 5 e cache a 0,1×: está desatualizada, é o item técnico C10 e será corrigida independentemente desta decisão. O texto do rótulo fica para a construção, mas a palavra “estimativa” e a conta usada são obrigatórias.</p>
<div class="tg-g">
${card('O que muda no uso', 'A economia passa a ter uma ordem de grandeza em dinheiro, que é o que importa para quem paga a conta ou precisa justificar a ferramenta.')}
${card('Por que é estimativa sobre estimativa', 'Os tokens já são estimados (4 caracteres por token). E o preço real depende do cache: no Opus 5.5, lido do cache, o mesmo token custa 0,05× (US$ 0,20/Mtok). Pelos mesmos 1,2M tokens: <b>US$ 4,83</b> a preço de entrada, <b>US$ 0,24</b> a preço de cache, vinte vezes menos. Um texto que fica no contexto é relido a cada turno, então a economia real também pode ser maior.', 'var(--am)')}
${card('Custo', 'Pequeno a médio: a conta é simples (lib/cost.cjs:priceOf), mas mexe em dois lugares (status e tela de setup) e no texto do rótulo.', 'var(--ok)')}
${card('Risco', 'O número pode parecer exato sem ser. Sem o rótulo, o usuário confia num valor que pode estar vinte vezes acima, ou abaixo. Com o rótulo e a conta visível, fica honesto.', 'var(--bad)')}
</div>
<div class="tg-rec"><b>Recomendação:</b> construir só com o rótulo explícito de estimativa e a conta usada visível; sem o rótulo, não construir.</div>`),
  say: 'L oito: os tokens poupados também em dólares estimados, na tela de setup e no status. A conta é tokens poupados vezes o preço de entrada do modelo, da mesma tabela de preços do comando cost. Com os números de hoje e o preço oficial de entrada do Opus cinco ponto cinco, quatro dólares por milhão de tokens, daria cerca de dezoito centavos hoje e quatro dólares e oitenta e três centavos no total. Um aviso: a tabela padrão do token-guard ainda usa cinco dólares e cache a um décimo; está desatualizada, virou o item técnico C dez e será corrigida de qualquer jeito. O que muda no uso: a economia ganha uma ordem de grandeza em dinheiro. Mas é estimativa sobre estimativa. Os tokens já são estimados, quatro caracteres por token. E o preço real depende do cache: no Opus cinco ponto cinco, lido do cache, o mesmo token custa cinco centésimos do preço de entrada. Pelos mesmos um vírgula dois milhão de tokens, são quatro dólares e oitenta e três a preço de entrada, ou vinte e quatro centavos a preço de cache, vinte vezes menos. E como um texto que fica no contexto é relido a cada turno, a economia real também pode ser maior. O custo é pequeno a médio. O risco é o número parecer exato sem ser. Recomendação: construir só com o rótulo explícito de estimativa e a conta usada visível; sem o rótulo, não construir.' });

blocks.push({ type: 'html', html: scene('?', '#ffc15e', 'A decisão: cinco opções', 'A primeira é a recomendada. Qualquer opção libera a 2.18.2 do jeito que ela já está; o que for escolhido entra depois.',
  `<div class="tg-g">
${OPCOES.map((o, i) => card(`Opção ${i + 1}${i === 0 ? ' · recomendada' : ''}`, `<b>${o.rotulo.replace(' (recomendado)', '')}</b><br>${o.descricao.replace(/^Recomendado\. /, '')}`, i === 0 ? 'var(--ok)' : 'var(--c)')).join('\n')}
</div>
<div class="tg-rec"><b>Recomendação:</b> ${REC}. L7 e L6 só mostram o que o token-guard já mede; L8 só vale se o valor nunca parecer exato.</div>
${opJson}`),
  say: 'A decisão, com cinco opções. A primeira é a recomendada: construir L sete e L seis, e L oito só com o rótulo explícito de estimativa. Opção dois: construir L sete e L seis, sem o L oito. Opção três: construir só o L sete. Opção quatro: construir só o L seis. Opção cinco: não construir nenhum agora, e os três ficam no backlog como decididos. Em qualquer opção, a versão dois ponto dezoito ponto dois sai do jeito que já está; o que você escolher entra depois. Eu recomendo a primeira, porque L sete e L seis só mostram o que o token-guard já mede, e o L oito só vale se o valor em dólares nunca parecer exato. A escolha é sua.' });

blocks.push({ type: 'table', title: 'De onde vem cada afirmação', head: ['Afirmação', 'Fonte', 'Endereço', 'Acessado em'],
  rows: [
    ['L6, L7 e L8, esforço e peças de código', 'Backlog do token-guard, seção “Candidatos da lente irmã (2.18.2)”', 'file:token-guard/docs/BACKLOG.md', D],
    ['Barrados hoje 2 / total 102 desde 30/10; tokens poupados ~44k hoje / ~1,2M total', 'lib/events.cjs:summary() lido nesta máquina', 'file:token-guard/lib/events.cjs', D],
    ['Saída atual do status e do cost (60 sessões, 25101 chamadas em 24 h, por projeto)', 'token-guard status e token-guard cost --since 1d rodados nesta máquina', 'file:token-guard/cli.cjs; file:token-guard/cost.cjs', D],
    ['Opus 5.5: US$ 4/Mtok de entrada, US$ 0,20 lido do cache (0,05×); Sonnet 5.5 US$ 2/10', 'Página oficial de preços da Anthropic', 'https://platform.claude.com/docs/en/about-claude/pricing', D],
    ['Tabela padrão do token-guard desatualizada (opus 5/25, cache 0,1×): item técnico C10', 'DEFAULT_PRICES e CACHE_FACTOR comparados à página oficial', 'file:token-guard/lib/cost.cjs', D],
    ['Precedente de economia no terminal, com divisão por dia, tokens estimados em bytes/4', 'RTK: rtk gain', 'https://www.rtk-ai.app/docs/analytics/gain/', D],
    ['Tokens poupados não viram economia igual na conta (diluição)', 'RTK: How RTK Savings Work', 'https://www.rtk-ai.app/docs/resources/savings-explained/', D],
    ['Precedente de custo filtrado por projeto (--project, --instances)', 'ccusage: Command-Line Options', 'https://ccusage.com/guide/cli-options', D],
    ['“Poupado” só conta o medido, 4 caracteres por token', 'Texto da tela de setup', 'file:token-guard/adapters/ui/setup.html', D],
    ['Toda recusa é deny que ensina; nunca pergunta ao usuário', 'Pesquisa de decisões do hook de recusa', 'file:token-guard/docs/research/refusal-hook-decisions-2026-10.md', D]
  ],
  say: 'Por fim, as fontes. Os três itens vêm do backlog do token-guard. Os números de barrados e tokens poupados foram lidos hoje nesta máquina. A saída do status e do cost veio dos próprios comandos, rodados hoje. Os preços do Opus e o fator de cache vêm da página oficial de preços da Anthropic, lida hoje. Os precedentes vêm do R T K, que mostra a economia no terminal e avisa que ela não vira economia igual na conta, e do ccusage, que filtra o custo por projeto. E a regra de que toda recusa é um deny que ensina vem da pesquisa de decisões do hook de recusa.' });

const board = { engine: 'vxk', mode: 'board', kind: 'release', title: 'token-guard: L6, L7 e L8, quais construir?', slug: 'token-guard-backlog-l6-l7-l8',
  badge: `VXK · board · token-guard · backlog L6 L7 L8 · ${D.split('-').reverse().join('/')}`, accent: '#ffc15e', language: 'pt-BR', narrate: true,
  voice: 'pt-BR-Chirp3-HD-Iapetus', voiceStrict: true, audioFormat: 'mp3',
  labels: { explain: '▶ Apresentar', pause: '⏸ Pausar', resume: '▶ Continuar', prev: '◀ Anterior', next: 'Próximo ▶', index: '☰ Índice', indexTitle: 'Tópicos', indexClose: 'Fechar' },
  blocks };
writeFileSync(join(HERE, 'backlog-l6-l7-l8.json'), JSON.stringify(board, null, 2) + '\n');
console.log(`boards/backlog-l6-l7-l8.json: ${blocks.length} blocos`);
