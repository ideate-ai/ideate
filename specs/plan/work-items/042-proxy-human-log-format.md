# Work Item 042: Unify proxy-human Log Format

## Objective

Resolve the conflict between the log entry format specified in `agents/proxy-human.md` and the format specified in `skills/brrr/SKILL.md` Phase 6a spawn prompt. Establish a single canonical format, update both files to match, and ensure Phase 9 activity report parsing logic in brrr is consistent with the canonical format.

## Acceptance Criteria

1. `agents/proxy-human.md` Step 5 log format and `skills/brrr/SKILL.md` Phase 6a spawn prompt specify identical log entry format
2. Canonical format is: `## [proxy-human] {date} — Cycle {cycle_number}` heading with `Event:`, `Decision:`, `Confidence:`, and `Rationale:` fields (the brrr format — it contains `Cycle N` which Phase 9 extraction depends on)
3. `agents/proxy-human.md` Step 5 is updated to use the canonical format (replacing the `## Decision Entry` format with bold key-value fields)
4. `skills/brrr/SKILL.md` Phase 6a spawn prompt either removes the format re-specification (deferring to agent definition) or matches the canonical format exactly
5. `skills/brrr/SKILL.md` Phase 9 activity report extraction logic correctly identifies entries by the `## [proxy-human] {date} — Cycle N` heading pattern
6. No format specification exists in either file that contradicts the canonical format

## File Scope

- modify: `agents/proxy-human.md`
- modify: `skills/brrr/SKILL.md`

## Dependencies

- 041 (both files were modified by WI-041; WI-042 must run after to avoid conflicts)

## Implementation Notes

**Canonical format** (brrr's format wins because Phase 9 already parses it by cycle number in the heading):

```markdown
## [proxy-human] {ISO date} — Cycle {cycle_number}
Event: {one-line event summary}
Decision: {PROCEED | DEFER | ESCALATE}
Confidence: {HIGH | MEDIUM | LOW}
Rationale: {explanation of the decision and reasoning}
```

**agents/proxy-human.md**: Locate the Step 5 section describing how to write to `proxy-human-log.md`. Replace the `## Decision Entry` format block with the canonical format above.

**skills/brrr/SKILL.md Phase 6a spawn prompt**: The spawn prompt currently re-specifies a log format. Change this to: "Write your decision to {artifact_dir}/proxy-human-log.md following the entry format defined in your agent definition." This removes the redundant format specification from the spawn prompt.

**skills/brrr/SKILL.md Phase 9**: Verify the extraction logic matches the canonical heading pattern. The instruction should say something like: "Extract entries matching the pattern `## [proxy-human] {date} — Cycle N` — the cycle number in the heading is the key for per-cycle correlation."

## Complexity

Low
