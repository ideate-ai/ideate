# @ideate/plugin

The public, composable surface of **ideate** — a Claude Code plugin for
AI-augmented software delivery.

ideate decomposes into three functions: a **process record** (the durable,
auditable trail of what was decided and done — append-only, project-local,
never curated or ranked by ideate itself), a **knowledge graph** (memory and
retrieval over that trail — developed as a separate project, not part of this
plugin), and a **delegation board** (how work is handed to and coordinated
across agents — a future sibling capability, not part of this plugin today).
ideate is deliberately non-prescriptive about workflow: it supplies primitives
that fire mechanically, not a process you are told to follow, and it never
blocks, redirects, or opines on what you do.

## What this plugin provides today

This package ships the **Layer-0 floor**: the append-only process record and
the mechanical capture/priming wiring around it. Nothing here is optional
workflow — every piece below fires without requiring an agent to remember to
call it.

- **An append-only process record.** Every entry — a decision, a finding, a
  session outcome, a subagent outcome, a commit boundary, a task completion —
  is appended, never updated or deleted; a correction is a new record that
  references the superseded one. Every write passes a capture-time
  secret-scanning gate before anything touches disk.
- **Capture hooks.** `SessionEnd`, `PreCompact`, `SubagentStop`,
  `TaskCompleted`, and `PostToolUse` (on `git commit`) are wired in
  `hooks/hooks.json` so records are captured mechanically as you work, with
  zero required tool calls. Every ideate hook is non-blocking: it exits 0,
  writes side effects and `additionalContext` only, and never blocks,
  denies, or halts anything the host is doing.
- **Session priming.** At session start, and on subagent start, a bounded,
  unranked digest of the most recent process records is surfaced as
  additional context — recency- and scope-selected only, never scored or
  curated, and explicitly framed as quoted historical data rather than
  instructions.
- **Telemetry.** Native counters for capture, priming, and failure events,
  inspectable with the `ideate-telemetry` CLI.

## Install / build

Prerequisites: Node >= 22 and a pnpm-compatible install.

```sh
pnpm install
pnpm run build   # compiles src/ to dist/ — required before the MCP server
                 # or the CLIs will run; dist/ is not checked in
pnpm test        # vitest, fork pool capped at 4 (see vitest.config.ts)
```

`pnpm run test:fresh-copy` runs `scripts/fresh-copy-check.mjs`, which copies
this directory to a scratch location with no surrounding project context and
re-runs install/build/test there — the mechanical proof that this package
stands alone.

## The process-record surface

The record core has exactly two transports over one implementation: three
MCP tools, and a CLI. Both write through the same gated append-only store, so
a record captured via one transport is indistinguishable from one captured
via the other.

**MCP verbs** (registered by the ideate MCP server, `dist/server.js`):

- `record_append(kind, claim, verification_anchor?, scope?, content, task_id?)`
  — append one process record. Open-vocabulary `kind` (e.g. `finding`,
  `session-outcome`, `commit-boundary`, …).
- `record_read(scope?, limit?)` — read records newest-first, optionally
  filtered by a plain substring match against scope/kind/source. Unranked:
  selection only, no scoring.
- `record_decision(claim, rationale?, verification_anchor?, scope?, task_id?)`
  — sugar for `record_append(kind="decision", ...)`; the ADR entry point.
  The decision write *is* its capture — there is no separate decision store.

**`ideate-record` CLI** (`bin/ideate-record`, the same gated core as a
standalone executable — this is what the capture hooks invoke):

- `ideate-record append --kind <k> --claim <c> [--anchor <a>] [--scope <s>] [--content <text>|-] [--task <id>]`
  — append one record directly; exits 1 on failure.
- `ideate-record read [--scope <substring>] [--limit <n>] [--json]` — print
  records newest-first; exits 1 on failure.
- `ideate-record session-end` — reads a `SessionEnd` hook payload from stdin
  and appends a recall-shaped session-outcome record. Hook path: always
  exits 0 (a capture failure must never look like a hook failure to the
  host).
- `ideate-record prime [--scope <substring>] [--budget <n>]` — print a
  compact, unranked digest of the most recent records for hook
  `additionalContext`. Hook path: always exits 0.

## Honest status

- **Available now:** the append-only process record, the five mechanical
  capture points (`SessionEnd`, `PreCompact`, `SubagentStop`,
  `TaskCompleted`, `PostToolUse` on `git commit`), session/subagent priming,
  the capture-time secret-scanning gate, and native telemetry counters.
- **Not yet built:** the delegation board (work-state coordination across
  agents). This is a future sibling capability; nothing in this plugin
  depends on it.
- **Eval-gated, not yet built:** any feature whose value is an
  intelligence-adjacent claim is withheld until the evaluation harness
  (`@ideate/harness`, private, not part of this package) demonstrates it,
  per gates G1–G7 of the project's eval design. This includes: planning-time
  gap identification (`/ideate:gap-check` and its advisory hook — designed,
  not built, gated on G4), and per-prompt priming (technically wireable, but
  deferred — its token-cost tradeoff is exactly the kind of default the
  harness must license first, gated on G1/G2). None of this plugin's shipped
  behavior depends on either.
- This package is `"private": true` in `package.json` and stays that way
  until publishing this plugin to npm is separately ratified.

## License

AGPL-3.0-only — see [`LICENSE`](./LICENSE).
