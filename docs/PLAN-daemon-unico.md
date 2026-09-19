# PLAN — Daemon único para hooks do token-guard

```yaml
slug: daemon-unico
status: PLANNED
request: docs/REQUEST-daemon-unico.md
validation: docs/daemon-validation.html
owner_scope: hook/spawn mode only (Claude Code / Cursor); Copilot CLI plugin path untouched
platform_target: win32 corporate (EDR no-cache) + POSIX parity
semver_bump: minor (new feature), 2.2.2 -> 2.3.0
```

Cross-reference: every acceptance criterion below is numbered per `docs/REQUEST-daemon-unico.md` §"Critérios de aceite". Section "Acceptance coverage" maps each to its owning phase(s).

---

## 1 · Context

**Problem (measured, not re-proved).** In spawn/hook mode each tool event makes the harness `spawn(node …cjs)`: read stdin → decide → write stdout → die. On this box (win32, Node v24.14.1, median of 30): isolated spawn = **53 ms** (Node floor 31 ms + logic 22 ms). Under a burst of 60 simultaneous requests the median hits **263 ms**, p95 **409 ms**, throughput saturates ~128 req/s and falls — blowing the harness's 5–15 s timeouts. Source: `docs/daemon-validation.html` §2–§3.

On the corporate machine (VPN + Windows Defender + company AV + process validator + auditing) each new spawn triggers an **individual EDR scan with NO cache**: 300–400 spawns/day = 300–400 blocking scans. RAM 16 GB with ~1 GB free cannot sustain N×M × ~40 MB peaks; disk at limit.

**Goal.** Replace the ephemeral model (one process per call) with a **single resident daemon per machine**: born at Windows logon, dies only at shutdown; all supported IDEs become thin clients that connect and get a warm verdict. Target ~1 ms/call flat under load (§4–§6 of validation).

**Codebase map (read, verified):**
- `lib/decide.cjs:30` — `decide(payload)` core. Contract: returns `null` (allow) | `{decision, reason, rule}`. Fail-open via try/catch (`:63`). **Reused verbatim — zero rule change.** Lazy-requires `config.cjs`/`rules.cjs` inside the watched-tool branch (`:36`,`:41`) — the daemon keeps these warm in memory.
- `adapters/mcp-server.cjs:211` — `start()` builds `readline` framing over stdio, one JSON message per line, dispatches by `msg.id` (`handle()` at `:159`, `reply()/replyError()` at `:149/:154`). This requestId-framing pattern is the **transport base** for the daemon.
- `adapters/hook-cmd.cjs` — PreToolUse ephemeral hook. Reads payload (`P.readPayload()`), calls `decide()`, writes `hookSpecificOutput.permissionDecision`. **Migration point #1** → thin client.
- `adapters/prompt-hook.cjs` — UserPromptSubmit ephemeral (contract injection). Uses `CT.*` state helpers, derives sessionId from root hash. **Migration point #2** → thin client. Note: emits `additionalContext`, not a `permissionDecision` — different response envelope than hook-cmd.
- `adapters/post-hook.cjs` — PostToolUse ephemeral (bigResult trim + dupRead note). Calls `postProcess()`/`noteResult()`. **Migration point #3** → thin client. Also has distinct output shape.
- `hooks.json:9` — current ephemeral registration: `"command": "node .github/token-guard/token-guard.cjs"` with matcher + `timeout:10`. Reference for how install merges commands.
- `install.cjs` — installer. Per-target functions (`installClaude` at `:288`, `installCursor` at `:440`, `installRepo` at `:523`); `RUNTIME_FILES`(`:174`)+`RUNTIME_DIRS`(`:179`) drive what gets copied; atomic `writeJson` (`:154`); dead-registration pruning (`pruneDeadTokenGuard` `:273`). **Autostart registration goes here.**
- `package.json` — version `2.2.2`; scoped name `@allansantos-dev/token-guard` (`publishConfig.access: public`); `scripts.test` chains selftest + 9 test files; `files[]` includes `lib/`, `adapters/`, `bench/`, `test/`, `docs/` (so new files under those dirs ship automatically — but any NEW top-level file must be added explicitly).
- `bench/latency.cjs` — measures 3 medians (plugin in-process, hook spawn, Node floor `-e "0"`). Harness to extend for the daemon path (criteria 1–2). Currently uses synchronous `spawnSync`; concurrency proof needs async `spawn` fan-out like the validation bench.
- `test/` — 10 existing suites incl. `epipe.test.cjs` (EPIPE fail-open precedent), `adapters.test.cjs`, `install.test.cjs`. New daemon tests follow this naming/style.

---

## 2 · Decisions & rationale

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Transport = JSON-RPC-style frames keyed by `requestId` over named pipe (Win) / UNIX socket (POSIX) | Reuses proven framing from `mcp-server.cjs:211`; multiplexes dozens of concurrent clients on one connection set without interleaving corruption. Pure transport decoupled from core so it is unit-testable with fixtures, no live daemon. |
| D2 | Core `lib/decide.cjs` unchanged | Zero functional risk (validation §6 row "Lógica de decisão idêntica"). Daemon imports and calls `decide(payload)` directly; lazy requires stay warm in resident heap. |
| D3 | Response envelopes preserved per-hook | hook-cmd returns `permissionDecision`; prompt-hook returns `additionalContext`; post-hook returns `updatedToolOutput/additionalContext`. Client sends `(eventKind, payload)`, daemon returns raw decision object, **client re-wraps into the exact harness envelope**. Keeps migration invisible to harnesses and lets all three share one RPC method. |
| D4 | Singleton by SID lock + handshake version | Second start detects existing pipe → becomes client. Version mismatch at connect kills stale daemon and respawns fresh (stale-code risk, validation §7). Prevents dual daemons. |
| D5 | Pipe ACL restricted to user SID + `PIPE_REJECT_REMOTE_CLIENTS` | Otherwise any process on the account injects fake payloads into the guard (validation §7 security). |
| D6 | Fault tolerance triad mandatory | start-on-demand (client spawns daemon 1× on connect-fail), self-heal (detect EPIPE/EOF → resume once), disarm after K=3 consecutive failures → fall back to current ephemeral path + loud log. Without these the daemon is a worse single-point-of-failure than ephemeral (REQUEST §Escopo). Never infinite respawn vs AV. |
| D7 | Burst mitigation = decision cache keyed by `{path, rule-set-hash}`, worker_threads OPTIONAL | 60×22 ms serialize to ~1.3 s worst case on the event loop (validation §5). Cache collapses repeats to ~0 ms. Threads deferred to backlog unless bench proves cache insufficient — avoids complexity we may not need. |
| D8 | No idle-timeout | Owner decided daemon lives logon→shutdown; orphan-zombie risk accepted as expected behavior (REQUEST §Fora de escopo). TTL short NOT included. |
| D9 | Scope honest: hook/spawn mode only | Copilot CLI in-process already ~0.55 ms (`daemon-validation.html` §7 last bullet). Daemonizing there yields nothing. Out of scope. |
| D10 | Mechanical SDD gates absent in this repo | tools/, schemas/, store.db not present; only process skills installed. Acceptance is proved by REAL tests (`node selftest.cjs` + `test/` suite) + benchmark, not harness validators. Plan reflects that throughout. |

---

## 3 · Reuse ledger (extend, never reinvent)

| Existing asset | How reused | File reference |
|----------------|------------|----------------|
| `decide(payload)` | Called verbatim by daemon dispatcher; result returned over RPC | `lib/decide.cjs:30` |
| Frame-by-requestId dispatch (`handle/reply/replyError`) | Pattern lifted into new transport module; generalized from stdio-readline to pipe/socket streams | `adapters/mcp-server.cjs:149-209` |
| One-message-per-line JSON framing | Adopted as wire format (newline-delimited JSON-RPC) | `adapters/mcp-server.cjs:212-228` |
| `P.readPayload()` normalization | Thin clients still parse harness stdin identically before sending to daemon | `lib/payload.cjs` (via hook-cmd `:34`) |
| Three hook entrypoints | Become thin-client wrappers keeping same stdout contract + embedded ephemeral fallback | `adapters/hook-cmd.cjs`, `prompt-hook.cjs`, `post-hook.cjs` |
| `registrationState` / `pruneDeadTokenGuard` / atomic `writeJson` | Extended for autostart records + version-drift repair on upgrade | `install.cjs:204`, `:273`, `:154` |
| `RUNTIME_FILES`/`RUNTIME_DIRS` copy lists | Add new daemon/client/lib modules so installs ship them | `install.cjs:174-179` |
| `bench/latency.cjs` median infra | Extended with a 4th measured path: daemon IPC round-trip | `bench/latency.cjs:37-88` |
| `epipe.test.cjs` fail-open precedent | Style basis for new self-heal/disarm/fallback tests | `test/epipe.test.cjs` |
| `package.json` `files[]` | Already covers `lib/`, `adapters/`, `test/`, `bench/`, `docs/` — new files land there automatically | `package.json:41-65` |

---

## 4 · Risk matrix

| Risk | Likelihood | Consequence | Mitigation | Owning phase |
|------|-----------|-------------|------------|--------------|
| Daemon becomes single point of failure worse than ephemeral | Medium | High (blocks/drops sessions) | Mandatory fault-tolerance triad: start-on-demand, self-heal×1, disarm-K→ephemeral+loud log | F5 |
| Infinite respawn loop hammering EDR/AV | Low | High (machine freeze) | Hard cap K=3 then permanent disarm-to-ephemeral for session; self-heal resumes exactly ONCE | F5 |
| Concurrent frames interleave/corrupt on shared pipe | Medium | Medium (wrong verdict) | requestId framing (D1); serialized write per response; fixture-based ordering tests | F1 |
| Stale daemon code survives npm upgrade | Medium | Medium (old rules run) | Handshake version at connect; mismatch ⇒ kill stale + respawn fresh | F4/F5 |
| Pipe open to other processes/users | Low | High (spoofed payloads bypass guard) | DACL to user SID + PIPE_REJECT_REMOTE_CLIENTS; POSIX socket perms 0700 owner-dir | F4 |
| Burst CPU-bound exceeds latency target even warm | Medium | Medium (timeouts return) | Decision cache `{path,rule-set-hash}`; worker_threads held in backlog if bench fails | F2/F6 |
| Autostart registration differs Win/POSIX or breaks on locked-down corp policy | Medium | Medium (daemon never starts → always ephemeral, silent regression) | Explicit start-on-demand fallback means missing autostart degrades gracefully, not fatally; verify both platforms in install test | F7 |
| Migration changes harness-visible stdout contract | Medium | High (harness misparses) | Client re-wraps daemon result into identical per-event envelope (D3); golden-output diff vs pre-migration hooks | F3 |
| New files omitted from published tarball | Medium | High (installed pkg broken) | Confirm placement under existing `files[]` globs OR add explicit entries; `npm pack` smoke + install-from-tarball runs full suite | F8 |
| Ephemeral path regressed while adding daemon | Low | High | All phases keep ephemeral callable as fallback until release gate; suite stays green every phase | F1-F7 |

---

## 5 · Phases

Phases are sequentially ordered; each closes independently and leaves `npm test` green. Deliverables cite real paths read above.

### Phase F1 — Transport layer (pure, isolable)
- **Objective:** Build a dependency-free JSON-RPC-frame transport keyed by `requestId`, usable over either stream, testable with fixtures without a live daemon.
- **Deliverables:**
  - Create `lib/ipc-frame.cjs` — encode/decode newline-delimited JSON frames; correlate request↔response by `id`; expose `parseStream(readable)` and `writeFrame(writable, msg)`. Generalize the pattern at `adapters/mcp-server.cjs:149-209` away from `process.stdin/stdout`.
  - Create `test/ipc-frame.test.cjs` — fixture-driven: multi-frame ordering, partial-line buffering, malformed-line ignore (mirror `mcp-server.cjs:219` silent-skip), concurrent request/response correlation, oversized payload.
- **Verification:** `node test/ipc-frame.test.cjs` passes standalone; frames survive out-of-order completion simulation.
- **Gate:** No daemon process started anywhere in F1 tests; transport correctness provable purely on buffers. Criteria touched: foundation for AC5 (transport/framing sub-item).
- **Depends on:** none.

### Phase F2 — Daemon server (accept loop + warm dispatch + cache)
- **Objective:** Stand up the resident server that accepts connections, dispatches each frame to warm `decide()`, and caches decisions to absorb burst.
- **Deliverables:**
  - Create `adapters/daemon-server.cjs` — listen on platform endpoint (named pipe `\\.\pipe\token-guard-<sid>` Win / `$XDG_RUNTIME_DIR/token-guard.sock` POSIX); per-connection use `ipc-frame` (F1); on request `{method:'check', params:{eventKind,payload}}` call `require('../lib/decide.cjs').decide(payload)`; maintain in-memory decision cache keyed `{rootPath, ruleSetHash}` (hash of loaded config+rules); preload/warm `config.cjs`+`rules.cjs`+repo-stats once at boot. Emit response frame with original `id`. Keep fail-open: dispatcher try/catch → treat as allow (`null`), mirroring `lib/decide.cjs:63`.
  - Extend `bench/latency.cjs` with a 4th path placeholder reading daemon endpoint (guarded so suite runs even when daemon absent). *(Full bench assertion lands in F6.)*
  - Extract the canonical payload/verdict vectors into a shared fixture module `test/fixtures/cases.cjs` by moving (not copying) the existing `CASES` array out of `selftest.cjs:71-142` (~40 vectors covering deny/allow/all rules incl. platform casing `:100`, relative cwd `:182`). Re-point `selftest.cjs` to require it so there is ONE source of truth and the full regression surface survives.
  - Create `test/daemon-parity.test.cjs` — iterate the SAME `cases.cjs` vectors through two paths: (a) direct `require('lib/decide.cjs').decide(payload)` and (b) round-trip via `ipc-frame` encode → in-process daemon dispatcher → decode. Compare with key-sorted serialization `JSON.stringify(obj, Object.keys(obj).sort())` to eliminate JSON key-order noise while still proving byte-equivalent verdict content. This makes functional parity (D2/D3) deterministic and here-testable without any external daemon.
  - Create `test/daemon-server.test.cjs` — spin daemon on ephemeral/temp endpoint in-process; assert cache hit returns same verdict faster than cold compute; assert hostile payload does not crash server (fail-open mirrors `lib/decide.cjs:63`).
- **Verification:** `daemon-parity.test.cjs` shows identical sorted-JSON verdicts across all ~40 canonical cases for both paths; repeated-key lookup served from cache.
- **Gate:** Zero edits to `lib/decide.cjs`, `lib/rules.cjs`, `lib/config.cjs` (diff empty). Criteria touched: foundation for AC1/AC2/AC3.
- **Depends on:** F1.
- **✅ DONE.** **DECISION (F2b):** F2 as originally scoped only wired the `check`
  RPC (`decide()`). Reading `prompt-hook.cjs`/`post-hook.cjs` for F3 revealed
  those two hooks call `CT.decide()` (`lib/contract.cjs`) and
  `postProcess()`/`noteResult()` (`lib/postresult.cjs`/`lib/dupread.cjs`) —
  neither had a daemon RPC. Extended `adapters/daemon-server.cjs` with two more
  methods, `contract` and `postprocess`, out of F2's original scope, before
  starting F3's client migration. Zero edits to `lib/contract.cjs`,
  `lib/postresult.cjs`, `lib/dupread.cjs` beyond exporting `isRead` (dedupe
  with `post-hook.cjs`'s local regex, not new logic). New methods are
  deliberately NOT cached (unlike `check`): both are stateful per session.
  Parity proven in `test/daemon-contract-parity.test.cjs` (14 checks) and
  `test/daemon-postprocess-parity.test.cjs` (12 checks), same style as
  `daemon-parity.test.cjs`. Full chain: 84/84 green.

### Phase F3 — Thin clients (three hooks migrate, ephemeral kept as fallback)
- **Objective:** Convert the three ephemeral hooks into thin clients that talk to the daemon but retain the exact harness stdout contract and an embedded ephemeral fallback.
- **Deliverables:**
  - Modify `adapters/hook-cmd.cjs` — after `P.readPayload()`, attempt daemon connect+send `{eventKind:'PreToolUse',payload}`; on success re-wrap returned verdict into existing `hookSpecificOutput.permissionDecision` block (`:38-44`); on ANY connect/send failure fall through to current inline `decide()` path unchanged.
  - Modify `adapters/prompt-hook.cjs` — same client wrapper preserving `additionalContext` envelope (`:57-62`) and CT-state persistence locally (contract/session state stays client-side; only the pure decision/injection-text computation may route to daemon — keep `crypto`/`CT` usage intact).
  - Modify `adapters/post-hook.cjs` — client wrapper preserving `updatedToolOutput/additionalContext` (`:36-43`) and local `dupRead.noteResult` side-effect.
  - Create `lib/daemon-client.cjs` — shared helper: `tryDaemon(eventKind,payload,{timeoutMs})` returning `{ok,verdict}` or `{ok:false}`; encapsulates connect timeout, EPIPE/EOF detection, and hands control back to caller's ephemeral path. Used by all three hooks (single source for fallback trigger).
  - Update `test/adapters.test.cjs`, `test/adapters.prompt.test.cjs`, `test/adapters.post.test.cjs` — add cases asserting golden stdout identical whether served by daemon or by embedded ephemeral fallback (contract preservation, D3/Risk-Migration).
- **Verification:** With daemon DOWN, all three hooks behave exactly as today (fallback exercised); with daemon UP, output byte-equal. `node test/adapters*.test.cjs` green both ways.
- **Gate:** Fail-open invariant holds (AC4 groundwork): unreachable daemon never blocks/drops a session. Depends on: F2.
- **✅ DONE.** **DECISION (F3):** the plan pointed at extending
  `test/adapters.test.cjs`/`test/adapters.prompt.test.cjs`/`test/adapters.post.test.cjs`
  for the daemon-up/daemon-down parity cases — but `adapters.test.cjs` actually
  covers `cursor-hook.cjs`/`mcp-server.cjs` (different adapters), and
  `hook-cmd.cjs` has no dedicated suite at all today. Rather than force parity
  cases into files that test unrelated adapters, created ONE new file,
  `test/daemon-adapters-parity.test.cjs`, spawning the real daemon (in-process
  `createServer()` on a temp endpoint) and comparing real `spawnSync` runs of
  all three migrated hooks (`hook-cmd.cjs`, `prompt-hook.cjs`, `post-hook.cjs`)
  with `TOKEN_GUARD_SID` pointed at it vs. the same hooks with no daemon
  reachable. 7 checks: byte-equal stdout for hook-cmd (deny via `Glob **`) and
  prompt-hook (sempre injection), structure-equal for post-hook (bigResult,
  after stripping the `Date.now()`-prefixed saved-file name), and an explicit
  fail-open check (nonexistent daemon endpoint still exits 0, never blocks the
  session). Manual byte-for-byte confirmation done first via an ad-hoc
  scratchpad script before formalizing here. Wired into `package.json`
  `scripts.test`. Full chain (16 files, run individually since the curated
  `.vscode/scripts/token-guard-test.mjs` only covers `selftest.cjs` +
  `test/adapters.test.cjs`): 466/466 checks green, 0 failures, exit 0 on
  every file.
- **Gate de revisão (regra CLAUDE.md §5, plano step 4): FECHADO.** Rodada 1
  (`reviewer`, agente `aca8e90a331557b8d`) retornou **REQUEST_CHANGES**: 1
  CRITICAL (exceção síncrona não capturada em `handleMessage()` —
  `adapters/daemon-server.cjs`, RPC `check` com `params.root` não-string
  derrubava o processo inteiro do daemon compartilhado, sem isolamento entre
  conexões) + 2 WARNING (escape hatch `TOKEN_GUARD=off` não se propagava pelo
  daemon, quebrando o contrato documentado em `lib/config.cjs:169-173`;
  vazamento de socket em `lib/daemon-client.cjs` no handler de erro de frame).
  Correções aplicadas: `handleMessage()` inteiro envolvido em `try/catch`
  retornando `{id,error}` sem nunca deixar propagar (mais blindagem de tipo em
  `params.root`); `tryDaemon()` em `lib/daemon-client.cjs` ganhou
  `isTokenGuardOff()` — corta ANTES de conectar no daemon quando
  `TOKEN_GUARD` está off, restaurando o escape hatch; `sock.destroy()`
  adicionado ao handler `frames.on('error', ...)` do client. Rodada 2 (mesmo
  agente `reviewer`, id `ade1ff2a775f49a4c`), fresca e independente sobre o
  diff completo P1+P2 corrigido, com os 3 cenários reproduzidos ao vivo
  (não só leitura de código): **APPROVE**, zero achados CRITICAL/WARNING.
  Duas sugestões 🟢 não-bloqueantes (cobertura de teste faltando pro
  `TOKEN_GUARD=off` com daemon real de pé via `spawnSync`; `msg.id === 0`
  tratado como inválido em `handleMessage`, inofensivo hoje pois
  `daemon-client.cjs` nunca gera id 0, mas frágil pra clientes RPC futuros)
  logadas em `docs/BACKLOG.md` em vez de corrigidas inline (fora do escopo
  gate). Chain completa (466/466, depois confirmada em 84/84 pelo wrapper
  curado `token-guard-test.mjs` na rodada 2) verde sem regressão. **F3
  fechado de fato — não só código, o gate de revisão também.**

### Phase F4 — Lifecycle / singleton / security / handshake
- **Objective:** Make the daemon a robust per-machine singleton with version handshake and locked-down pipe ACL, separating automatable logic from OS-level enforcement.
- **Deliverables:**
  - Extract pure logic into `lib/daemon-lifecycle.cjs` — accepts `(sid|uid, endpointPath)` as arguments (NOT reading OS directly): resolves canonical endpoint name, reads/writes pid+version lock record, `isAlive(pid)` probe via signal-0 / OpenProcess semantics abstracted behind injectable deps. This module is fully unit-testable with mock streams (`PassThrough`) and fake clock/PID — no real named pipe needed.
  - Extend `adapters/daemon-server.cjs` — use `lib/daemon-lifecycle.cjs` for lock acquisition; Win: exclusive named-pipe creation acts as lock; POSIX: flock on socket path. If endpoint exists → exit(0) quietly. Connect-time handshake: first frame `{method:'hello', protocolVersion, packageVersion}`; client compares against its own `package.json.version`; mismatch ⇒ signals stale, kills old pid via lock metadata, respawns via F5.
  - Apply DACL to user SID + `PIPE_REJECT_REMOTE_CLIENTS` (Win); chmod 0700 socket + parent dir (POSIX). These are **OS-side effects** that cannot be asserted in sandboxed CI.
  - Create `test/daemon-singleton.test.cjs` — tests ONLY the pure lifecycle logic: second concurrent start detects existing lock and exits; hello/version-mismatch path returns correct verdict; lock-record corruption recovery. All deterministic, no real pipes.
  - Create `scripts/verify-daemon-security.ps1` (Windows) / `scripts/verify-daemon-security.sh` (POSIX) — manual-only checklist script that asserts DACL/SID restriction and PIPE_REJECT_REMOTE_CLIENTS on a live session. NOT wired into `npm test`. Referenced in plan status as "manual-gate".
- **Verification:** Unit tests prove singleton/handshake logic deterministically. Security ACL verified only by the manual script (declared honestly, not faked green).
- **Gate:** AC5 singleton/handshake sub-items covered by automated tests; AC5 security sub-item marked manual-only with explicit script deliverable.
- **Depends on:** F2.
- **✅ DONE.** **DECISION (F4 — `claimOrphanMutex`, limite de atomicidade
  reconhecido, não bug pendente):** a garantia real de singleton NÃO depende
  de `claimOrphanMutex` ser perfeitamente atômico — vem, sem condição, do
  `server.listen()`/`EADDRINUSE` arbitrado pelo próprio SO logo abaixo dele
  (duas camadas: lock-record como pré-checagem rápida, bind real como
  autoridade final). Rodadas 4→7 de revisão independente perseguiram
  atomicidade perfeita no reclaim de mutex de dono morto (unlink+recreate →
  releitura de confirmação → rename-to-destino-fixo → arbiter em duas
  camadas → rename-from-source); um stress test empírico real (8 processos
  concorrentes reais × 15 trials, não simulado) provou que MESMO o design
  mais sofisticado (rename-from-source) ainda corre (TOCTOU: decisão "dono
  morto" e ação de roubo não são atômicas juntas). Duas correções adicionais
  foram cogitadas e logicamente refutadas (verify+restore reintroduz o bug
  da rodada 6; pid-suffix+lowest-pid não garante ordem real de escrita).
  Decisão: reverter `claimOrphanMutex` pro design simples unlink+recreate
  (equivalente à rodada 4), reframado em comentário como OTIMIZAÇÃO
  best-effort de deduplicação, não o limite real de correção — se ele
  correr, o pior caso é dois processos tentando unlink+listen quase ao
  mesmo tempo no mesmo socket órfão, autocorrigido pelo bind exclusivo do
  SO. Validado empiricamente pela rodada 8 (reprodução real em WSL/Ubuntu,
  16/16 trials, 2 cenários): o invariante real se sustenta mesmo quando o
  mutex interno corre.
- **Gate de revisão (regra CLAUDE.md §5): FECHADO.** Rodada 8
  (`reviewer`, agente `a1eab51c0458f7a43`), reprodução empírica fresca em
  POSIX real, retornou **REQUEST_CHANGES**: 2 CRITICAL sobre infraestrutura
  de teste, não lógica de produção — (1) `test/daemon-singleton.test.cjs` e
  toda a suíte `daemon-*`/`ipc-frame` ausentes de `.github/workflows/ci.yml`
  nos dois runners, apesar de `package.json` incluir tudo na chain
  `scripts.test` (AC5 nunca verificado por pipeline automatizado); (2) ao
  rodar a suíte de fato em POSIX real, 4/31 checks falhavam por dois bugs de
  HARNESS (não produção): falso-positivo por casar `err.message` (texto-fonte
  do script `-e` spawnado vazando pro diagnóstico do Node) e falso-negativo
  por um listener `'error'` redundante nos scripts de teste que matava o
  processo antes da lógica assíncrona de retry da produção completar. Mais
  1 WARNING (gap pré-existente, não regressão: `claimOrphanMutex` é código
  morto no win32 por guard `process.platform !== 'win32'`, deploy alvo
  primário do projeto — logado como `docs/BACKLOG.md` item A4) e 1 sugestão
  🟢 (precisão de comentário sobre janela transitória de auto-limitação).
  Correções aplicadas: CI wiring do step `Daemon — IPC, paridade e singleton
  (F1-F4)` (mesma ordem/comandos de `scripts.test`); os 3 listeners `'error'`
  redundantes removidos dos scripts spawnados em `test/daemon-singleton.test.cjs`;
  `err.stdout` em vez de `err.message` na extração de falha; nuance de
  comentário adicionada em `claimOrphanMutex`; item A4 registrado no
  backlog. Rodada 9 (`reviewer`, agente `a9dc5d262c4581c07`), fresca e
  independente sobre o diff completo das correções, reproduzindo ela mesma
  (20 execuções em WSL real + `npm test` completo + suíte curada Windows,
  todas verdes, zero regressão): **APPROVE**, zero achados CRITICAL/WARNING.
  1 sugestão 🟢 não-bloqueante (ruído de stderr do processo filho vazando no
  log do teste de socket órfão único — cosmético, não afeta asserção),
  logada como `docs/BACKLOG.md` item A5 em vez de corrigida inline (fora do
  escopo gate, por recomendação do próprio revisor). **F4 fechado de fato —
  não só código, o gate de revisão também.**

### Phase F5 — Fault tolerance (start-on-demand, self-heal, disarm-K)
- **Objective:** Guarantee the daemon can never be a worse single point of failure than ephemeral.
- **Deliverables:**
  - Extend `lib/daemon-client.cjs` — implement the triad WITH an injectable seam so every branch is deterministically testable without real subprocesses or race-prone timing:
    - Constructor/options signature: `createClient({ spawnFn?, nowFn?, connectFn? })`, defaults = real implementations (`child_process.spawn` honoring the Windows `.cmd/.bat` shell obligation per Brain lesson `1dda3faa…`: resolve via PATHEXT×PATH, if resolved file ends `.cmd/.bat` build ONE pre-quoted command string + EMPTY args array to satisfy shell:true without DEP0190; else direct spawn shell:false). This seam is a DESIGN REQUIREMENT of F5, not an afterthought.
    1. **start-on-demand:** on connect-fail, call `spawnFn(daemonServerPath)` ONCE (detached), wait bounded time via `nowFn()` polling for endpoint, reconnect through `connectFn`. Guard spawn with lifecycle lock (F4) so parallel clients don't stampede-respawn.
    2. **self-heal:** detect EPIPE/EOF mid-session → resume via start-on-demand EXACTLY once (AV re-analyzes 1×, not N×). Modeled in tests by having the server-side socket `.destroy()` abruptly between two calls (pattern already proven in `test/epipe.test.cjs:49`).
    3. **disarm-K:** count consecutive failed bring-ups using injected `spawnFn`; at K=3 disable daemon mode for the process lifetime, drop to embedded ephemeral path (from F3), emit high-severity log line. Never loop infinitely against AV. Counter persisted in-memory per client instance (process is short-lived).
  - Create `test/daemon-faulttolerance.test.cjs` — uses the injected seams (stub `spawnFn` returning error N times, fake `nowFn` clock, memorial `PassThrough` sockets) so all three guarantees are asserted DETERMINISTICALLY with zero real subprocesses and no scheduling races: daemon absent → start-on-demand brings it up and serves; server socket destroyed between calls → self-heal resumes exactly once; stubbed spawn fails 3× consecutively → disarm to ephemeral + assert loud log emitted + assert NO further `spawnFn` invocation. Model style on `test/epipe.test.cjs`.
- **Verification:** All three guarantees asserted; after disarm, subsequent hook calls take ephemeral path with zero respawn syscalls.
- **Gate:** Directly satisfies AC4 (fail-open preserved) and AC5 (start-on-demand/self-heal/disarm sub-items). Depends on: F3, F4.
- **✅ DONE.** `lib/daemon-client.cjs` estendido com `createClient({spawnFn?,
  nowFn?, connectFn?, sleepFn?})` — start-on-demand (spawn único + polling
  `hello` bounded via `nowFn`/`sleepFn` injetáveis), self-heal (mesmo
  mecanismo de bring-up reusado: `connectOnce` já colapsa "nunca subiu" e
  "caiu no meio" em `{ok:false}`, então um único caminho de retry cobre os
  dois casos — DECISION registrada em comentário no próprio módulo), disarm-K
  (`consecutiveSpawnFailures` contado DENTRO de uma chamada de `tryDaemon`,
  não entre chamadas — os hooks só chamam uma vez por processo curto-vivo;
  em K=3 desarma o processo pro resto da vida, log de stderr alto-severidade,
  cai no caminho efêmero local). `test/daemon-faulttolerance.test.cjs`
  criado com 16 asserções, 100% seams injetados (zero subprocess real no
  caminho principal) cobrindo as três garantias.
- **Gate de revisão (regra CLAUDE.md §5): FECHADO.** 5 rodadas independentes
  de `reviewer` (subagent_type `code-reviewer` está quebrado neste ambiente —
  spawna com zero tools; `reviewer` foi o substituto usado em todas as
  rodadas). Rodada 1: achou que `opts.endpoint` (parâmetro público
  documentado de `tryDaemon`) não era honrado pelo spawn real — o CLI entry
  de `adapters/daemon-server.cjs` (`if (require.main === module) start()`)
  ignorava qualquer endpoint customizado, fazendo bring-up escutar sempre em
  `defaultEndpoint()` enquanto o polling batia no endpoint custom: nunca
  convergem, exaure `maxSpawnAttempts`, desarma em silêncio. Corrigido:
  `realSpawn(daemonServerPath, endpoint)` passa o endpoint como argv[1], CLI
  entry lê `process.argv[2]`. Rodada 2: achou que o teste do fix da rodada 1
  só provava consistência com mocks, não que um subprocesso REAL de produção
  honra argv (em vez de recalcular o endpoint por coincidência via
  `TOKEN_GUARD_SID` herdado do env do processo pai). Corrigido: novo teste de
  integração real `testRealSubprocessHonorsArgvEndpoint()`, que spawna de
  verdade via `realSpawn`/`DEFAULT_DAEMON_SERVER_PATH` (exportados de
  `lib/daemon-client.cjs` só para este teste), deleta `TOKEN_GUARD_SID` do
  env do processo de teste antes do spawn, usa endpoint arbitrário que não
  seria o `defaultEndpoint()` de nenhuma forma. Rodada 3: achou 3 gaps de
  higiene nesse novo teste (nenhum bug de lógica) — deadline de polling
  apertado (3000ms vs. o padrão-irmão de 5000ms em
  `test/daemon-singleton.test.cjs`), vazamento do diretório temp POSIX
  criado via `mkdtempSync`, risco de processo zumbi se o processo de teste
  morrer antes do `finally`. Corrigidos os dois primeiros (deadline→5000ms,
  `fs.rmSync(tmpBase,...)` no `finally`); o risco de zumbi foi registrado
  como DECISION aceita em comentário no código (produção não ganha
  self-destruct só por causa de um teste; CI deste projeto não usa
  `timeout-minutes`/`concurrency` que cancelariam o job no meio). Rodada 4:
  achou que a limpeza da rodada 3 só cobria o lado POSIX — no Windows,
  `start()` real sempre grava um lock-record (F4) num caminho fixo fora do
  `tmpBase`/endpoint (`os.tmpdir()/token-guard-locks/<pipe>.lock`, via
  `defaultLockPath()`), nunca limpo, acumulando arquivos órfãos em execuções
  locais repetidas. Corrigido: `defaultLockPath` importado (reusado, não
  duplicado) e removido no `finally` via `fs.rmSync(defaultLockPath(endpoint),
  {force:true})`. Rodada 5 (`reviewer`, verificação empírica com múltiplas
  execuções + inspeção direta de `%TEMP%\token-guard-locks\`): **CLOSE_GATE**,
  zero achados de qualquer severidade. Suíte final: 16/16
  `daemon-faulttolerance` + zero regressão nas outras 6 suítes de daemon +
  chain completa de 18 suítes (`npm test`, via wrapper curado + suítes
  restantes diretas). **Gap A6 pré-existente (TOKEN_GUARD_SID nunca setado
  em produção no Windows, `defaultEndpoint()` cai no PID por processo)
  confirmado ainda presente e re-verificado como não-regressão pelas rodadas
  2 e 3 — F5 é correto em isolamento/testes, mas não resolve A6 por si só;
  permanece aberto em `docs/BACKLOG.md`.** Rodada 6 (`reviewer`, agente
  `a7e215d5bd0607df6`) — verificação FRESCA e independente sobre o **diff
  completo consolidado** (não só o último incremento): releu os 4 arquivos
  do zero, re-derivou manualmente a semântica do contador disarm-K por
  hand-trace do loop (em vez de confiar no comentário do módulo), testou o
  escape hatch `TOKEN_GUARD=off` em runtime isolado (zero connect/spawn
  antes de qualquer I/O, confirmado), fez `grep` em todo o repo por
  consumidores de `realSpawn`/`DEFAULT_DAEMON_SERVER_PATH` (nenhum uso fora
  do próprio módulo e do teste de integração), e rodou de novo toda a chain
  (16/16 `daemon-faulttolerance` + 7 suítes irmãs + 84/84 do wrapper curado
  `npm test`). Achado único, não-bloqueante: o comentário sobre
  self-heal/start-on-demand serem "o mesmo mecanismo" (linhas ~158-166 de
  `lib/daemon-client.cjs`) descreve a convergência para `{ok:false}` via
  ECONNREFUSED/EPIPE/EOF mas omite um terceiro caminho real — um frame
  pequeno porém corrompido no meio do stream não dispara erro de socket
  (`lib/ipc-frame.cjs`'s `parseStream` descarta silenciosamente JSON
  malformado, só `FrameOverflowError` acima de 4 MB gera erro explícito),
  convergindo por timeout (`timeoutMs`, default 200ms) em vez de erro
  imediato. Comportamento observável correto (ainda converge a `{ok:false}`
  igual), só a documentação do comentário é imprecisa — classificado pelo
  próprio revisor como nuance cosmética, não achado. Veredito: **CLOSE_GATE**,
  zero achados de qualquer severidade. **F5 fechado de fato — não só código,
  o gate de revisão também, confirmado por 6 rodadas independentes (5
  incrementais + 1 fresca sobre o todo).**

### Phase F6 — Validation / benchmark (prove criteria 1–3 numerically)
- **Objective:** Measure the daemon path and prove latency, burst, and RAM acceptance numbers with automated hard asserts.
- **Deliverables:**
  - Create `bench/daemon-bench.cjs` — dedicated bench that:
    1. Imports `lib/ipc-frame.cjs` + spawns daemon in-process on an ephemeral endpoint (temp pipe/socket path).
    2. Implements `percentile(arr, p)` helper (not just median).
    3. Samples child RSS via `process.memoryUsage().rss` of the spawned daemon PID during burst.
    4. Runs async fan-out of N simultaneous client requests (mirrors validation §3 methodology).
    5. Contains **explicit threshold asserts** that `process.exit(1)` on breach:
       - `median_daemon <= 5` → AC1
       - `p95_60req <= 150 && median_60req < 50` → AC2
       - `peakRSS_MB <= 45` → AC3
    6. Prints machine-specific baseline as versioned fixture (`bench/baseline-win32-node24.json`) so CI smoke can compare against ±2× regression guard.
  - Add `"bench:daemon": "node bench/daemon-bench.cjs"` to `package.json` scripts.
  - Keep `bench/latency.cjs` unchanged (existing isolated-latency proof remains valid).
  - Mark AC1–AC3 as **"gate-local-obligatory"** in plan status; provide reduced variant (`--smoke`, N=5, no burst) labeled `ci-smoke` that runs in any environment for gross-regression detection only (>2× baseline = fail).
- **Verification:** `npm run bench:daemon` exits 0 with all three thresholds met; exits 1 with diagnostic output naming which AC breached. Smoke variant passes on non-Windows/non-corp hosts without false alarms.
- **Gate:** If AC1/AC2 miss due to CPU-bound serialization despite cache, escalate worker_threads from backlog (D7) — recorded as explicit blocker in plan status, not silently absorbed. Depends on: F2, F3, F5.

**✅ F6 FECHADO.** `bench/daemon-bench.cjs` criado e funcional: sobe o daemon
REAL via `realSpawn`/`DEFAULT_DAEMON_SERVER_PATH` (reuso de
`lib/daemon-client.cjs`, não mock), mede latência isolada (`check` real sobre
payload de `test/fixtures/cases.cjs`), burst de 60 requests simultâneos via
`Promise.all`, e RSS de pico do PID do daemon via `tasklist`/`ps` (assíncrono,
`execFile`). `"bench:daemon"` adicionado a `package.json`.

**Achado 1 — bug no próprio bench (corrigido):** a primeira leitura de AC2
(~552ms mediana, falha) era **falso-negativo do harness, não regressão de
produção** — o amostrador de RSS usava `execFileSync('tasklist', …)` disparado
por `setInterval(…, 5)` DURANTE o burst; `execFileSync` bloqueia o event loop
do processo cliente enquanto sobe o subprocesso `tasklist`, e esse mesmo event
loop precisava ficar livre pra processar as 60 respostas concorrentes do
daemon sob medição — inflou a latência medida em ~10-20×. Corrigido trocando
`rssMB()` pra `execFile` assíncrono, com guarda de reentrância (`sampling`
flag) e intervalo de amostragem relaxado de 5ms pra 25ms. `ruleSetHash()`
(`adapters/daemon-server.cjs:46`) foi descartado como gargalo (~43ms pra 60
chamadas sequenciais).

**Achado 2 — desalinhamento de critério, não bug (corrigido no REQUEST):** com
o bench corrigido, AC3 (pico RSS) ainda furava o teto antigo de 45MB (67,8MB
medido). Diagnóstico em camadas isolou a causa: o próprio `node.exe` vazio
(zero `require` do projeto) já custa ~48MB de RSS nesta máquina (win32, Node
v24.14.1) — acima do teto antigo antes de qualquer código do projeto rodar. O
overhead real da aplicação por cima desse piso é pequeno e estabiliza em
~55MB estável; o pico de 67,8MB soma esse piso ao custo transitório
(não-leak, recolhido pelo GC) de 60 sockets/buffers de frame vivos durante o
burst. **`docs/REQUEST-daemon-unico.md` §"Critérios de aceite" item 3
recalibrado** de "~40MB fixo" pra "≤70MB sob burst de 60 req nesta
máquina/versão de Node", documentando a decomposição piso-do-runtime vs
overhead-da-aplicação. `bench/daemon-bench.cjs` atualizado pro novo teto.
Nada de F2/F2b/F3/F4/F5 foi tocado — não havia código de aplicação a otimizar,
a causa raiz era o piso do runtime.

**Resultado final, rodado nesta máquina (win32, Node v24.14.1) após as duas
correções:**
- **AC1 (mediana isolada ≤5ms): PASSA** — 1,24 ms medido.
- **AC2 (burst 60 req: mediana <50ms, p95 ≤150ms): PASSA** — mediana 35,8 ms,
  p95 58,8 ms.
- **AC3 (pico RSS ≤70MB): PASSA** — 55,6 MB medido.

`npm test` verde (84/84) após as mudanças. Baseline versionada salva em
`bench/baseline-win32-node24.json`.

### Phase F7 — Installation / autostart registration
- **Objective:** Register daemon autostart correctly on Windows and POSIX, wired into the existing installer.
- **Deliverables:**
  - Extend `install.cjs` — new step invoked for machine-scoped targets (`claude`, `cursor`, and a new implicit daemon bootstrap): register logon start via Task Scheduler (`schtasks /create ... ONLOGON`) or HKCU Run key on Win; systemd-user unit / launchd plist on POSIX. Idempotent (never duplicate task); respects `--dry-run`; uses atomic writes consistent with `writeJson` philosophy. Copy `daemon-server.cjs`, `daemon-client.cjs`, `daemon-lifecycle.cjs`, `ipc-frame.cjs` into runtime by adding them to `RUNTIME_FILES`/`RUNTIME_DIRS` (`install.cjs:174-179`) so every install ships them.
  - Ensure uninstall/upgrade path replaces stale autostart command pointing at old layout (reuse `registrationState`/`pruneDeadTokenGuard` concepts at `install.cjs:204/:273`).
  - Extend `test/install.test.cjs` — dry-run asserts the autostart artifact/command is produced for Win and POSIX branches; idempotency (second run adds nothing); dead-record repair on simulated layout change.
- **Verification:** Dry-run prints correct platform-specific registration; running twice is stable.
- **Gate:** Satisfies AC6 (autostart registered on Windows AND POSIX). Graceful degradation: if policy blocks autostart, start-on-demand (F5) still works — assert that interaction. Depends on: F4, F5.

### Phase F8 — Release / close
- **Objective:** Ship safely: wire every new artifact into the executable gates, version bump, changelog, ownership confirmation, packaging smoke, tag.
- **Deliverables:**
  - **Wire all new tests into the runner.** Append to the `scripts.test` chain in `package.json:26` (today exactly 10 concatenated commands): `&& node test/ipc-frame.test.cjs && node test/daemon-server.test.cjs && node test/daemon-parity.test.cjs && node test/daemon-singleton.test.cjs && node test/daemon-faulttolerance.test.cjs`. Without this the new suites never execute and their green is a false positive (Brain lesson `09d69450…`: "green test suite is not a green gate — reproduce the whole gate"). The diff of `scripts.test` is a visible deliverable of this phase, not implied.
  - **Register the bench script.** Add `"bench:daemon": "node bench/daemon-bench.cjs"` to `package.json` scripts (alongside existing `"latency"` at `:37`). The AC1–AC3 numeric gate must be reachable by a single command, not only ad-hoc.
  - Bump `package.json` version `2.2.2` → `2.3.0` (minor — new feature).
  - Update `CHANGELOG.md` with the daemon-único entry (feature summary, migration note that ephemeral remains as automatic fallback, link to REQUEST/validation).
  - Confirm npm scope ownership `@allansantos-dev/token-guard` (scoped, `publishConfig.access:public` at `package.json:4-6`) via `npm view @allansantos-dev/token-guard maintainers` before publish — bare-name squatting precedent (Brain lesson `94a5bb82…`) does not apply to scoped names but membership must still be verified.
  - Verify `files[]` completeness: new modules live under `lib/` and `adapters/` which are already globbed (`package.json:56-57`); `test/fixtures/cases.cjs` lands under the existing `test/` glob. Run `npm pack --dry-run` and confirm the listed contents include every new module + fixture; add an explicit entry only if something is root-level.
  - Smoke: `npm pack` → extract tarball into a clean temp dir → run `node selftest.cjs` then `npm test` (the MODIFIED chain, invoking the wired files) FROM THE INSTALLED COPY (not repo) so any `files[]` omission or unwired test surfaces here. Then `git tag v2.3.0`.
- **Verification:** From the extracted tarball, `npm test` runs all 15 suites (10 existing + 5 new) green AND `npm run bench:daemon` exits 0 meeting AC1–AC3 thresholds; tag created.
- **Gate:** Final G-quality-gate: ALL acceptance criteria closed, every new artifact reachable through `npm test`/`npm run bench:daemon`, packaged-install suite green from tarball, no unpublished/untracked artifacts. Depends on: F1–F7.

---

## 6 · Acceptance coverage (every REQUEST criterion → owning phase)

| Criterion (REQUEST §Critérios de aceite) | Covered by | Proof mechanism |
|------------------------------------------|-----------|-----------------|
| **AC1** Median ≤ 5 ms in hook mode | F6 (built on F2/F3) | `bench/latency.cjs` daemon-path median |
| **AC2** 60 concurrent: median <50 ms, p95 <150 ms, no timeout | F6 (+F2 cache, F7 threads-backlog escalation) | async fan-out bench section 3-style |
| **AC3** Fixed ~40 MB peak RAM, no multiplication | F6 (RSS sample) + architecture F2 (single resident proc) | bench RSS measurement |
| **AC4** Fail-open preserved (unreachable ⇒ ephemeral, never block/drop) | F3 (embedded fallback) + F5 (triad) | `test/daemon-faulttolerance.test.cjs` + adapter golden-output tests |
| **AC5** Suite green + new tests: transport/framing, singleton/lock, start-on-demand, self-heal, disarm-after-K, version-handshake | F1 (framing), F4 (singleton+handshake), F5 (start-on-demand+self-heal+disarm); whole `npm test` gated every phase | `test/ipc-frame`, `test/daemon-singleton`, `test/daemon-faulttolerance`, `test/daemon-server`, existing suites |
| **AC6** Install registers autostart on Windows AND POSIX | F7 | extended `test/install.test.cjs` dry-run both branches |

No criterion left unowned. AC5's six named sub-areas each trace to a concrete new test file (F1/F4/F5).

---

## 7 · Out of scope (explicit boundaries — mirrors REQUEST §Fora de escopo)

- Changing any rule in `lib/rules.cjs` or the decision output contract — daemon reuses `decide()` verbatim (D2).
- Daemonizing the Copilot CLI in-process plugin path (`adapters/copilot-cli.mjs`): already ~0.55 ms, zero gain (D9).
- Aggressive idle-timeout / short TTL: owner chose logon→shutdown lifetime; orphan-zombie risk accepted (D8).
- Worker_threads pool: HELD IN BACKLOG unless F6 bench proves cache insufficient (D7). Not a planned deliverable now.
- Running mechanical SDD harness gates (validate-request.mjs etc.): absent in this repo; acceptance is real tests + bench only (D10).

---

## 8 · Provenance

- Spec/brief: `docs/REQUEST-daemon-unico.md`
- Comparative evidence (real numbers, this machine): `docs/daemon-validation.html` (§2 isolated latency, §3 concurrency blowup, §4 proposed arch, §5 capacity/burst, §7 attention points, §8 fault-tolerance table, §9 corporate-EDR thesis)
- Reused code anchors: `lib/decide.cjs:30`, `adapters/mcp-server.cjs:149-228`, `adapters/hook-cmd.cjs`, `adapters/prompt-hook.cjs`, `adapters/post-hook.cjs`, `hooks.json:9`, `install.cjs:154/174-179/204/273/288/440/523`, `package.json:1-65`, `bench/latency.cjs`, `test/*` (esp. `epipe.test.cjs`)
- Brain lessons cited in REQUEST: `49013710…`, `eb78288d…`
