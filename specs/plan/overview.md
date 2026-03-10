# Refinement Plan — Deferred Open Items Cleanup

## What Is Changing

This refinement addresses all deferred open items accumulated across three review cycles and a dedicated observability/execution-control feature cycle. The items fall into three categories: test suite polish, documentation improvements, and agent configuration consistency.

## Scope Boundary

**Changing:**
- `mcp/session-spawner/test_server.py` — fixture documentation, status table structural assertions, --allowedTools syntax test
- `mcp/session-spawner/README.md` — concurrent status table note, overflow file lifecycle note
- `agents/architect.md`, `agents/code-reviewer.md`, `agents/spec-reviewer.md`, `agents/gap-analyst.md`, `agents/journal-keeper.md`, `agents/decomposer.md` — add `background: false` frontmatter field

**Not changing:**
- `mcp/session-spawner/server.py` — no behavioral changes; overflow limitation is documented rather than fixed
- `skills/` — no skill changes
- `steering/` — no principle or constraint changes
- `agents/researcher.md` — already has `background: true`, not modified

## Work Streams

### Stream 1: Test Suite Polish (WI 026)
Three additions to test_server.py: a comment on `_reset_globals` explaining why all three globals are reset, structural assertions in the status table test (separator `+` and `completed` data row), and a new test verifying `--allowedTools` comma-separated CLI syntax.

### Stream 2: README Notes (WI 027)
Two clarifying notes in README.md: a concurrency non-determinism note in the Status Table section (row order is completion order, not start order), and an overflow file lifetime note in the Output Truncation section (files are not auto-deleted).

### Stream 3: Agent Background Field (WI 028)
Add `background: false` to the YAML frontmatter of the six foreground agents: architect, code-reviewer, spec-reviewer, gap-analyst, journal-keeper, decomposer. Researcher already has `background: true` and is not modified.

## Expected Impact

No behavioral changes. All three work items are documentation, test coverage, or configuration metadata. The session spawner's runtime behavior, the review and execution skills, and all agent capabilities remain unchanged.
