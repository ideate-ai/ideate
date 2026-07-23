---
description: "Execute the work board produced by init/refine. Claims claimable items under lease-fenced discipline, delegates each to a worker subagent, runs incremental review, handles findings by severity, and flags unresolvable issues to the user via an Andon stop. Builds work; does not design or re-plan."
user-invocable: true
argument-hint: "[project directory path]"
---

# ideate:execute

`execute` turns the board into working code. It walks the claimable frontier,
claims each item with a fencing lease, hands it to a `ideate:worker`, reviews
the result, records findings, and completes or releases the claim. It never
designs or re-plans — if work reveals the plan is wrong, it stops (Andon) and
sends you to `refine`.

## Board claim discipline (the core loop invariant)
Every board write is fenced by a **claim token**. For each item:
1. `work_claim(id, actor_human, [lease_ms])` — succeeds only if the item is
   `open` and **every** `depends_on` item is `done`. It returns a
   `claim_token`. Default lease is 4h; pass a longer `lease_ms` for big items
   (max 30 days).
2. While the worker runs, if it approaches the lease, `work_renew(id,
   claim_token, lease_ms)` to extend. A lapsed lease is reclaimed by the board
   (the item flips back to `open`) — a subsequent complete with the stale token
   fails `INVALID_CLAIM`, which is the fence doing its job.
3. On success: `work_complete(id, claim_token, note)` → `done`.
4. On failure/blocked: `work_release(id, claim_token, note)` → back to `open`
   with a handoff note. Never leave an item claimed after you stop.

Resolve `actor_human` once from `git config user.name` (fallback `$USER`).

## Step 1 — Locate and read the plan
- Target directory: argument or cwd. Confirm a board exists (`work_list`); if
  it's empty, direct the user to `/ideate:refine` to decompose work onto the
  board (or `/ideate:init` first if the project isn't set up yet).
- Read the board: `work_list` for the full picture and the derived `claimable`
  frontier. Note `in_progress` items — an interrupted prior run may have left
  claims; check `work_events` and either resume or release stale ones.
- Read steering (`steering_read`) and recent decisions (`record_read`) — this
  is the context workers need to match the project's rules.

## Step 2 — Present the execution plan and confirm
Show the user: the claimable frontier, the dependency order, item count, and
the execution mode you'll use (below). Get confirmation before building.

## Step 3 — Choose an execution mode
- **Sequential** (default, safest) — one item at a time. Use when items share
  files or the graph is mostly linear.
- **Batched-parallel** — claim several mutually-independent claimable items at
  once, each worker in its own `git worktree` to avoid collisions, then merge
  (`git merge --no-ff`) and resolve conflicts before completing. Use when the
  frontier has genuinely independent items.
- **Teams** (only if `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) — full parallel
  worker teams. Otherwise fall back to batched-parallel.

## Step 4 — Execute each item
For each claimed item:
1. **Assemble the worker's context.** The item's `spec` is authoritative; add
   the applicable steering rules and any decisions scoped to this area
   (`record_read`). Pass all of it in the worker prompt — the worker has no
   board/record access of its own.
2. **Spawn `ideate:worker`** with that context. It implements, verifies (build
   + tests), and returns a completion report (`complete` or `blocked`, what
   changed, verification output, follow-ups).
3. **Incremental review.** Spawn `ideate:code-reviewer` on the item's change.
   For spec-sensitive items, also `ideate:spec-reviewer`. Collect findings.
4. **Handle findings by severity:**
   - `minor` → fix inline (or spawn a quick worker), no ceremony; note in the
     journal.
   - `significant` → fix this cycle if cheap; otherwise `record_append(
     kind="finding")` and `work_create` a follow-up item so it isn't lost.
   - `critical` → **Andon**: stop the loop. Record it
     (`record_append(kind="finding")`), release the current claim with a note,
     and present it to the user (batched with any others) for a decision. Do
     not silently push past a critical finding.
   - Two special cases inherited from v2, treat as `critical`: a **startup/
     smoke-test failure** (the thing doesn't run) and **test-infrastructure
     failure** (can't tell if it works) — both block completion.
5. **Complete or release.** If the worker reported `complete` and no unresolved
   critical/significant finding remains, `work_complete(id, token, note)`. If
   blocked or Andon'd, `work_release(id, token, note)`.
6. Re-read the frontier (`work_list`) — completing an item may unblock
   dependents. Continue until the frontier is empty or an Andon halts you.

## Step 5 — Close out
- Journal the run: `record_append(kind="journal")` — items completed, findings
  and how each was handled, anything deferred.
- `record_append(kind="execution-complete")` marking the milestone.
- Summarize for the user: items done vs. still open, follow-ups created,
  Andon stops (if any), and the next step — `/ideate:review` to review the
  completed work, or `/ideate:refine` if an Andon needs re-planning.

## Guardrails
- Never fake completion: an item reaches `done` only on a verified worker
  report. A false `work_complete` corrupts the board — `release` instead when
  unsure.
- Never leave an item claimed when you stop. Always `complete` or `release`.
- You do the board/record writes; workers and reviewers only build and report.
- Respect the dependency gate — never hand a worker an item whose prerequisites
  aren't `done` (the board enforces this on claim, but don't try to
  circumvent it).
