# REQUEST — Daemon único para hooks do token-guard

## slug
daemon-unico

## Problema (evidência medida, não re-provar)
No modo hook (Claude Code / Cursor), cada evento de ferramenta faz o harness dar `spawn(node …cjs)`: lê stdin, decide, escreve stdout, morre. N sessões × M tool-calls = N×M cold-starts por hora. Nesta máquina (win32, Node v24.14.1, mediana de 30): spawn isolado = 53 ms (piso do Node 31 ms + lógica 22 ms); sob burst de 60 req simultâneos a mediana vai a 263 ms e p95 a 409 ms, throughput satura ~128 req/s → estoura timeouts de 5–15 s do harness. Na máquina corporativa (VPN + AV Windows + AV empresa + validador de processo + auditoria) cada spawn novo dispara análise EDR individual SEM CACHE: 300–400 spawns/dia = 300–400 análises que travam execução. RAM: 16 GB com ~1 GB livre não sustenta picos de N×M×~40 MB.

Fonte: `docs/daemon-validation.html`; lições da Brain `49013710…` e `eb78288d…`.

## Objetivo
Substituir o modelo efêmero (um processo por chamada) por um **daemon único residente por máquina**: nasce no logon do Windows, morre só no shutdown; todas as IDEs suportadas viram clientes finos que conectam e recebem a decisão já quente.

## Escopo
- Núcleo de decisão `lib/decide.cjs` é REAPROVEITADO integralmente — zero mudança de regra/contrato funcional.
- Transporte novo: frames JSON-RPC com `requestId` sobre named pipe (Win) / socket UNIX (POSIX). Reúso do parser de frames já existente em `adapters/mcp-server.cjs`.
- Ciclo de vida: start-on-logon (Task Scheduler / Run key no Win; systemd-user/launchd no POSIX), singleton por lock de SID, handshake de versão, ACL restrita ao usuário.
- Fault tolerance obrigatória (senão daemon vira ponto único pior que efêmero):
  1. **Start on demand** — no connect-fail o próprio cliente tenta subir o daemon 1× com lock, espera o pipe, reconecta.
  2. **Self-heal no crash** — cliente detecta EPIPE/EOF → reassume UMA vez via start-on-demand (AV re-analisa 1×, não N×).
  3. **Disarm em erro crítico** — após K falhas consecutivas (K=3) tentando subir o daemon, cliente DESARMA o modo daemon e cai no caminho efêmero atual + loga alto. Nunca loop infinito de respawn contra o antivírus.
- Mitigação de burst CPU-bound: cache de decisão keyed por `{path, rule-set-hash}`; opcional pool de `worker_threads` dentro do daemon.

## Fora de escopo (backlog)
- Mudar qualquer regra em `lib/rules.cjs` ou o contrato de saída.
- Daemonizar o caminho plugin in-process do Copilot CLI (`adapters/copilot-cli.mjs`): já custa 0,55 ms, ganho nulo. Escopo honesto = só o modo SPAWN/hook.
- Idle-timeout agressivo: o dono decidiu que o daemon vive do logon ao shutdown; TTL curto NÃO entra (risco de zumbi órfão é aceito como esperado aqui).

## Critérios de aceite (gate G-final)
1. Latência mediana por chamada no modo hook ≤ 5 ms nesta máquina (vs 53 ms hoje).
2. Sob burst de 60 req simultâneos, nenhum timeout do harness (mediana < 50 ms, p95 < 150 ms).
3. Pico de RAM fixo ~40 MB (1 processo), sem multiplicação por sessões.
4. Fail-open preservado: daemon inacessível ⇒ cliente cai no efêmero atual, nunca derruba nem bloqueia a sessão.
5. Suite atual (`npm test`) verde + testes novos cobrindo: transporte/framing, singleton/lock, start-on-demand, self-heal, disarm após K falhas, handshake de versão.
6. Instalação registra o autostart corretamente no Windows e no POSIX.

## Restrições técnicas conhecidas (da Brain)
- Windows: `.cmd/.bat` exigem `shell:true`; para silenciar DEP0190 passar uma única string pré-citada com args vazios. Resolver executável via PATHEXT×PATH.
- Named pipe: restringir DACL ao SID do usuário + `PIPE_REJECT_REMOTE_CLIENTS`.
- Concorrência no pipe compartilhado: framear por `requestId` (padrão JSON-RPC já no mcp-server.cjs).
- Stale code em upgrade: handshake de versão no connect; mismatch ⇒ derruba daemon velho e reassume.

## Referências de código
- `adapters/hook-cmd.cjs` (hook PreToolUse efêmero), `adapters/prompt-hook.cjs` (UserPromptSubmit), `adapters/post-hook.cjs` (PostToolUse) — os três pontos de spawn a migrar para cliente fino.
- `lib/decide.cjs:30` — função `decide(payload)` reaproveitada pelo daemon.
- `adapters/mcp-server.cjs:211` — `start()` com readline framing, base do transporte do daemon.
- `bench/latency.cjs` — harness de medição para validar critérios 1–2.
- `hooks.json:9` — registro atual do comando efêmero.
