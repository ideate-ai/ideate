# Work Item 037: brrr Skill

## Objective

Create the `/ideate:brrr` skill — an autonomous SDLC loop that repeatedly runs execute→review→refine until convergence. Convergence is defined as zero review findings AND zero guiding principle violations. A proxy-human agent handles all Andon events in the absence of the human. When the human re-engages, a full activity report is presented.

## Acceptance Criteria

1. Skill at `skills/brrr/SKILL.md`, invokable as `/ideate:brrr`.
2. Accepts optional argument: artifact directory path (same as other skills). Falls back to asking if not provided.
3. Reads all plan artifacts at startup (same as execute skill) and validates they exist.
4. Entry condition: a valid plan must exist (overview.md, at least one work item). If no plan exists, directs user to `/ideate:plan` first.
5. Cycle loop structure:
   a. Execute all pending/incomplete work items (using the same execution strategy as `/ideate:execute`)
   b. Run comprehensive review (`/ideate:review` equivalent logic — spawn code-reviewer, spec-reviewer, gap-analyst, journal-keeper)
   c. Check convergence (see criterion 7)
   d. If not converged: run refinement (`/ideate:refine` equivalent logic — produce new work items for all findings)
   e. Repeat from (a) with new work items
6. Andon events during execute phase are routed to the proxy-human agent. The skill spawns `proxy-human` via `spawn_session` with the Andon event description and artifact dir. The proxy-human agent's decision is treated as authoritative. Execution continues after the decision is recorded.
7. Convergence check after each review cycle:
   a. Review produced zero critical findings AND zero significant findings (minor findings acceptable)
   b. Guiding principles adherence check: spawn spec-reviewer with scope limited to "verify all guiding principles are satisfied by the current codebase, list any violations" — must return zero violations
   c. Both conditions must be true simultaneously. If either fails, refine and loop.
8. Maximum cycle guard: `--max-cycles N` invocation option (default: 20). If max cycles reached without convergence, pause and report to human.
9. Cycle counter displayed at start of each cycle: `[brrr] Cycle N — {N} work items pending`.
10. On convergence: print convergence declaration, then present full activity report.
11. On human re-engagement (user sends any message mid-run): current cycle completes before responding. User is then shown the activity report for cycles completed since invocation.
12. Activity report structure: cycle-by-cycle summary (items completed, findings, decisions made by proxy-human), total cycles, total work items executed, convergence status, proxy-human decision log summary, open items (if any).
13. Proxy-human log (`proxy-human-log.md`) is appended by the proxy-human agent and summarized in the activity report.

## File Scope

- create: `skills/brrr/SKILL.md`

## Dependencies

036 (proxy-human agent must be defined before brrr skill references it).

## Implementation Notes

- brrr is not a thin wrapper around the existing skills — it is a self-contained skill that includes the logic from execute, review, and refine phases. It DOES NOT call `/ideate:execute`, `/ideate:review`, `/ideate:refine` as sub-commands — it contains equivalent logic inline, because it needs to intercept Andon events before they surface to the user.
- The guiding principles check in step 7b should be a focused spec-reviewer invocation with a narrow prompt: "Read `steering/guiding-principles.md` and the project source code. For each principle, state whether it is satisfied or violated. Return ONLY violations. If none, return 'No violations found.'" — convergence passes if response is "No violations found."
- Cycle state: track cycle number and work items completed in this session in a `brrr-state.md` file in the artifact dir. This allows resuming a brrr session if interrupted.
- `brrr-state.md` fields: `started_at`, `cycles_completed`, `total_items_executed`, `convergence_achieved: bool`, `last_cycle_findings: []`.
- If `brrr-state.md` already exists when brrr starts, prompt user: "A previous brrr session exists (N cycles, convergence: X). Resume or start fresh?"

## Complexity

High
