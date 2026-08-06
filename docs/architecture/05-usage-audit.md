# Ideate v3 — architecture inventory, part 5: the usage audit

*The point of the inventory: each data area, what it's for, who actually
reads it, and an honest verdict. Evidence-linked throughout; this is the
direct input to the alignment session. Compiled 2026-08-03 against the
shipped tree and the two dogfooding projects (ideate + plugin dev).*

## Per-area audit

| Data area | What it's for | Who reads it | Verdict |
|---|---|---|---|
| **Process record** (~3.1k records, ideate repo) | The why: decisions, findings, completions, journal | Session/subagent digests (10 recent), skill MCP reads, by-id fetches, scope filters | **Working, but the capture is polluted.** The conway handoff record proves the value: work survived a dead board *because* the record was there. What arrives is another matter — see "what's not working" item 6 |
| **Board items** (~160 on ideate) | Work queue + decomposition | Every skill, every session | **Working.** The convergence oracle — "zero open claimable work" is the stage-completion signal |
| **Board events log** | The board's own audit trail | `work_events` reads (rare; debugging/handoffs) | **Working, under-read.** Rich history, consumed mostly at incident time |
| **Steering items** (~105) | The rules of the work | refine/review/autopilot reads; curator amendments | **Working.** The incident→finding→decision→amendment loop is real (P-40's transport clause) |
| **Telemetry counters** | Capture-funnel + future eval signals | Nobody automated; manual `ideate-telemetry` only | **Collected, unconsumed.** 3 of 7 counters have *zero writers* — leftovers of the retired usage surface |
| **Completion bridge records** | Completions visible in the record | Record readers | **Working** (and its failure path is tested loud) |
| **Migration signal records** | The one-way door announces itself | Future incident investigators | **Just shipped** (item 5); mechanism mutation-proven |
| **Config (`.ideate.json`)** | Per-project store paths/backend | Every transport open | **Working** |
| **Gated: assembler prototype** | The future briefing | Nobody — no handler | **Deliberately dark** (GP-23) |
| **Gated: priming hook** | Claim-time priming seam | Nobody — throws if enabled | **Deliberately dark** (GP-23); its `work_claims` counter is the only live effect |

## What's making it work

1. **The split by mutation semantics.** Append-only files for the record,
   SQLite for the board, files for steering. Each store degraded
   independently in the field (conway: board dead, record fine) — the
   architecture's central bet, paid off.
2. **Hooks as the capture floor.** Capture happens without any agent
   remembering: session start primes, compaction captures, commits land as
   records. The 635-turn session that produced stage 2 left a complete
   journal without a single manual "remember to log this." The *design* is
   what's working here; read item 6 below before trusting its current output.
3. **The mechanical-enforcement layer.** Census tests that scan the shipped
   tree, mutation-proven guards, cross-transport parity with a real child
   process. Conventions don't decay because they're executable. This is the
   property the eval harness must itself inherit (pre-committed thresholds
   are the same idea one level up).
4. **Fencing + leases on the board.** Multi-session claiming has not
   produced a single lost-update incident since the board shipped.
5. **GP-23's gate actually held.** Through a whole no-harness window (stages
   1–2), nobody shipped intelligence machinery. The gate was mechanical
   (NOT_IMPLEMENTED), not a promise.

## What's not working

1. **Telemetry is a write-only store.** Seven counters, four with writers,
   one diagnostic bin nobody calls. Data collected per its design; consumed
   by nothing. (Not waste — collection is cheap and the stage-3 harness may
   want the history — but today it answers no question.)
2. **The record's retrieval is recency + substring.** Two sessions apart,
   relevant context resurfaces only if it's recent or you know the scope
   word. The 3.1k-record store is searched far below its information
   content. (Parked deliberately — but it is the largest gap between "what
   we have" and "what we use.")
3. **The events log has no consumer-side tooling.** It answers "what
   happened to item X" and nothing higher-level ("what did this cycle
   touch," "how long do claims live"). Fine at current scale; will not
   scale to multi-project questions.
4. **`transport/` is two layers under one name.** Working, but the next
   shared utility lands in a directory whose name lies about its contents.
5. **The two doors have drifted, on the door subagents are forced to use.**
   The shared core is genuinely shared — both adapters construct the same
   `WorkStateStore`/`WorkStateVerbs` and no board logic is written twice. But
   each adapter independently chooses what to wire, and two gaps are verified
   in the shipped tree (`04-transports-and-infra.md`): `parent_id` is absent
   from the CLI entirely, so a subagent cannot set or move a containment
   edge; and the CLI never passes `onUnresolvedIds`, so a dangling reference
   id is accepted silently where MCP reports it. Both contradict
   `cli/ideate-work.ts`'s own header. This is the same failure *shape* as the
   four transport defects — a change landing on one door — except caught by
   structure rather than by an incident, and it is the strongest argument in
   this audit that the parity guard is scoped too narrowly.
6. **The capture floor is writing duplicate and false records.** Two
   independent defects, both found 2026-08-04 by inspecting what the phantom
   store had collected. First, every lifecycle hook is registered *twice* in
   this repository — once by the installed plugin, once by
   `.claude/settings.local.json` — so every captured fact is stored twice.
   Second, the commit-boundary hook trusts a host-side condition it never
   verifies and is not idempotent, so it intermittently re-reports a commit
   that landed long before, quoting an unrelated shell command as its cause —
   one commit is recorded twenty times across 38 minutes, only the first of
   which coincides with the commit. Together: **108 commit-boundary records
   in the August shard for 17 actual commits.** The ten-record digest — the always-on priming floor, and the
   mechanism this audit rates highest — is being filled with duplicated
   re-reports of old commits instead of ten distinct recent facts.

   This changes what the third section of this audit can claim. "Hooks as the
   capture floor" is still the right design; its *current output* is not
   trustworthy at face value. It also matters directly for stage 3, because
   this repository's record is the corpus any harness would measure.
   (Board items 01KZ789KW7CCP2QDQQTE4PC0MB and 01KZ78ACSCZKECN08YZVHDD3NQ.)
7. **The CLI writes to a phantom store when `cwd` isn't the project root.**
   `loadConfig` does not walk up to find an enclosing project; it lazily
   *creates* one wherever it is pointed. Hooks defend against this explicitly;
   the MCP server is immune by construction; subagents are not defended at
   all. It already happened during this inventory — nine records landed in a
   store under `docs/architecture/` and are invisible to the project. Of the
   three findings here this is the only one that silently loses data, and it
   deserves a decision at the session rather than a backlog entry.

## Improvement areas, ranked by leverage for the alignment session

1. **Define what the harness measures *from these areas*.** The audit table
   above is the candidate surface: convergence behavior (board), retention
   quality (record), governance adherence (steering), capture coverage
   (telemetry floor). GP-23's restored instrument should gate *these*, not a
   re-derived recall metric.
2. **Spec the in-product signals from requirements.** If the harness needs
   priming-usefulness or claim-latency data, say so and wire exactly that —
   the three zero-writer counters are the cautionary tale of speccing
   signals ahead of the question.
3. **Name or split the transport layers.** Cheap: either a comment-level
   naming (done in 00-overview) or a directory split. Decide at the
   alignment session; not worth a board item alone.
4. **Events-log rollups.** A `cycle_summary`-style read over events would
   serve review/reporting prose that today re-derives from memory. Small,
   unblocked, no KG dependency.
5. **Widen the parity guard from freshness to surface.** Proposal below —
   the cheapest structural fix in this list, and the one with a live defect
   already behind it.
6. **The KG seam (post-MVP, per Dan).** When it lands, it lands behind the
   restored instrument: semantic seed + PPR assembly, with the record's
   typed references as its first edges. The audit's item 2 is its
   justification, quantified by the harness it must ship behind.

## Proposal: one core, mechanically-thin doors

The instinct to want "a singular chokepoint, easy to test and abstract" is
right, and it is *almost* satisfied already — but the goal cannot be one
door. Hooks are processes and subagents have no MCP tools; the CLI is
structural, not a shortcut. The achievable version is **one core with doors
whose thinness is checked rather than trusted.**

Three checks, in increasing cost:

1. **Surface-parity census** (cheap, mechanical, fits the existing
   enforcement layer). A test that derives the MCP verb surface and the CLI
   subcommand surface *by scanning the shipped tree* — the same technique the
   prose-census tests already use — and asserts every verb exists on both
   doors with the same argument set, or carries a named, reasoned exemption
   (`sweep` is legitimately CLI-only; `steering_*` is legitimately MCP-only).
   Both drifts above fail this test on day one.
2. **Behavioral parity for the board**, extending
   `transport-parity.test.ts` from the record to the board: for each verb,
   the same inputs through either door produce the same item state and the
   same error taxonomy. This is what would have caught `onUnresolvedIds`,
   which a surface census might miss because it is a return-value gap rather
   than a missing flag.
3. **A structural thinness rule** (optional, decide at the session): CLI and
   MCP handlers may parse, serialize, and call verbs — nothing else. Today's
   handlers already honor this; the rule would keep the next one honest and
   make "where does logic live" un-negotiable rather than conventional.

Checks 1 and 2 are small, unblocked, and need no KG or harness dependency.
The phantom-store finding is not a parity problem and none of the three
checks would catch it; it wants its own fix — project-root discovery by
walk-up, with lazy creation reserved for a true root — and it is the one item
here that is losing data today.

The open question for the session is whether the two surface drifts get fixed
as defects now, or deliberately ratified as intended asymmetries — the CLI
omitting `parent_id` may have been a decision nobody wrote down, and the
answer changes whether `ideate:decomposer` can ever produce containment
edges from a subagent.

## What this audit deliberately did NOT do

Measure anything. Every verdict above is structural (who imports what, who
calls what) or incident-grounded (conway, the 81KB overflow, the telemetry
census). Quantifying "is the record's content *good*" is the harness's job —
and why the diagnosis of the old harness (next step) matters before any
design.
