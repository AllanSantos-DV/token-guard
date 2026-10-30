## Task: tela de setup e ícone na bandeja do daemon (2.14.0)
Related: docs/research/scout-barato-e-updatedinput-2026-10-26.md (princípios: todo bloqueio ensina, `deny` e não reescrita silenciosa; nada disso muda)

### Intent
- WHY: a config do token-guard é feita para máquina; o dono pediu uma porta de entrada humana para o daemon, que já é um por usuário.
- WHAT FOR: configurar o tipo de bloqueio, ver o que cada regra faz e o que foi barrado e poupado, global ou por IDE.
- FOR WHOM: quem usa o token-guard sem querer editar JSON.

### Key Decisions
| Decision | Why this over alternatives | Verified? |
|----------|--------------------------|:---------:|
| Tela servida pelo daemon existente, sem porta nem processo novo | o daemon já tem http local com token; reusa `daemon-http.cjs` | ✅ |
| Modo por IDE em `targets`, aplicado em `CFG.load(root, target)` devolvendo `mode: "off"` | todo consumidor que já lia `cfg.mode` passa a respeitar sem código novo; uma fonte de config | ✅ (test/targets.test.cjs) |
| A tela grava em `~/.token-guard/token-guard.config.json` | último home no merge global; CLI, hooks e daemon já o leem | ✅ |
| Tokens poupados só onde medidos; `deny` só conta | um deny não mede o que evitou; não inventar economia | ✅ |
| Bilhete de uso único + cookie + CSRF + Host + CSP | o navegador não manda header de token; o token do dono não vai à URL | ✅ (test/setup-ui.test.cjs) |
| Ícone em PowerShell 5.1 `NotifyIcon`, sob `conhost --headless` com stdin em pipe | zero dependência; stdin NUL faz o conhost não executar o filho | ✅ medido |
| Pós-processamento respeita guard desligado (global ou do IDE) | antes `TOKEN_GUARD=off` ainda cortava resultado; "desligado" tem de ser desligado | ✅ |
| `setup` cria o token se faltar e reinicia daemon sem http | instalação sem o alvo claude não tinha http; sem isso a tela não abre | ⚠️ muda o ciclo de vida: daemon com token não se encerra por ociosidade (já era assim com o alvo claude) |
| Limite de 63 caracteres na dica do ícone | prudência; a fonte da Microsoft não informa o limite | ⚠️ |

### Done When
- [x] ícone mostra estado e abre a tela; tela configura regra e IDE e mostra barrado/poupado
- [x] config única lida por CLI, hooks, daemon e tela
- [x] testes silenciosos e isolados; pixels reais capturados
- [ ] instalação local exercitada, lente irmã, fast-forward, tag em main, Pages

### For Next
- Propostas opcionais da seção 8 do SDD seguem desligadas até o dono decidir.
- Evento só é registrado pelo daemon; o caminho sem daemon (fail-open) não aparece na tela.
- Se um dia houver regra por IDE, `targets` precisa virar objeto por IDE (hoje o valor é string `block|off`).
