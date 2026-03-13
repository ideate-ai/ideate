# Work Item 072: Fix brrr Phase 6c Convergence Check — Replace spawn_session with Agent Tool

## Objective
Replace the `spawn_session` invocation in brrr Phase 6c with an Agent tool invocation using `subagent_type: "spec-reviewer"`, ensuring brrr can declare convergence on standard installations without outpost configured.

## Acceptance Criteria

1. [ ] `skills/brrr/SKILL.md` Phase 6c Condition B invokes the spec-reviewer via Agent tool (not spawn_session)
2. [ ] The Agent tool invocation includes `subagent_type: "spec-reviewer"` and `model: "claude-opus-4-6"`
3. [ ] The invocation has a fallback path when Agent tool is unavailable (graceful degradation with logged warning)
4. [ ] The spec-reviewer receives the same context that would have been passed to spawn_session (principles file path, source code path)
5. [ ] The response parsing handles the spec-reviewer output format (findings by severity)
6. [ ] If Agent tool fails or is unavailable, brrr logs a clear error message explaining convergence check could not complete
7. [ ] Existing tests (if any) or manual verification shows brrr can reach convergence with zero findings on a clean project

## File Scope

**Modify:**
- `skills/brrr/SKILL.md` (lines 494-508 — Phase 6c Condition B implementation)

**Read for context:**
- `agents/spec-reviewer.md` (to understand expected input/output format)
- `specs/steering/guiding-principles.md` (sample principles file for testing context)

## Dependencies

- **Blocked by:** None
- **Blocks:** None (can run in parallel with WI-073)

## Implementation Notes

The current code at `skills/brrr/SKILL.md:494-508` spawns a principles-checker via `spawn_session`:

```markdown
> If the session-spawner MCP tool is available, spawn a principles-checker:
> ```
> spawn_session({
>   agent_type: "spec-reviewer",
>   purpose: "Check if implementation adheres to guiding principles",
>   ...
> })
> ```
```

Replace with Agent tool invocation:

```markdown
> Spawn spec-reviewer via Agent tool:
> ```
> Agent({
>   subagent_type: "spec-reviewer",
>   prompt: "Review the following implementation against guiding principles...",
>   model: "claude-opus-4-6"
> })
> ```
>
> If Agent tool is unavailable, log error: "Agent tool unavailable — cannot complete principles adherence check for convergence."
```

The spec-reviewer agent is defined at `agents/spec-reviewer.md` and expects:
- Input: Work items, architecture doc, module specs, guiding principles
- Output: Deviations from architecture, unmet acceptance criteria, principle violations

Match this contract in the brrr Phase 6c invocation.

## Complexity

Small — single skill file modification, well-bounded scope, existing agent contract to follow.
