# Slice SPEC: the token-guard PreToolUse guard behind an HTTP hook listener

Native performance lens for token-guard. The three native proofs (C# Native AOT, Rust, Go) are built from this file.
The reference is the REAL `lib/decide.cjs` `decide()` plus `lib/claude-hooks.cjs` `preEnvelope()`; a Node listener of the same
slice lives in `native-lens/node-ref/slice.cjs` and passes `native-lens/equivalence/run.mjs`.

Why this slice: it is what the resident daemon does for every `Bash`, `PowerShell`, `Read`, `Grep`, `Glob` and MCP file-read
PreToolUse call of Claude Code (`POST /token-guard/pre` of the http hook). It is string and path logic, a handful of `stat`
and small-file reads, and no state between calls, so memory, CPU, start time and binary size are the only things that can
differ between stacks.

## 1. Binary and command line

`slice[.exe] --port N --token T`

- Binds `127.0.0.1:N` only. One process, no child process, no window (console subsystem is fine), no telemetry, no network
  other than the listener. **Writes no file.** Standard library only, or the smallest well-known dependency (say which).
- After the socket is listening print exactly one line to stdout and flush: `READY port=<N> impl=<csharp|rust|go>`.
- Keep-alive HTTP/1.1 must work (the load driver reuses connections and opens a new one per call in one phase).
- Stops when killed.

## 2. HTTP

Header `X-Token-Guard: <T>` (name case-insensitive), compared in constant time. Replies are `Content-Type: application/json`.

| Request | Answer |
|---|---|
| `GET /token-guard/health` with token | 200 `{"ok":true,"pid":<pid>,"impl":"<name>"}` |
| `GET /token-guard/health` without or with a wrong token | 401 `{"error":"token ausente ou invalido"}` |
| `POST /token-guard/pre` without or with a wrong token | 401 (same body) |
| `POST /token-guard/pre`, body not JSON | 400 `{"error":"JSON invalido"}` |
| `POST /token-guard/pre`, body JSON | 200, body = the envelope of section 4 or `{}`; header `x-tg-rule: <rule id>` ONLY when the answer is a deny |
| any other method/path (including `GET /token-guard/pre`) | 404 `{"error":"rota desconhecida"}` (checked BEFORE the token) |

The body may be large (the cases include 3 MB). Any JSON value is a valid body: an array, `null` or a number is answered
`200 {}` (fail-open: a hostile payload never blocks).

## 3. The decision (reference: `lib/decide.cjs`, `lib/rules.cjs`, `lib/payload.cjs`, `lib/config.cjs` repoStats, `lib/statedir.cjs`)

Port, from the real files, character for character where a regular expression or a string is involved:

- `payload.cjs`: `toolName`, `toolInput`, `cwd` (fallback when no cwd key: the process working directory), `parseArgs` (Copilot
  `toolArgs` as a JSON string). The runtime formats `toolCall.{toolName,input}`, `tool_name/tool_input`, `toolName/toolInput`,
  `toolArgs`, `name/input` all appear in the cases.
- `decide.cjs`: the `WATCHED` triage, then config, then `RULES.evaluate`, fail-open on any internal error (an exception in the
  port must turn into `{}`, never a 500).
- `decide.cjs` WATCHED also names `directory_tree` (family `tree`: `broadScan` denies it at the root or with no real path) and
  `search_files` (family `glob`, same treatment as `Glob`).
- `rules.cjs`: the four rules `noisePath`, `blindRead`, `broadScan`, `shellDump`, in the REGISTRY order, first hit wins,
  with the same `reason` strings (they are compared; see section 6). All the helper functions they use come with them.
- The `reason` of a deny is `hit.reason` plus, when repo stats are NOT found, the "dica" suffix of `decide.cjs`.
- `config.default.json` is the whole configuration: mode `block`, all four rules on, `readBytesWithoutRange` 51200,
  `minRepoFilesForScanGuard` 400, `charsPerToken` 4, empty allowlist and `noiseDirsExtra`. **No config file is read** (the real
  decide also merges project and user config files and honors the `TOKEN_GUARD=off|0|false` kill switch; both are outside the slice). Targets are not passed: modes are identical.
  `noiseDirs` and `sourceExt` defaults come from `lib/config.cjs`.
- Repo stats: `repoStats(root)` = `<stateDir(root)>/repo-stats.json`, JSON `{totalFiles, pathChars}`; a missing, unreadable or
  non-JSON file is `null` (no relaxation, "dica" suffix added). Port `statedir.cjs` `stateDir(root)` WITHOUT session id
  (`originOf` returns `root`): `projectRoot` walking up with the marker list and `neverProject`, `dataHome()` on win32
  (`%LOCALAPPDATA%\token-guard`, else `<home>\AppData\Local\token-guard`) and the SHA-1 of the lower-cased absolute path.
  Pin files and pruning are NOT part of the slice (never written).
- Platform: behave as **Windows** (case-folding path comparison, `\` and `/` both accepted, `win32` branches), whatever OS runs.
- Seams from the environment, as Node's `os` reads them on Windows: home = `USERPROFILE`, else `HOMEDRIVE`+`HOMEPATH`;
  temp dir = `TEMP`, else `TMP`, else `%SystemRoot%\temp` (Node tries `windir` before `SystemRoot`; with neither set the result is the literal `undefined\temp`), trailing backslash removed except right after a drive colon; `LOCALAPPDATA`.
- File system access allowed and expected: `stat` for the size of the file a Read names, `exists` checks of project markers,
  reading `repo-stats.json`. Nothing else. Node hands every path to the OS through `path.win32.toNamespacedPath` (the `\\?\` prefix), so the OS applies no normalization of its own: a file named `X.java.` or `X.java ` (trailing dot or space) is ENOENT in Node, which means allow, while a plain native `stat` would find it. The port must add the same prefix before `stat`, `exists` and the `repo-stats.json` read.
- Number formatting: `fmt()` is `toLocaleString('pt-BR')` (needs ICU in Node, reimplement it: `.` grouping, `,` decimal, at most 3 decimals) and `bytesHuman` uses `toFixed` (exact decimal, ties rounded up).
- Node version: the `path.win32` behaviour (reserved device names, `normalize`/`join`/`resolve`) differs between Node releases; the ports were checked against the Node of the measuring machine, and the expectations only line up on a Node with the same logic.
- Smart Tool is treated as NOT installed: the `read_document` suggestion branch (MCP configuration discovery) never fires.
  The cases run with an empty home, so the real function never fires it either.

## 4. Envelope

Allow (`decide` returned null): `{}`.
Deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<reason>"}}`.

## 5. What is out of the slice

The verdict cache, the event log (`events.cjs` records a deny to disk in the real daemon), the PostToolUse and prompt routes,
the MCP route, the UI, the tray, the single-instance pipe, auto-update. These are the rest of the daemon; the report says what
they cost in the Node daemon (the baseline) so the reader can see what a native listener leaves out and what still needs porting.

## 6. Equivalence

`equivalence/gen-cases.cjs` writes `cases.jsonl` (1022 cases at `c05e1cf`: the 148 real `test/fixtures/cases.cjs` cases, 757 mutations of
their shell commands, 12 hostile-payload cases, 105 project-layout cases that exercise the stats branches). Each line is
`{id, group, label, payload, expect:{body, rule, decision}}` with the expectation produced by RUNNING the real `decide`.
`equivalence/run.mjs` sends each payload and requires: HTTP 200, `permissionDecision` equal, `x-tg-rule` equal. A body whose
`reason` text differs is counted separately (`reason_text_differs`) and is expected to be 0: the reasons are part of the contract
(they carry the cheap rewrite the agent follows). 12 protocol checks follow. `equivalence/negative-control.cjs` (always `{}`)
must fail with exit code 1. The exit code of `run.mjs` is 1 on any mismatch, any `reason_text_differs` or any protocol failure.

Run one listener with `bash native-lens/equivalence/prove.sh <name> <command...>` (needs `NL_WORK`, the folder with
`cases.jsonl` and its `fixtures/`, and an `NL_PORT`). The script gives the listener an empty `HOME`, `TEMP` equal to the fixture
folder, a fresh port and token, and kills it by PID at the end.

Where regular-expression engines differ (RE2 in Go and Rust has no lookahead, lookbehind or backreference; .NET is
backtracking and close to JavaScript; JavaScript `\s`, `\w`, `\b` and case-insensitive Unicode rules are not identical to
either), write the matching by hand and say so in the source header. Each such place goes into the report.

## 7. Baseline

The three ports were proven against the reference at `c05e1cf` (1022 cases, 0 mismatches, 0 reason-text differences, 0 protocol failures; each with a mutation that makes the proof fail). The slice is target-less on purpose: the Codex/Cursor shell-read refusal of a large file (a `target` branch of `blindRead`) is not in the ports. A later reference commit that adds cases or changes a reason needs the ports re-synced before `cases.jsonl` is regenerated. The measured comparison is in `docs/research/lente-nativa-medicao-2026-11-23.md`. `prove.sh` kills the listener by its MSYS PID; a slow first start of a fresh `.exe` can leave an orphan on the port, so check the port before a re-run.
