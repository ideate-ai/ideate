# ideate — Workflow Skills & Concepts

This guide documents the five ideate workflow skills (`init`, `refine`,
`execute`, `review`, `autopilot`) and the underlying concepts they build on
(the process record, the work board, and steering — guiding principles,
constraints, policies, domains, and curation).

It is written for someone using or extending the plugin. If you only want the
mechanical capture/priming floor, you don't need any of this — the skills are
an **optional layer** on top of primitives that fire on their own (see
[Where the skills sit](#where-the-skills-sit)).

---

## Contents

- [The v3 model in one picture](#the-v3-model-in-one-picture)
- [Core concepts](#core-concepts)
  - [The process record](#the-process-record)
  - [The work board](#the-work-board)
  - [Steering: principles, constraints, policies, domains](#steering)
  - [Curation](#curation)
  - [Actors and accountability](#actors-and-accountability)
  - [Findings, severity, and the Andon cord](#findings-severity-and-the-andon-cord)
  - [Convergence and the divergence guard](#convergence-and-the-divergence-guard)
  - [The agent model](#the-agent-model)
- [Where the skills sit](#where-the-skills-sit)
- [The skills](#the-skills)
  - [The pipeline](#the-pipeline)
  - [init](#init)
  - [refine](#refine)
  - [execute](#execute)
  - [review](#review)
  - [autopilot](#autopilot)
- [The agent roster](#the-agent-roster)

---

## The v3 model in one picture

ideate v3 decomposes into **three functions**, each a thin, independent store:

| Function | What it is | Written by | Read by |
|---|---|---|---|
| **Process record** | Append-only, project-local trail of what was decided and done | Hooks (mechanically) + `record_*` tools | Priming, `review`, `refine`, humans |
| **Work board** | Claim-leased list of work items with a dependency graph | `work_*` tools | `execute`, `autopilot`, coordinators |
| **Steering** | Mutable store of principles, constraints, and policies | `init`, `refine`, curation | Everything that plans or reviews work |

The five workflow skills are **orchestration over these three stores**. They
own no storage of their own — they read and write the record, the board, and
steering, and they coordinate subagents that do the thinking. Delete every
skill and the record + board + steering still work; the mechanical capture and
priming floor still fires.

---

## Core concepts

### The process record

The record is an **append-only** log. Every entry — a decision, a finding, a
session outcome, a commit boundary, a completed task — is *appended*, never
updated or deleted. A correction is a new entry that references the one it
supersedes. This is what makes the record a trustworthy audit trail: nothing
rewrites history.

**Typed edges and derived backlinks.** Because the record is append-only, a
superseded entry can never be *stamped* after the fact — you can't write
"superseded" back onto the old record. So supersession is a **forward** edge on
the *new* record: a record carries `references: [{rel, id}]` — `rel` is an open
vocabulary with `supersedes` as the primary case (also `refutes`, `relates-to`,
…), and `id` is the older record it points at. The **reverse** edge —
`superseded_by` — is then **derived on read**, never stored: `record_read` and
the priming digest attach a `referenced_by` list to each record and flag a
superseded one inline (`⚠ superseded by …`). That is what stops a reader — or
the priming digest — from surfacing overturned guidance as if it were still
current. Writers set it with the `supersedes` argument on `record_append` /
`record_decision` (or `--supersedes` on the `ideate-record` CLI); the skills do
this whenever a decision or finding replaces an earlier one. The derivation is
a single newest-first pass with no index — a reference target always predates
its referrer, so the referrer is always seen first.

**Entries have a stable shape.** Each record carries a `kind` (open
vocabulary), a `claim` (the statement being recorded), optional
`verification_anchor` (how to check the claim), optional `scope` (what future
work it's load-bearing for), a `source` (capture point, session, timestamp),
and recall-shaped `content` prose. Every text field passes a **secret-scanning
gate** before it touches disk.

**Kinds** the skills use: `decision`, `finding`, `interview`, `design`,
`journal`, `cycle-summary`, `project-setup`, `plan-complete`,
`execution-complete`, `andon`, `autopilot-cycle`, `autopilot-complete`. The
vocabulary is open — these are conventions, not a fixed schema.

**Capture is mechanical.** Hooks append records as you work — at session end,
before compaction, when a subagent stops, when a task completes, and on
`git commit` — with no tool call required. The `record_*` tools
(`record_append`, `record_decision`, `record_read`) are the *explicit* path the
skills use on top of that floor.

**Priming** surfaces a bounded, recency-and-scope-selected digest of recent
records at session start and subagent start. It is **unranked** (selection
only, never scored) and framed explicitly as quoted historical *data*, not
instructions.

### The work board

The board holds **work items**. An item is:

- `id` (a ULID), `title`, and an **opaque `spec`** (free-form instructions —
  the board never parses it) with a `spec_format` hint.
- `status` — one of `open`, `in_progress`, `done`, `cancelled`. There is no
  stored `blocked` state: an item whose dependencies aren't finished is simply
  **not claimable**. "Blocked" is derived, never written.
- Two **orthogonal edge types**:
  - `depends_on[]` — **sequencing**. Item B can't start until every item in its
    `depends_on` is `done`. This is the dependency DAG (cycles are rejected at
    write time).
  - `parent_id` — **containment**. Which larger item (a phase, a feature group)
    this belongs under. Independent of `depends_on`.
- `created_by` (an actor), a `version` for optimistic concurrency, and a
  `claim` when someone holds it.

**Claim discipline (leases and fencing).** To work an item you `work_claim` it.
The claim succeeds only if the item is `open` **and** all its direct
dependencies are `done`. It mints a **`claim_token`** — a number that is
strictly monotonic *per item* — and sets a **lease** (default 4 hours, max 30
days). Every subsequent write to that item (`work_renew`, `work_complete`,
`work_release`) must present the token; a stale token is rejected. If a lease
expires, the board reclaims the item (back to `open`) and a later
complete with the old token fails — this **fencing** prevents a slow or
crashed worker from clobbering work someone else has since picked up. Long
tasks call `work_renew` to extend the lease.

**Lifecycle verbs:** `work_create`, `work_claim`, `work_renew`,
`work_release` (back to open, with a handoff note), `work_complete` (→ done),
`work_cancel`, `work_reopen`, `work_update_meta` (edit title/spec/deps via CAS
on `version`), `work_list` (with a derived `claimable` flag per item),
`work_get`, `work_events` (the immutable transition history of one item).

**Solo today, multi-IC later.** The board's coordination semantics
(claim/lease/fence) are present but degenerate for a single person. The same
contract backs a future hosted, multi-person board — nothing in these skills
assumes a single actor.

### Human-effort items (`spec_format: "ideate/human-gate"`)

Not every board item is code a worker can build. An item whose `spec_format`
is `ideate/human-gate` marks work that needs a **human** — an approval, an
outward-facing action (a push, a PR, a publish), a per-project judgment call,
or a decision. It is claimed and completed like any item (the board fences and
actor-attributes it), but `execute` and `autopilot` **surface** it instead of
dispatching a worker: `execute` presents it to you to act on out-of-band;
`autopilot` routes it to `proxy-human`. A code item can `depends_on` a
human-gate item — the derived not-claimable status holds the downstream
frontier until the human completes the gate (GP-27: the data contract, not an
orchestrator). Author one by setting `spec_format: "ideate/human-gate"` — the
board stores `spec_format` opaquely, so this is a convention, not new
machinery.

### Steering

**Steering is where the project's *rules* live** — the durable guidance that
work must honour. It is the v3 evolution of what v2 spread across "guiding
principles," "constraints," and a "domain layer." It is a small, **mutable**,
status-tracked store — *not* a knowledge graph.

A **steering item** has a stable `id`, a `kind`, a `domain`, a `status`, a
`statement` (the rule text), and an amendment `history`. The three kinds the
skills use:

- **Guiding principle** (`kind: guiding-principle`) — a *standing value* that
  shapes many decisions. "Prefer boring, well-understood technology." "Every
  public API has a test." Broad, rarely changes.
- **Constraint** (`kind: constraint`) — a *hard limit* the project can't cross.
  "Must run on Node 22." "No new runtime dependencies." Binary; either honoured
  or violated.
- **Policy** (`kind: policy`) — a *specific rule* for how things are done. "All
  database access goes through the repository layer." "Secrets only via the env
  loader." Narrower than a principle, actionable.

**Domains** are the **organizing tag** (`domain`) on each steering item — the
scope a rule belongs to (`auth`, `storage`, `api`, `testing`, …). Domains let
you read the rules relevant to the area you're working in
(`steering_read(domain: "auth")`) instead of the whole rulebook. In v3 a domain
is exactly this grouping tag — there is no separate domain artifact to
maintain.

**Amend, never delete.** `steering_put` creates a new item or amends an
existing one *in place*; the prior version is pushed onto the item's `history`.
Rules are never hard-deleted — a rule that no longer applies is set to
`status: deprecated` or `superseded`. `steering_read` selects by domain,
status, and/or kind, unranked.

**Steering is gated off by default.** Per a project guiding principle (GP-23),
`steering_put`/`steering_read` return `{ok: false, code: "GATED"}` until
`steering.enabled: true` is set in `.ideate.json`. **`init` enables it** as
part of project setup, because the whole point of `init` is to capture the
project's steering. If steering is off, `refine`/`review` will notice the
`GATED` response and offer to enable it.

### Curation

Steering drifts. New findings imply rules that would have prevented them; two
rules start to contradict; near-duplicates accumulate; a rule the codebase
outgrew lingers as `active`. **Curation** is the ongoing work of keeping the
steering store *coherent*.

In these skills, curation is the job of the **`domain-curator`** agent, run
during `review`. It reads the current steering and the cycle's findings and
proposes precise changes:

- **Contradictions** — two active rules that can't both hold; resolve one.
- **Redundancy** — rules that say the same thing; merge them.
- **Drift** — a rule the code has quietly outgrown; deprecate or amend it.
- **Missing policy** — a recurring finding that a new principle or policy would
  systematically prevent.

The curator **returns proposals**; the `review` skill applies the ones it
accepts via `steering_put`. Curation is thus append-and-amend, evidence-driven,
and always reversible (history is kept).

### Actors and accountability

Every board mutation records an **actor**: a required `human` and an optional
`agent`. An agent is never a principal on its own — accountability always
resolves to a person. The skills resolve `actor_human` once from
`git config user.name` (falling back to `$USER`) and attribute every board
write to that person, with the subagent named where one did the work.

### Findings, severity, and the Andon cord

A **finding** is a recorded problem — a bug, a spec gap, a missing test, a
policy violation — written as `record_append(kind: finding)`. Findings carry a
**severity**:

- **critical** — broken or unsafe; must be resolved before proceeding. Includes
  two special cases treated as critical: a **startup / smoke-test failure**
  (the thing doesn't run) and a **test-infrastructure failure** (you can't tell
  whether it works).
- **significant** — a real defect that should be fixed this cycle.
- **minor** — polish; fix inline or note it.

The **Andon cord** (borrowed from lean manufacturing: any worker can stop the
line) is how a critical finding halts progress. In `execute`, an Andon **stops
the loop and surfaces the finding to you** for a decision. In `autopilot` —
which runs unattended — there is no human to stop for, so the Andon is routed
to the **`proxy-human`** agent, which makes the call within the project's stated
intent and records it. Andon never silently pushes past a critical problem.

### Convergence and the divergence guard

A cycle has **converged** when there is **no open claimable work on the board**
*and* **no unresolved critical or significant findings**. Convergence is
**derived** from that state — never asserted because the work "looks done."
`review` computes a verdict (`converged` / `needs-refinement` / `unknown`);
`autopilot` loops until the derived test passes.

The **divergence guard** is autopilot's safety valve: if the count of pending
work is flat or *growing* across cycles (every fix spawns as much work as it
closes), the loop is not converging. Rather than burn cycles forever, autopilot
raises an Andon and, if it can't be resolved, **stops and hands back to a
human**. Refusing to spin is a feature.

### The agent model

Two rules govern how the skills use subagents:

1. **Read-only / return-only.** Every subagent except `worker` has *no write
   tools*. It investigates and **returns** its result (a design brief, findings,
   item JSON, a decision); the **skill** — running in the main session where the
   MCP tools live — performs every board/record/steering write. This keeps
   *capture in the main loop* (a core v3 principle) and makes the agents robust
   to how MCP tools are namespaced inside a subagent. `worker` is the one
   exception: it edits code, so it has `Edit`/`Write`/`Bash`.

2. **CLI for evidence, not writes.** Agents that need board or record evidence
   but have no MCP access use the plugin CLIs via `Bash` —
   `${CLAUDE_PLUGIN_ROOT}/bin/ideate-work events --id <id> --json`,
   `${CLAUDE_PLUGIN_ROOT}/bin/ideate-record read --scope <s> --json`. They read;
   they never write.

---

## Where the skills sit

The plugin is built in layers, and these skills are the **top, optional** one:

| Layer | What | Required? |
|---|---|---|
| **0 — primitives** | MCP record verbs + `bin/` CLIs + capture/priming hooks | The floor; always on |
| **1 — work-state** | The 11 board verbs over local SQLite | Used when you use the board |
| **2 — opt-in skills** | Thin ergonomic helpers over the primitives | Optional |
| **3 — workflow skills** | **`init`, `refine`, `execute`, `review`, `autopilot`** — this guide | **Optional; ideate-flavoured workflow** |

The design constraint on Layer 3 is explicit: **core value cannot depend on
it.** Delete these five skills and every capture/priming mechanism still fires;
the record, board, and steering are untouched. They are a *workflow for people
who want one*, not the product.

---

## The skills

### The pipeline

```
init  ──────►  refine  ──────►  execute  ──────►  review  ──────►  refine ...
(once)         (ideas→work)     (build)           (assess)        (fixes/next)

                    └────────────── autopilot ──────────────┘
                        (runs execute→review→refine unattended)
```

- **`init`** runs **once** to set the project up.
- **`refine`** is the **first working step and the recurring one** — it turns
  ideas into board work.
- **`execute`** builds the board.
- **`review`** assesses what was built and records findings.
- Findings flow back into **`refine`**, and the loop continues.
- **`autopilot`** runs that `execute → review → refine` loop for you, unattended.

Each skill is user-invocable as `/ideate:<name>`. Every skill is the **sole
writer** of its stores; subagents only investigate and return.

### init

**`/ideate:init [dir]`** — set the project up. Runs once.

- **Purpose:** lay the foundation `refine` decomposes against. Enable the
  steering store, capture the project's intent and standards, and — for an
  existing codebase — record an architecture survey. **Creates no work items.**
- **Does:**
  1. Detects prior setup (stops and points to `refine` if already set up).
  2. Resolves the directory and actor.
  3. **Enables steering** (`steering.enabled: true` in `.ideate.json`).
  4. For existing code, spawns `architect` (analyze mode) and records the
     survey as a `design` record.
  5. Runs a light interview about intent and standards, and writes the result
     to steering as **guiding principles / constraints / policies** plus an
     `interview` record.
  6. Writes a `project-setup` marker and a `journal` entry.
- **Writes:** steering items; records (`design`, `interview`, `project-setup`,
  `journal`). No board writes.
- **Subagents:** `architect` (analyze).
- **Next step:** `/ideate:refine`.
- **Note:** user-invocation only (`disable-model-invocation`) — it makes broad
  setup writes and flips the steering gate, so it never fires on model
  discretion.

### refine

**`/ideate:refine [idea or change]`** — decompose an idea into actionable work.
The first step after `init`, and the engine you return to.

- **Purpose:** turn a described goal, a change, or a set of review findings into
  **board work items** — decomposed, sequenced, self-contained — that `execute`
  can build. Plans work; writes no code.
- **Handles four cases:** a **fresh idea** (the primary case), **requirement
  evolution**, **post-review correction** (findings drive the work), and
  **alignment recalibration** (which may legitimately produce *zero* items —
  just amended steering and recorded decisions).
- **Does:**
  1. Confirms the project is set up (else → `init`).
  2. Loads context: steering, board, and records (including prior findings).
  3. Classifies the input case.
  4. Short, targeted interview to pin down scope and acceptance criteria.
  5. Spawns `architect` (analyze for blast radius, design for structure) and
     `researcher` for genuine unknowns; records key decisions.
  6. **Decomposes** via the `decomposer`, then creates board items — parents and
     dependencies first, mapping the decomposer's `ref` handles to real ids for
     `depends_on`/`parent_id`. Each `spec` is self-contained.
  7. Amends steering where the idea changes a rule; writes `journal` and
     `plan-complete`.
- **Writes:** board items (`work_create`/`work_update_meta`); steering
  amendments; records (`decision`, `interview`, `journal`, `plan-complete`).
- **Subagents:** `architect`, `researcher`, `decomposer`.
- **Next step:** `/ideate:execute`.

### execute

**`/ideate:execute [dir]`** — build the board.

- **Purpose:** walk the claimable frontier, delegate each item to a `worker`,
  review the result, and complete or release it under claim discipline. Builds;
  never designs or re-plans.
- **Does:**
  1. Reads the board and steering; releases any stale claims from an
     interrupted prior run.
  2. Presents the plan and execution mode, and confirms.
  3. Picks a **mode**: sequential (default), batched-parallel (independent items
     in isolated `git worktree`s, merged with `--no-ff`), or teams (only if
     `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).
  4. For each item: `work_claim` → assemble context (spec + steering +
     decisions) → spawn `worker` → incremental review (`code-reviewer`, plus
     `spec-reviewer` when relevant) → handle findings by severity (minor inline;
     significant fixed or turned into a follow-up item; **critical → Andon**) →
     `work_complete` on a verified report, else `work_release`. Re-reads the
     frontier as completions unblock dependents.
  5. Writes `journal` and `execution-complete`.
- **Writes:** board transitions; records (`finding`, `journal`,
  `execution-complete`); follow-up board items.
- **Subagents:** `worker`, `code-reviewer`, `spec-reviewer`.
- **Invariants:** never fake completion (a false `work_complete` corrupts the
  board — `release` when unsure); never leave an item claimed when you stop.
- **Next step:** `/ideate:review` (or `/ideate:refine` if an Andon needs
  re-planning).

### review

**`/ideate:review [--domain name | --full | "scope"]`** — assess completed work.

- **Purpose:** coordinate a panel of specialized reviewers, synthesize their
  findings into the record, and curate steering. Doesn't review the code
  itself — it *runs* the review.
- **Modes:** **cycle** (default — what changed since the last review), **`--full`**
  (whole-project audit), **`--domain <name>`** (one area against its steering),
  and **ad-hoc** (a natural-language scope).
- **Does:**
  1. Parses the mode and scope.
  2. **Advisory circuit-breaker check** — if an area has been through many
     review cycles without converging, surfaces it as a *reassess signal*
     (never a hard stop).
  3. Loads context and sets review depth proportional to risk.
  4. Spawns `code-reviewer`, `spec-reviewer`, and `gap-analyst` **in parallel**.
  5. Synthesizes, dedupes, and records surviving findings; writes a
     `cycle-summary` with the verdict.
  6. Runs the `domain-curator` and applies accepted steering changes.
  7. Spawns `journal-keeper`, records the journal, and reports findings by
     severity.
- **Writes:** records (`finding`, `cycle-summary`, `journal`); steering
  amendments.
- **Subagents:** `code-reviewer`, `spec-reviewer`, `gap-analyst`,
  `journal-keeper`, `domain-curator`.
- **Next step:** `/ideate:refine` (fixes) or the next planned work.

### autopilot

**`/ideate:autopilot [dir] [--max-cycles N]`** — run the loop unattended.

- **Purpose:** run `execute → review → refine` cycle after cycle until the
  project **converges**, or a cycle/appetite limit is hit. Unattended: Andons go
  to `proxy-human`, not to you.
- **Self-contained:** it does **not** call the other skills. It loads its phase
  logic from `phases/{execute,review,refine,reporting}.md` and runs it inline,
  so the whole loop keeps one continuous context.
- **State without a state store:** v3 has no autopilot-state tool, so autopilot
  persists loop state as `autopilot-cycle` records and reconstructs it from the
  record + board + `git log` on resume.
- **Does, each cycle:** run the execute phase → run the review phase (which
  returns a convergence verdict) → if converged and the board is empty, finish →
  else run the refine phase → write the cycle record → check limits (max-cycles,
  appetite, and the **divergence guard**). When done, run the reporting phase.
- **Andon routing:** anywhere a phase would stop for a human, autopilot spawns
  `proxy-human` with the escalation and the project's intent; it records the
  decision and continues, flagging the calls a human should still review.
- **Writes:** everything execute/review/refine write, plus `autopilot-cycle`,
  `andon`, and `autopilot-complete` records.
- **Subagents:** all of the above plus `proxy-human`.
- **Honesty bar:** the final report is your only window into an unattended run —
  it reports failures, deferrals, and skipped work explicitly, and a
  `converged` verdict is always backed by the derived convergence test.

---

## The agent roster

All agents are **read-only / return-only** except `worker`. The invoking skill
performs every write.

| Agent | Role | Model | Used by |
|---|---|---|---|
| `architect` | Survey existing code (analyze) or design a system (design); returns a design brief | opus | init, refine, autopilot |
| `researcher` | Investigate an open question; return sourced findings + a recommendation | sonnet | refine |
| `decomposer` | Break a goal into board items with explicit DAG/containment edges; returns item JSON | opus | refine, autopilot |
| `worker` | Implement **one** board item — the only agent with edit tools; returns a verified completion report | sonnet | execute, autopilot |
| `code-reviewer` | Review a change for correctness, security, quality; returns severity-classified findings | sonnet | execute, review, autopilot |
| `spec-reviewer` | Check work against its spec and steering; returns adherence findings | sonnet | review, execute, autopilot |
| `gap-analyst` | Find what's *missing* — uncovered requirements, unupdated callers, absent tests | sonnet | review, autopilot |
| `journal-keeper` | Compose a concise, recall-shaped cycle/session narrative | sonnet | review |
| `domain-curator` | Keep steering coherent; return proposed `steering_put` changes | opus | review, autopilot |
| `proxy-human` | Stand in for the user on Andon during unattended autopilot; return a bounded decision | opus | autopilot |

---

*This document describes the optional Layer-3 workflow skills. The mechanical
capture and priming floor (Layer 0) works with none of them installed.*
