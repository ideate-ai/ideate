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

## Requirements

**Node.js >= 22.5** must be installed and on your `PATH`. Claude Code ships as
a native binary and bundles no runtime, so the plugin's MCP server, hooks, and
CLIs — which run on Node and use the built-in `node:sqlite` — need Node
available. Install it from <https://nodejs.org> (or your package manager)
before installing the plugin.

## Install

There are two ways to wire this plugin into a Claude Code project. Both land
on the same MCP server and `hooks/hooks.json` — the manifests below are just
two different ways of pointing Claude Code at them. This section documents the
contracts (what each mechanism provides); it does not prescribe which one to
use or what workflow to run once installed.

### (a) Marketplace install

This repo ships `.claude-plugin/marketplace.json`, a Claude Code
plugin-marketplace manifest listing this plugin (`name: ideate`, `source:
"./"` — the repo root). From within Claude Code:

```
/plugin marketplace add ideate-ai/ideate
/plugin install ideate
```

This is the manifest-driven path — Claude Code resolves the plugin and wires
`.mcp.json` / `hooks/hooks.json` for you. On first launch the plugin runs a
one-time setup: because built output (`dist/`) is not committed, it installs
its single dependency and builds itself, then the MCP server, the mechanical
capture/priming hooks, and the CLIs are live. The first session may pause
briefly while that runs; later sessions start instantly. If Node is missing or
older than 22.5 (see Requirements above), the plugin prints a clear one-line
message and otherwise does nothing — it never blocks your session.

### (b) Manual wiring

For a project that wants to point at this plugin directly rather than
through the marketplace resolver:

1. Build the package: `npm install && npm run build` (compiles `src/` to
   `dist/`; `dist/` is not committed). A marketplace install runs this for you
   on first launch; for manual wiring you run it once yourself.
2. Add an MCP server entry to the consuming project's `.mcp.json` pointing at
   the launcher, which runs the first-launch bootstrap before starting the
   server:

   ```json
   {
     "mcpServers": {
       "ideate": {
         "command": "sh",
         "args": ["<path-to-this-plugin>/bin/ideate-mcp"]
       }
     }
   }
   ```

   This registers all eighteen MCP verbs: the three record verbs
   (`record_append`, `record_read`, `record_decision`) described below, the
   eleven board verbs in [The work-state
   board](#the-work-state-board-local-backend), and the two steering verbs
   plus the two usage verbs in [Steering and usage
   verbs](#steering-and-usage-verbs).
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

Prerequisites: Node >= 22.5.

```sh
npm install
npm run build    # compiles src/ to dist/ (gitignored)
npm test         # vitest (fork pool capped — see vitest.config.ts)
```

`npm run test:fresh-copy` runs `scripts/fresh-copy-check.mjs`, which copies
this directory to a scratch location with no surrounding project context and
re-runs install/build/test there — the mechanical proof that this package
stands alone.

## The process-record surface

The record core has exactly two transports over one implementation: three
MCP tools, and a CLI. Both write through the same gated append-only store, so
a record captured via one transport is indistinguishable from one captured
via the other.

**MCP verbs** (registered by the ideate MCP server, `dist/server.js`):

- `record_append(kind, claim, verification_anchor?, scope?, content, task_id?,
  supersedes?, references?)` — append one process record. Open-vocabulary
  `kind` (e.g. `finding`, `session-outcome`, `commit-boundary`, …).
  `supersedes` takes the id of the record this one replaces (a correction is a
  new record, never an edit); `references` is the advanced form — a JSON array
  of typed edges, `[{"rel":"refutes","id":"01…"}]`.
- `record_read(scope?, id?, include_content?, limit?, cursor?)` — read records
  newest-first, optionally filtered by a plain substring match against
  scope/kind/source or by exact `id`. Unranked: selection only, no scoring.
  Returns `{ok, records, next_cursor}`. Rows are **summaries** — every field
  except the prose body, plus a derived `content_length`; `include_content:
  true` adds the body, and an `id` with `include_content: true` is the
  single-record fetch. **Paged:** at most `limit` rows (default 100, clamped
  into 1..500) and at most ~40,000 characters of rows, so a page can come back
  shorter than `limit` while records remain — only a `null` `next_cursor` means
  exhaustion. Pass a page's `next_cursor` back as `cursor` (opaque; tied to the
  filter it was issued for) to walk a selection to the end.
- `record_decision(claim, rationale?, verification_anchor?, scope?, task_id?,
  supersedes?, references?)` — sugar for `record_append(kind="decision", ...)`;
  the ADR entry point. The decision write *is* its capture — there is no
  separate decision store, and an overturned decision is superseded, not
  rewritten.

**The record FILES are the export surface.** Each record is one Markdown file
at `<record.path>/YYYY/MM/{ULID}.md` (`record.path` from `.ideate.json`,
default `.ideate/record/`) — one record per file, never rewritten (files are
written exclusive-create), with the `YYYY/MM` shard derived from the record
id's own embedded timestamp, so the path of a record is computable from its id
alone. An external consumer — a knowledge-graph ingester, a backup, a `grep` —
reads that tree directly: durable, stably addressed, and requiring no ideate
process, no MCP session, and no cooperation from this plugin at read time.
`record_read` (and `ideate-record read`) is the in-session view for an agent:
a bounded, paged, unranked *selection* over those same files, not an export
API — do not build an ingester on it, and never read a short page as the end
of the record.

**`ideate-record` CLI** (`bin/ideate-record`, the same gated core as a
standalone executable — this is what the capture hooks invoke):

- `ideate-record append --kind <k> --claim <c> [--anchor <a>] [--scope <s>] [--content <text>|-] [--task <id>] [--supersedes <id>]`
  — append one record directly; exits 1 on failure. `--content -` reads the
  prose body from stdin.
- `ideate-record read [--scope <substring>] [--id <ulid>] [--limit <n>] [--cursor <c>] [--include-content] [--json]`
  — print records newest-first; exits 1 on failure. `--json` is the
  agent-facing door and is bounded exactly like `record_read` (summary rows,
  default page size, opaque `next_cursor`, shared payload budget);
  `--include-content` puts the prose bodies back and requires `--json`. The
  human-readable listing is unpaged and full-bodied unless you pass `--limit`
  or `--cursor`. There is no "print everything" flag — the record files above
  are the export surface for that.
- `ideate-record session-end` — reads a `SessionEnd` hook payload from stdin
  and appends a recall-shaped session-outcome record. Hook path: always
  exits 0 (a capture failure must never look like a hook failure to the
  host).
- `ideate-record prime [--scope <substring>] [--budget <n>]` — print a
  compact, unranked digest of the most recent records for hook
  `additionalContext`. Hook path: always exits 0.

## The work-state board (local backend)

The delegation board's LOCAL backend — the ratified work-state contract
implemented over SQLite in WAL mode. One sentence of model: work items carry
an opaque `spec` payload the board never parses (bring any methodology — a
plan document, a Spec Kit URI, a plain prompt); **claims are
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
`SessionStart`/`SessionEnd` hooks trigger opportunistically). Board location:
`work_state.path` in `.ideate.json` (default `.ideate-work/`). Every
subcommand except `sweep` exits 1 on failure; `sweep` is a hook path and
always exits 0, printing nothing to stdout.

- `ideate-work create --title <t> --spec <s> --spec-format <f> --human <h> [--agent <a>] [--depends-on <id1,id2,...>] [--supersedes <id>] [--tenant <t>]`
  — create one item; prints it as JSON. `--supersedes <id>` records a
  supersedes edge to the item this one replaces, and the superseded item
  surfaces the replacement as a derived `referenced_by` backlink.
- `ideate-work get --id <id> [--json]` — fetch one item, running the
  lazy-expiry seam first; a miss prints `(not found)`, or `null` under
  `--json`. This is the way to read one item's full `spec`.
- `ideate-work list [--tenant <t>] [--status <open|in_progress|done|cancelled>] [--json] [--include-spec] [--limit <n>] [--cursor <c>]`
  — list items with the derived claimability view attached. Rows are
  **summaries** — every field except the opaque `spec` body, plus a derived
  `spec_length`; `--include-spec` puts the bodies back and requires `--json`
  (the human listing has nowhere to print them). **`--json` returns a PAGE,
  not the board:** `{"items": [...], "next_cursor": ...}`, at most `--limit`
  items (default 100, clamped into 1..500) and at most ~40,000 characters of
  rows — the same payload budget the MCP `work_list` tool applies — so a page
  can come back shorter than `--limit` while items remain, and only a `null`
  `next_cursor` means exhaustion. Pass a page's `next_cursor` back as
  `--cursor` (opaque; tied to the `--tenant`/`--status` filter it was issued
  for). The human-readable listing is one line per item, unpaged and
  unbudgeted unless you pass `--limit` or `--cursor`, in which case it prints
  a resume hint while items remain.
- `ideate-work update-meta --id <id> --expected-version <n> [--title <t>] [--spec <s>] [--spec-format <f>] [--depends-on <id1,id2,...>] [--supersedes <id>]`
  — update metadata via optimistic compare-and-set on `version`.
- `ideate-work claim --id <id> --human <h> [--agent <a>] [--lease-ms <n>]` —
  claim an open, claimable item; mints the fencing token the next three
  subcommands require.
- `ideate-work renew --id <id> --token <n> [--lease-ms <n>]` — extend an
  active claim's lease. No actor flags — the token proves identity.
- `ideate-work release --id <id> --token <n> [--note <n>]` — hand an active
  claim back to `open`. No actor flags.
- `ideate-work complete --id <id> --token <n> [--note <n>]` — complete an
  active claim. No actor flags; the note becomes a process record (below).
- `ideate-work cancel --id <id> --human <h> [--agent <a>]` — cancel an item
  from `open` or `in_progress`; voids any active claim.
- `ideate-work reopen --id <id> --human <h> [--agent <a>]` — move an item from
  `done` back to `open`.
- `ideate-work events --id <id> [--json]` — every event for one item, oldest
  first.
- `ideate-work sweep [--tenant <t>]` — CLI-only (never an MCP tool): the
  opportunistic board-wide expiry pass. Hook path: always exits 0, stdout
  stays silent, diagnostics go to stderr.

**Board operations.** The board is one SQLite file, `board.db`, under
`work_state.path` (`workStatePath()`, default `.ideate-work/`) — nothing
else lives there. Deleting that directory resets the board: every claim and
event is gone, and item state re-derives from nothing (there is no
recovery). This is safe to do on purpose because it is a DIFFERENT store
from the append-only process record (`record.path`, default
`.ideate/record/`) — deleting the board never touches the record, and vice
versa. `board.db` also carries a schema version (`PRAGMA user_version`, checked on every
open); if a build ever reports a version-mismatch error, that is
deliberate, not a bug — it means the file was written by a different
plugin version than the one reading it, and this project makes no
promises about migration timelines. Older, pre-versioning boards are
handled with a one-time grace (stamped on their next write) rather than
rejected outright.

**One item's lifecycle — an example trace.** The transcript below runs a
work item end-to-end through the board (outputs trimmed for width). It
illustrates the shape of the lifecycle — it does not prescribe a workflow,
and every verb is equally available over MCP:

```sh
$ ideate-work create \
    --title "Add retry backoff to the fetch client" \
    --spec "<the work-item body — opaque to the board>" \
    --spec-format "ideate/wi-v1" --human dan
{"id":"01KXBQDD7P…","status":"open","version":1,…}

$ ideate-work claim --id 01KXBQDD7P… --human dan --agent claude-coordinator
{"status":"in_progress","claim":{"holder":{"human":"dan","agent":"claude-coordinator"},
 "claim_token":1,"lease_expires":"2026-07-12T21:53:58.767Z"},…}

# …the actual work happens here…

$ ideate-work complete --id 01KXBQDD7P… --token 1 \
    --note "Exponential backoff added with jitter; full suite green."
{"status":"done","claim":null,…}

$ ideate-work events --id 01KXBQDD7P…
2026-07-12T17:53:45.206Z create actor=dan
2026-07-12T17:53:58.767Z claim actor=dan token=1
2026-07-12T17:55:58.126Z complete actor=dan token=1 note="Exponential backoff added…"
```

Completing with a note is also a capture point: the note becomes an
append-only process record (kind `work-completion`, verification anchor
`board:<item>#complete@<time>`), retrievable through the record surface
like any other record:

```sh
$ ideate-record read --scope <item-id> --json
{"records":[{"kind":"work-completion",
  "verification_anchor":"board:01KXBQDD7P…#complete@2026-07-12T17:55:58.126Z",
  "claim":"Add retry backoff to the fetch client — Exponential backoff added…",…}],
 "next_cursor":null}
```

That `--json` output is a PAGE, and the real one is indented — the transcript
above is trimmed for width. Read `next_cursor`, not the row count: a `null`
is the only statement that the selection is exhausted.

## Steering and usage verbs

Two smaller seams ride the same MCP server (`dist/server.js`). Each keeps its
own store, separate from the record and the board, and neither has a CLI —
these four verbs exist over MCP only.

**Two steering verbs — `steering_read` and `steering_put` — GATED OFF by
default.** Steering items are a project's guiding principles and policies, one
file per item under `.ideate/steering/`. `steering_put` creates or amends ONE
item: on amend the prior version is appended to the item's amendment history
and the status may flip, and there is no hard delete — you deprecate via
`status` (`active | deprecated | superseded`), or name a DIFFERENT item as
`supersedes` to replace it. `steering_read` is selection only — by `id`
(exact), `domain` (substring), `status` and `kind` — unranked by contract, and
bounded the same way the reads above are: the amendment `history` is projected
away unless you pass `include_history` (a `history_length` is always present),
and the result `{ok, items, next_cursor}` is a page of at most `limit` items
(default 100, clamped into 1..500) within the same ~40,000-character payload
budget, resumed with an opaque `cursor`.

**Both steering verbs are gated behind `steering.enabled` in `.ideate.json` —
absent by default, which means off, with no environment override.** While the
gate is off — the only state this package ships in — each verb returns
`{"ok":false,"code":"GATED",...}` as a tool error and writes NOTHING: the
gate is checked before arguments are validated, so a gated project cannot
even create the steering directory by calling with bad arguments. Steering
shapes what a model attends to, and nothing that shapes attention ships live
here ahead of the evaluation that measures it.

**Two usage verbs — `usage_capture` and `usage_query`.** Append-only
instrumentation for retrieval effectiveness, stored under `.ideate/usage/`.
`usage_capture` is mechanical: given captured worker `text` and the
authoritative `delivered` set of item ids, it string-matches (no relevance
inference, no judgement) and appends one usage signal per cited id — its
intended caller is a mechanical capture point such as an eval or replay
harness, never an agent deciding what to "cite". `usage_query` reads those
signals back, exact-match filtered by seed/task/manifest/session/kind/item,
and returns `{ok, used_item_ids, signals, next_cursor}` — the distinct used
items of THAT PAGE plus the signals themselves, oldest first, paged and
payload-budgeted exactly like the reads above. Like the record, this store is
append-only: there is no update verb and no delete verb.

## Honest status

- **Available now:** the append-only process record, the five mechanical
  capture points (`SessionEnd`, `PreCompact`, `SubagentStop`,
  `TaskCompleted`, `PostToolUse` on `git commit`), session/subagent priming,
  the capture-time secret-scanning gate, native telemetry counters, the
  work-state board's **local** backend (the eleven verbs above, with a
  contention suite racing real OS processes as its correctness evidence), and
  the two usage verbs.
- **Not yet built:** the *hosted* delegation board (cross-machine,
  multi-person coordination). Its ratified trigger is a concrete second
  contributor; the local board implements the identical contract, so that
  move is configuration, not a rewrite.
- **Present but gated off:** the two steering verbs. They are registered by
  the shipped server and answer every call with
  `{"ok":false,"code":"GATED",...}` until `steering.enabled` is set to true in
  `.ideate.json` — see [Steering and usage
  verbs](#steering-and-usage-verbs).
- **Present but off:** claim-time priming — the hook point exists in the
  claim path and a `work_claims` telemetry counter records the denominator,
  but priming itself is mechanically disabled (`work_state.claim_priming`
  config flag, default off, no environment override) pending further
  validation. Same discipline as the rest of the deferred set:
  planning-time gap identification (designed, not built) and per-prompt
  priming (deferred). None of this plugin's shipped behavior depends on any
  of these.
- This package is `"private": true` in `package.json`. It is distributed as a
  Claude Code plugin — a git-source marketplace install that builds itself on
  first launch — not published to npm, so `private` stays set.

## License

AGPL-3.0-only — see [`LICENSE`](./LICENSE).
