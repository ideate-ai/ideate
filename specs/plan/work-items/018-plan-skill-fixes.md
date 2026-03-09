# 018: Plan Skill Fixes

## Objective
Fix architect path handling and add researcher inline output handling in the plan skill.

## Acceptance Criteria
- [ ] Phase 4.1 (architect spawning) provides explicit absolute target paths for architect output files: `{artifact_dir}/plan/architecture.md` and `{artifact_dir}/plan/modules/{name}.md` — not relative paths
- [ ] Phase 2.4 (researcher spawning) includes handling for when the researcher returns output in its response instead of writing to disk: the plan skill writes the response content to the intended output path (`{artifact_dir}/steering/research/{topic-slug}.md`)
- [ ] Phase 4.1 includes a note that if the architect agent lacks Write tool access, the plan skill should write the architect's response content to the target paths

## File Scope
- `skills/plan/SKILL.md` (modify)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes
For architect paths: In Phase 4.1, change the instruction from "The artifact directory path for writing output" to explicitly listing the full absolute paths where output should go.

For researcher inline handling: After Phase 2.4's "How to integrate findings" section, add a "Handling researcher output" subsection:
- If the researcher agent writes directly to the output path, read and integrate.
- If the researcher returns output in its response (because it returned inline), write the response content to `{artifact_dir}/steering/research/{topic-slug}.md` using the Write tool.

For architect Write fallback: Same pattern — if architect returns output in response, write it to the target paths.

## Complexity
Low
