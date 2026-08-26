# R6 · Contrato sobrevive à Compaction — SDD

> Status: **PLANO · Rev.3 — APROVADO pela revisão #3** (zero MAJOR/MINOR;
> fixes finais de metadado/typo aplicados conforme pré-autorização da #3:
> "After these two edits, this spec is CLEAN"). **Liberado para implementação.**
> Fase: R6 do roadmap de mercado (docs/MARKET.md › R6)
> Regra da fase: rodadas de revisão devem REDUZIR achados. Zero libera código.
> Problema: o contrato injetado 1×/sessão MORRE na primeira compaction — o
> harness resume/substitui o histórico e o texto injetado some, mas o estado
> `.token-guard/sessions/<id>.json` continua dizendo "já injetado". Resultado:
> sessões longas (as que mais precisam) ficam sem contrato.

---

## 1. Mecanismo verificado (Claude Code)

- Evento `PreCompact` existe no Claude Code: dispara ANTES da compaction
  (manual via /compact ou automática), payload inclui `session_id`, `cwd`,
  `trigger` ("manual"|"auto").
- Após a compaction, o próximo evento do ciclo normal é um novo
  `UserPromptSubmit` (o usuário/agente continua a conversa).

## 2. ADR-006: PreCompact LIMPA o estado; UserPromptSubmit re-injeta

### Decisão
No `PreCompact`: apagar/resetar `injected` do estado da sessão
(`sessions/<id>.json`). Na próxima submissão de prompt, o prompt-hook existente
encontra o estado vazio e **re-injeta a camada "sempre"** — o contrato volta ao
contexto recém-compactado, sem nenhum canal novo de injeção.

### Por que limpar em vez de injetar no PreCompact
O PreCompact roda ANTES do resumo existir: qualquer texto injetado ali seria
resumido/junto com todo o resto — destino incerto. Limpar é determinístico:
o mecanismo de re-injeção já existe e está provado (R2/prompt-hook).

### Alternativas descartadas
| Alternativa | Por que não |
|---|---|
| Injetar dentro do PreCompact | o output do PreCompact não tem canal model-facing garantido (systemMessage/continue descartados; exit 2 BLOQUEARIA a compaction); e o texto viria antes do resumo existir — destino incerto |
| **SessionStart(source=compact) re-injetar direto** | tem canal model-facing documentado (stdout→contexto) e é o que docs/MARKET.md linha R6 imaginava — MAS: (a) dispara também em `resume`/`fork`/`startup`, exigindo scoping por source; (b) exige um segundo adapter + registro novo; (c) deixa um gap menor mas real: entre a compaction e a próxima mensagem do usuário o contrato ausenta-se de todo jeito (auto-compact no meio do turno). Fica como evolução v2 se o gap do próximo-prompt doer na prática |
| Persistir o contrato num arquivo e reler | já é exatamente o que contract.load() faz; não adiciona nada |
| Copilot/Cursor v1 | sem evento equivalente documentado nesses harnesses — permanece manual (honesto, já declarado) |

### Invariante preservada (explícito)
A evidência `sessions/<id>-touched.json` NÃO é afetada: vive em disco, fora do
alcance da compaction. Logo, ao zerar `injected`, a próxima injeção re-arma
`sempre` **e** os gatilhos por evidência (`codigo/teste/docs`) cujas regras
também morreram no resumo — comportamento desejado, agora contratual.

## 3. Contratos

Novo adapter mínimo `adapters/precompact.cjs` (padrão dos irmãos):
```
payload: { session_id, cwd, hook_event_name:'PreCompact', trigger }
ação: CT.readState(root, sid) → se injected.length > 0 → writeState(root,
      sid, { injected: [] })   // reseta para re-injeção
stdout: silêncio SEMPRE (nenhum additionalContext necessário)
fail-open: qualquer erro → silêncio
session key: MESMA derivação do prompt-hook (sem session_id → `sess-<sha1(root)[:8]>`;
  sem cwd → silêncio) — paridade total, sem divergência
TOKEN_GUARD=off → o reset é INCONDICIONAL (estado fica coerente com o mundo
  sem ler config; se o guard voltar no meio da sessão, nada fica stale)
trigger manual|auto → ambos resetam (o adapter ignora trigger — travado em teste)
```

install.cjs alvo claude: registra `PreCompact` (sem matcher), idempotente +
reparo stale pelo mesmo pruneDeadTokenGuard; comentário do bloco de eventos
estendido para citar os quatro eventos.

## 4. Plano de testes (failing-first)

1. injected=['sempre'] + touched=['lib/x.cjs'] gravados → PreCompact zera injected → próxima chamada de prompt-hook reinjeta sempre E codigo (evidência sobrevive em disco).
2. Estado vazio + PreCompact → silêncio, sem escrita desnecessária; **estado ausente (sem arquivo)** + PreCompact → silêncio e NENHUM arquivo criado.
3. Sem session_id (deriva da raiz) e sem cwd → silêncio; nada gravado fora de sessões reais.
4. TOKEN_GUARD=off → stdout silencioso, mas reset incondicional (sem estado stale).
5. stdin corrompido → silêncio, exit 0.
6. trigger "manual" e "auto" → ambos resetam.
7. Duas compactions sequenciais com prompt entre elas → re-injeção idempotente nos dois ciclos.
8. install.cjs: entrada PreCompact registrada, idempotente no re-run, entrada morta reparada (precedente install.test).
Nota de concorrência: prompt-hook escrevendo enquanto precompact reseta é benigno — pior caso é uma duplicata de injeção no turno seguinte (direção fail-open); writeState não é atômico por herança — não prometa ordenação.

## 5. Impacto medido
Custo honesto: CADA compaction passa a custar uma re-injeção completa das
seções merecedoras (~180 tok medidos: bloco `sempre` = 742 chars na 2.2.x) —
é esse o pagamento consciente.
Benefício: contrato presente nas sessões longas, as que mais sofrem context
rot. Limitação residual: auto-compact no MEIO de um turno agêntico deixa a
ausência até a próxima mensagem do usuário (UserPromptSubmit não dispara no
meio do turno).

## 6. Fora de escopo (v1)
Copilot/Cursor (sem evento); REFINO de evidência pós-compaction (envelhecer/
limpar touched para gatilhos obsoletos não re-armarem quando o tipo de trabalho
muda pós-reset — o re-arm em si É o escopo, ver §2 invariante); injeção
direta no PostCompact; telemetria de adoção.

## 7. Checklist de liberação

- [x] Revisão #1 — 4 mandatórios + recomendados tratados na Rev.2
- [x] Revisão #2 (re-gate) — 1 MAJOR (contradição §6×§2) + menores corrigidos na Rev.3
- [x] Revisão #3 — APPROVED CLEAN (pós-fixes N/trivial autorizados pela própria #3)
- [ ] Revisão #2 — LIMPA
- [ ] Implementação failing-first (§4) + registro no install.cjs (incl. comentário do bloco de eventos)
- [ ] CHANGELOG + docs/CONTRACT.md §Status atualizado + linha R6 do MARKET.md reconciliada com o design final (reset, não SessionStart)
