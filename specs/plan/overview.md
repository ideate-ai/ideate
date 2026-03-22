# Change Plan — Cycle 011 (Startup Failure Andon Enforcement)

**Triggered by**: Cycle 007 gap-analysis finding II1 (Significant) — startup failure Critical findings are not unconditionally routed to Andon in execute/brrr finding-handling.

---

## What is changing

### WI-120: Add startup-failure exception to execute finding-handling

`skills/execute/SKILL.md`, `skills/brrr/phases/execute.md`

Phase 8 of `skills/execute/SKILL.md` routes Critical findings by asking whether the finding is "scope-changing (requires changes to other work items, architectural changes, or contradicts guiding principles)." A startup failure that appears trivially fixable — a missing import, a syntax error in the current WI — may be judged as fixable within scope and silently corrected, bypassing the Andon escalation the Cycle 010 quality floor depends on.

Fix: add a named exception rule to Phase 8's Critical Findings section and to the equivalent finding-handling block in `skills/brrr/phases/execute.md`: any Critical finding titled "Startup failure after ..." is always treated as scope-changing and routed to the Andon cord, regardless of whether a fix appears available within the work item's scope.

---

## What is NOT changing

- `agents/code-reviewer.md` — Dynamic Testing section unchanged
- All spawn prompts in execute/brrr (WI-118/119) — unchanged
- All steering documents — all 12 principles hold
- EC1/EC2 edge cases (smoke test blocking, library projects) — deferred

---

## Expected impact

After this cycle:
- A startup failure Critical finding is unconditionally escalated to Andon regardless of apparent fixability
- The quality floor from Cycle 010 ("never leave the app unable to start") is enforced through the finding-handling routing, not just through the code-reviewer's description

---

## Scope boundary

- `skills/execute/SKILL.md`
- `skills/brrr/phases/execute.md`
