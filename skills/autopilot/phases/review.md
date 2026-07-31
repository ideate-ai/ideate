# autopilot phase — review

Inline review logic for the autopilot loop. Mirrors `/ideate:review` but runs
inside the autopilot context and **returns a convergence verdict** the
controller branches on. Read and run this after the execute phase each cycle.

## Scope
Default to a **differential** review of what this cycle changed (`git diff`
against the previous cycle record's head commit, plus the items completed this
cycle). Periodically — every few cycles, or on the final cycle — do a **full**
review instead, to catch regressions the differential scope misses.

## Reviewers (parallel)
Spawn concurrently, each scoped to the work under review and handed the
applicable steering (`steering_read` — by `domain` for a differential review,
else paged to exhaustion: follow `next_cursor` until it is `null`, since a
short page is not the ruleset):
- `ideate:code-reviewer` — correctness, security, quality.
- `ideate:spec-reviewer` — spec + steering adherence.
- `ideate:gap-analyst` — missing coverage, unupdated consumers, absent tests.

Collect findings; dedupe; drop the unsubstantiated. Record survivors with
`record_append(kind="finding")`.

## Convergence verdict (this phase's job)
Decide, from the board and the findings, one of:
- **`converged`** — no unresolved `critical` or `significant` findings this
  cycle **and** the board has no claimable work. `work_list(status:"open")`
  coming back empty on the first page settles it — there are none. Otherwise
  you must show that **no** open item is `claimable`, and claimability is
  derived per item, so that only holds after paging the board to exhaustion:
  follow `next_cursor` until it is `null` — a page shorter than `limit` is
  **not** the end. Then the work is done.
- **`needs-refinement`** — unresolved `critical`/`significant` findings, or open
  board work remains. The controller will run `phases/refine.md`.
- **`unknown`** — the reviewers genuinely couldn't determine adherence (e.g.
  the success criteria are ambiguous, or evidence is missing). The controller
  routes this to `ideate:proxy-human` as an Andon rather than guessing.

Base the verdict on evidence, not optimism — an unverified "looks done" is
`needs-refinement` (or `unknown`), never `converged`.

## Steering curation
Spawn `ideate:domain-curator` with current steering + this cycle's findings;
apply the proposals you accept via `steering_put`. Skip if the cycle produced
nothing steering-relevant.

## Output (hold for the controller / cycle record)
- The **verdict** (`converged` / `needs-refinement` / `unknown`).
- Findings by severity (ids), and any steering amendments applied.
- A `record_append(kind="cycle-summary")` roll-up for this cycle.

Return the verdict to the controller.
