# Lente nativa: medição completa e recomendação (2026-11-23)

Fatia medida: o guard de `PreToolUse` atrás de um listener HTTP (`native-lens/SPEC.md`). Contendores: o Node de hoje
(`noderef` = só a decisão; `daemon` = o daemon real inteiro), C# Native AOT, Rust e Go. Dados brutos em `native-lens/raw/`
(ignorados pelo git); a tabela abaixo sai de `native-lens/harness/summarize.py` sobre esses arquivos.

## Método

- 7 repetições alternadas (repetição 1 de todos, depois a 2, ...), em dois perfis: `weak` (2 núcleos de afinidade e teto de CPU
  de 3,125%, calibrado em 0,45 núcleo-equivalente) e `none` (sem limite, 3,6 núcleos-equivalentes medidos).
- Ambiente limpo: `HOME`, `USERPROFILE`, `LOCALAPPDATA` e `APPDATA` vazios por execução; `TEMP` na pasta de fixtures; sem o
  `CLAUDE.md` nem os hooks do dono. O arquivo de endpoint do daemon real foi lido (só `stat`) antes e depois: inalterado.
- Carga: 300 chamadas sequenciais, 300 com conexão nova e 4 x 75 concorrentes, sempre o mesmo mix de 20 payloads
  (8 negam, 12 liberam). 6300 chamadas cronometradas por contendor e perfil, todas com o veredito esperado (0 divergências).
- O conhost.exe que o `CREATE_NO_WINDOW` põe em todo job é contado à parte (coluna "sem conhost").
- A máquina estava compartilhada: CPU de 3% a 100% no início de cada repetição (tabela de carga no log). Os intervalos
  min-max abaixo mostram o ruído; a mediana de 7 é o número a usar.
- Prova de equivalência dos três portes: 1022 casos (148 reais + 757 mutações + 12 hostis + 105 de layout), 0 divergências,
  0 diferenças de texto de razão, 0 falhas de protocolo.

## Tabela única (mediana de 7; perfil `weak` entre parênteses, quando difere)

| | Node (decisão) | Node (daemon inteiro) | C# AOT | Go | Rust |
|---|---|---|---|---|---|
| Memória ociosa (RSS, sem conhost) | 67,7 MB | 69,4 MB | 9,0 MB | 8,8 MB | 4,5 MB |
| Pico de working set (sem conhost) | 76,9 MB | 83,9 MB | 26,4 MB | 16,7 MB | 5,8 MB |
| Pico de commit do job (memória privada) | 33,8 MB | 72,3 MB | 21,6 MB | 55,6 MB | 3,3 MB |
| CPU ocioso em 10 s | 0,000 s | 0,000 s | 0,000 s | 0,000 s | 0,000 s |
| Início até ouvir | 70 ms | 92 ms | 24 ms | 23 ms (weak 33) | 24 ms |
| CPU por chamada, sequencial | 1,82 ms (weak 1,41) | 4,22 ms (weak 4,17) | 1,51 ms (weak 1,56) | 1,35 ms (weak 1,30) | 0,99 ms (weak 1,04) |
| CPU por chamada, concorrente | 1,35 ms (weak 1,30) | 4,27 ms (weak 3,91) | 1,62 ms (weak 1,88) | 1,72 ms (weak 1,46) | 1,41 ms (weak 1,41) |
| Vazão concorrente, sem limite | 729/s | 237/s | 1972/s | 2125/s | 2418/s |
| Vazão concorrente, `weak` | 476/s | 148/s | 317/s (53-443) | 469/s | 553/s |
| p50 concorrente, `weak` | 4,96 ms | 14,49 ms | 3,14 ms | 2,66 ms | 2,43 ms |
| Artefato | 2 KB | 37 KB | 2278 KB | 6480 KB | 328 KB |

Hook de comando (processo curto, caminho frio sem daemon, `weak`): piso do Node 46 ms de relógio e 47 ms de CPU; negar ou
liberar 82-84 ms de relógio, 94 ms de CPU, 77 MB de working set. Esse processo é Node em qualquer cenário: a lente nativa
não o altera.

Pico de memória do próprio experimento: working set de pico da execução inteira abaixo de 100 MB por contendor; a memória
livre da máquina ficou entre 6,7 e 12,6 GB durante todas as repetições (nenhuma execução foi adiada por memória).

## Medido contra estimado

Nenhuma estimativa numérica anterior foi registrada em `docs/` ou no backlog; a estimativa que existia era qualitativa
("nativo usa bem menos memória e inicia mais rápido"). A medição a confirma em memória e início (cerca de 7x a 15x menos
memória ociosa, 3x a 4x menos tempo de início) e a **desmente em CPU por chamada**: o Node só da decisão gasta 1,4-1,8 ms,
e os três nativos 1,0-1,6 ms, uma diferença menor que a faixa de ruído. O custo alto do daemon real (4,2 ms por chamada)
vem do resto dele (cache de veredito, log de eventos, rotas), que a fatia deixa de fora de propósito.

## O que os números não dizem

- A fatia não grava evento em disco, não tem cache de veredito nem as rotas de PostToolUse, MCP, UI e atualização
  (SPEC §5). A comparação com o "daemon inteiro" mostra o teto do ganho, não o ganho de uma troca completa.
- O C# no perfil `weak` tem cauda: p95 de até 523 ms e vazão de 53/s numa repetição (carga da máquina de 87% no fim dela).
  Rust e Go não tiveram cauda dessa ordem nas mesmas condições, mas uma só repetição por contendor não separa ruído de causa.
- O working set do Go é menor que o do C#, mas o commit do job do Go (55,6 MB) é maior: o runtime reserva mais do que toca.

## Recomendação

Regra do dono: C# se medir tão bem quanto a melhor alternativa; Rust ou Go só se forem claramente melhores; Node se não
houver ganho.

1. **Há ganho** em memória e início, então não é "manter Node" para a fatia de decisão.
2. **C# empata com Rust e Go em CPU por chamada** (1,5 contra 1,0 a 1,4 ms, dentro do ruído) e fica a 2x do melhor em
   memória ociosa (9,0 contra 4,5 MB), diferença absoluta de 4,5 MB. Isso não é "claramente melhor" para Rust ou Go.
   Rust ganha em vazão com carga limitada (553 contra 317/s) e em artefato, mas a mediana do C# está puxada por uma repetição
   ruidosa.
3. Recomendação: **C#**, aplicando a regra à letra, **como candidato para a fatia de decisão do hook, não para trocar o daemon**.
   A troca do daemon inteiro exige portar cache, eventos e rotas, o que a medição não cobre; o estado do projeto é
   "medido, não adotado". Antes de qualquer adoção valeria repetir só C# contra Rust no perfil `weak` numa máquina ociosa,
   para separar a cauda do C# do ruído da máquina; essa é a única pergunta que mudaria a escolha.
4. Custo de adoção que a medição não mede: o pacote npm hoje não leva binário (decisão da bandeja de 2026-10-30, executável
   compilado descartado por exigir assinatura e distribuição); um binário nativo traria o mesmo custo para os três.

## Material existente consultado

- `tela-setup-bandeja-2026-10-30.md`: aplicado o achado do conhost.exe (processo extra por job, contado à parte na tabela) e
  a decisão de não distribuir binário no pacote (a lente fica em `native-lens/`, fora do `files` do npm).
- `codex-mcp-por-url-2026-11-21.md`: aplicado o método de medir processos e commit por conversa; a rota MCP por url fica fora
  da fatia (SPEC §5) e é citada como parte do custo do daemon inteiro.
- `documento-grande-token-guard-e-smart-tool-2026-10.md` (a pesquisa de decision-notes do Smart Tool sobre coexistência de
  hooks): aplicado ao tratar o Smart Tool como não instalado na fatia (a dica `read_document` nunca dispara nos casos);
  a coexistência de hooks em si não foi medida.
- Skill `contextacao`: usada como triagem antes da medição (premissas explícitas: ambiente limpo, mediana de 7, perfil
  `weak` calibrado, sem estimativa inventada); não gerou arquivo.
