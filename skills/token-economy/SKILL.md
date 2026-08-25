---
name: token-economy
description: "Como trabalhar em repositórios grandes sem estourar a janela de contexto. USE FOR — investigar código que você ainda não conhece, escolher entre buscar e ler, decidir quando delegar a um sub-agente, reagir a um bloqueio do token-guard, auditar o custo de contexto de um repositório, reduzir custo de sessões de IA. Gatilhos — 'está caro', 'estourou o contexto', 'a sessão ficou lenta', 'token-guard bloqueou', 'como reduzir tokens', 'auditar o repositório'. DO NOT USE FOR — escrever código de negócio, revisar lógica, decidir arquitetura de software, ou quando o repositório é pequeno (menos de ~400 arquivos), caso em que o custo é irrelevante e a disciplina só atrapalha."
---

# Token economy in large repositories

## What

A working discipline for keeping the context window spent on reasoning instead of
on material nobody reads. The cost driver is not prompt length; it is **what gets
loaded**. On a real repository the payload dwarfs the window by three orders of
magnitude, so selection *is* the architecture.

Run the audit for this repository's real numbers: `node .github/token-guard/token-audit.cjs`
(repo installs) or `npx @allansantos-dev/token-guard audit` — whichever your install target provides.

## When to use

Reach for this when you are about to explore code you don't already know, when a
session is getting slow or expensive, or when `token-guard` denied a tool call and
you need the cheap alternative.

Skip it on small repositories: below roughly 400 files the whole codebase costs less
than the discipline, and the guards stay out of your way by design.

## Do

- **Locate before reading.** Search content in `files_with_matches` mode first: it
  answers "where does this live" in a handful of lines. Only then open files, and
  only with a line range around the hit.
- **Bound every search on at least one axis** — type (`**/*.java`), directory
  (`paths: ["src/main"]`) or name (`**/*Service*`). An unbounded listing answers
  "what exists", which is almost never the question.
- **Delegate wide investigation to a sub-agent.** Anything that needs many files or
  many dead ends belongs in a disposable window. Import the verdict, not the search.
  Sub-agents also run in parallel and can use a cheaper model for mechanical work.
- **Read the source, never the artifact.** Compiled output, bundles, lockfiles and
  vendored dependencies are generated: read what produces them.
- **Cap shell output.** The terminal is the back door — every printed line is billed.
  Filter by name/extension and pipe through a limit
  (`| Select-Object -First 50`, `| head -50`).
- **Write down what you learned.** A decision recorded once costs a fraction of
  rediscovering it every session, for every person.
- **Treat a guard denial as a rewrite instruction.** It carries the cheap
  alternative; apply it and re-run rather than looking for a way around it.

## Don't

- **Don't dump a directory to find out what's in it.** That is the single most
  expensive move available and it never answers a real question.
- **Don't read a large file whole to use twenty lines of it.**
- **Don't run content-mode search across the whole repository with no result cap.**
  The scan is cheap; the output is what enters the window, and uncapped it is unbounded.
- **Don't paste a transcript of your investigation into the answer.** Dead ends and
  intermediate reads are exactly what should be discarded.
- **Don't re-verify what is already established** in this session.
- **Don't disable the guards to move faster.** If a rule is wrong for this repository,
  fix the rule in `token-guard.config.json` — that fix helps everyone who clones the
  repo. `TOKEN_GUARD=off` exists for emergencies, not for daily use.
- **Don't apply any of this to a small repository.** Ceremony without payoff is its
  own kind of waste.

## Levers beyond this kit

The harness and provider give levers this kit deliberately does not duplicate.
Use them together:

- **Compact before you overflow.** `/compact` (or your harness's equivalent)
  summarizes history mid-session; `/clear` when switching tasks entirely. A lean
  200k window beats a bloated larger one — accuracy degrades as context fills
  ("context rot").
- **Route the model by difficulty.** Mechanical work (bulk reads, log triage) fits a
  cheaper/faster model; reserve the strong model for design and review. In Claude Code,
  pair this with reasoning-effort control instead of leaving thinking at max.
- **Keep prefixes cache-stable.** Prompt caching discounts repeated prefixes ~90%:
  don't churn `CLAUDE.md`/config files mid-session, and keep stable instructions ahead
  of volatile ones so the cached prefix survives.
- **Prefer CLI over MCP when equal.** A shell command costs one line; an MCP tool costs
  its schema on every request. Reserve MCP for what genuinely needs structure.
- **Slim your MCP fleet.** Run `npx @allansantos-dev/token-guard mcp-cost` — servers over ~1.5k tokens of
  schema and tools over ~500 are flagged with actionable advice. Tool search / slimmed
  servers routinely cut preamble 50–85% in published benchmarks.
- **Delegate verbosity to sub-agents.** Anything where the process is verbose but only
  the conclusion matters (bulk reads, test runs, log scans) belongs in a disposable
  window that returns the verdict, not the transcript.

Sources behind these numbers: Anthropic "Token-saving updates" (Nov 2025),
Anthropic context-editing docs, MCPSlim benchmarks, community Claude Code cost guides (2026).
