# @ideate/plugin

[![CI](https://github.com/ideate-ai/ideate/actions/workflows/ci.yml/badge.svg)](https://github.com/ideate-ai/ideate/actions/workflows/ci.yml)

The public, composable surface of **ideate** — a Claude Code plugin for
AI-augmented software delivery.

ideate decomposes into three functions: a **process record** (the durable,
auditable trail of what was decided and done — append-only, project-local,
never curated or ranked by ideate itself), a **knowledge graph** (memory and
retrieval over that trail — developed as a separate project, not part of this
plugin), and a **delegation board** (how work is handed to and coordinated
across agents — this plugin ships its LOCAL backend; the hosted, multi-person
board is a future sibling service behind the same contract).
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

## Install

There are two ways to wire this plugin into a Claude Code project. Both land
on the same `dist/server.js` MCP server and `hooks/hooks.json` — the
manifests below are just two different ways of pointing Claude Code at them.
This section documents the contracts (what each mechanism provides); it does
not prescribe which one to use or what workflow to run once installed.

### (a) Marketplace install

This repo ships `.claude-plugin/marketplace.json`, a Claude Code
plugin-marketplace manifest listing this plugin (`name: ideate`, `source:
"./"` — the repo root). From within Claude Code:

```
/plugin marketplace add ideate-ai/ideate
/plugin install ideate
```

This is the manifest-driven path — Claude Code resolves the plugin and
wires `.mcp.json` / `hooks/hooks.json` for you. **Known limitation (honest
status):** this repo deliberately does not commit built output (`dist/` is
git-ignored), and a plugin install performs no build step — so the MCP
server and CLIs are NOT functional straight from a marketplace install
today. Until a distribution mechanism for built output exists (tracked as
an open question in the project record), use the manual path below, which
is the tested, supported route. The observable symptom is Claude Code
reporting that the ideate MCP server failed to start, or that it
disconnected, immediately after a marketplace install — that is the
expected result of the missing built output, not a separate bug.

### (b) Manual wiring

For a project that wants to point at this plugin directly rather than
through the marketplace resolver:

1. Build the package: `pnpm install && pnpm run build` (compiles `src/` to
   `dist/`; required before the MCP server or CLIs will run — `dist/` is not
   checked in).
2. Add an MCP server entry to the consuming project's `.mcp.json` pointing
   at the built server, e.g.:

   ```json
   {
     "mcpServers": {
       "ideate": {
         "command": "node",
         "args": ["<path-to-this-plugin>/dist/server.js"]
       }
     }
   }
   ```

   This registers the three MCP verbs (`record_append`, `record_read`,
   `record_decision`) described below.
3. Wire the mechanical capture hooks by pointing the consuming project's
   host at this plugin's `hooks/hooks.json`. That file declares the actual
   hook shape this plugin provides — `SessionStart` (priming via
   `bin/ideate-record prime`), `SubagentStart`/`SubagentStop`, `SessionEnd`
   (`bin/ideate-record session-end`), `PreCompact`, and `PostToolUse` on
   `git commit` — each entry a `command` hook invoking either
   `${CLAUDE_PLUGIN_ROOT}/bin/ideate-record` or one of the `hooks/*.mjs`
   scripts. How a consuming project performs that wiring (copying the file,
   referencing it, or another host-specific mechanism) is outside this
   plugin's contract — only the shape of `hooks/hooks.json` itself is.

### Build / test (contributor path)

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

## The work-state board (local backend)

The delegation board's LOCAL backend — the ratified work-state contract
(`docs/spikes/v3-work-delegation.md` in the project monorepo) implemented
over SQLite in WAL mode. One sentence of model: work items carry an opaque
`spec` payload the board never parses (bring any methodology — a
superpowers plan, a Spec Kit URI, a plain prompt); **claims are
server-authoritative leases with fencing tokens** — `claim` is an atomic
compare-and-set that succeeds only on an open item whose dependencies are
all done, leases expire (default hours-scale) so crashed workers can never
orphan work forever, and a stale token is rejected on
`renew`/`complete`/`release` after a reclaim. Every transition appends an
immutable audit event in the same transaction. For a solo user the
coordination features are *degenerate* (contention never occurs), never
absent — the same code paths a future hosted team would exercise, proven
by a contention suite that races real OS processes.

**Eleven MCP verbs** (same server, `dist/server.js`): `work_create`,
`work_get`, `work_list`, `work_update_meta`, `work_claim`, `work_renew`,
`work_release`, `work_complete`, `work_cancel`, `work_reopen`,
`work_events`. `renew`/`complete`/`release` take no actor — the token
proves identity, and the audit event carries the claim's actual holder.

**`ideate-work` CLI** (`bin/ideate-work`): the same eleven verbs as
subcommands plus a CLI-only `sweep` (the session-boundary expiry pass the
`SessionStart`/`SessionEnd` hooks trigger opportunistically). `--json` on
the read verbs. Board location: `work_state.path` in `.ideate.json`
(default `.ideate-work/`).

## Honest status

- **Available now:** the append-only process record, the five mechanical
  capture points (`SessionEnd`, `PreCompact`, `SubagentStop`,
  `TaskCompleted`, `PostToolUse` on `git commit`), session/subagent priming,
  the capture-time secret-scanning gate, native telemetry counters, and the
  work-state board's **local** backend (the eleven verbs above, with a
  contention suite racing real OS processes as its correctness evidence).
- **Not yet built:** the *hosted* delegation board (cross-machine,
  multi-person coordination). Its ratified trigger is a concrete second
  contributor; the local board implements the identical contract, so that
  move is configuration, not a rewrite.
- **Eval-gated, present but off:** claim-time priming — the hook point
  exists in the claim path and a `work_claims` telemetry counter records
  the denominator, but priming itself is mechanically disabled
  (`work_state.claim_priming` config flag, default off, no environment
  override) until the evaluation harness licenses it. Same discipline as
  the rest of the gated set: planning-time gap identification (designed,
  not built, gated on G4) and per-prompt priming (deferred, gated on
  G1/G2). None of this plugin's shipped behavior depends on any of these.
- This package is `"private": true` in `package.json` and stays that way
  until publishing this plugin to npm is separately ratified.

## License

AGPL-3.0-only — see [`LICENSE`](./LICENSE).
