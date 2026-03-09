# 020: Researcher Agent — Add Write Tool

## Objective
Add the Write tool to the researcher agent's tool list so it can save findings directly to disk.

## Acceptance Criteria
- [ ] `agents/researcher.md` frontmatter `tools` list includes `Write`
- [ ] The conditional language in the agent's instructions ("If you have access to a Write tool") is replaced with a direct instruction to write to the specified output path
- [ ] The fallback behavior (return in response if Write unavailable) is removed since Write is now always available

## File Scope
- `agents/researcher.md` (modify)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes
In the frontmatter, add `- Write` to the tools list.

In the instructions section (around line 58), change:
```
If your spawn prompt specifies an output file path AND you have access to a Write tool, save the structured report to that path. Otherwise, return the report in your response — the spawning skill will handle it.
```
to:
```
Save the structured report to the output file path specified in your spawn prompt.
```

The plan skill fix (work item 018) adds fallback handling for when the researcher returns inline output despite having Write access. This is belt-and-suspenders — the researcher should write directly, but the plan skill handles the case where it doesn't.

## Complexity
Low
