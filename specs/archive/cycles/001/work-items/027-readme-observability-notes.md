# 027: README Observability Notes

## Objective
Add two clarifying notes to the session spawner README: a concurrency non-determinism note in the Status Table section, and an overflow temp file lifecycle note in the Output Truncation section.

## Acceptance Criteria
- [ ] Status Table section contains a note stating that row order reflects completion order, not start order, when sessions run concurrently
- [ ] Output Truncation section (or a new Limitations subsection within it) contains a note stating that `ideate-session-*.txt` overflow files are not automatically deleted and must be cleaned up manually
- [ ] No other README content is modified

## File Scope
- `mcp/session-spawner/README.md` (modify)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes

### Status Table concurrency note
Append to the existing Status Table section, after the column description line:

```
When multiple sessions execute concurrently, rows appear in completion order, not start order. The table is reprinted after each session completes, so earlier rows may shift position between prints.
```

Place this after the line that describes the columns (ending with "Column widths expand to fit content.").

### Output Truncation overflow file note
Append to the existing Output Truncation section:

```
Overflow files are not automatically deleted. They accumulate in the `working_dir` of the call that produced them. Clean them up manually when no longer needed, or implement periodic cleanup in your workflow (e.g., `find . -name 'ideate-session-*.txt' -delete`).
```

Place this after the existing JSON block showing `output_truncated` and `full_output_path`.

## Complexity
Low
