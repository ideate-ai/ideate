# Spec Adherence Review

## Unmet Acceptance Criteria

### [Work Item 001] `claude plugin validate` never run
Criterion: "Plugin validates cleanly with `claude plugin validate`"
Status: Not verified. The incremental review deferred this to "end-of-execution validation" which was never performed.

### [Work Item 010] Token budget tracking not implemented
Criterion: "Total token budget tracking (logged, not enforced — for user awareness)"
Status: Entirely absent from implementation. The server has no token count field and no logging of token consumption.

## Architecture Deviations

### spawn_session — output_format parameter not in architecture spec
Architecture section 5 defines the tool interface without `output_format`. Work item 010 added it. Implementation follows the work item, creating inconsistency with architecture spec.
Architecture says: 7 parameters (prompt, working_dir, max_turns, max_depth, timeout, permission_mode, allowed_tools)
Implementation has: 8 parameters (adds output_format)

### spawn_session — undocumented return fields
Architecture return schema specifies 5 fields: output, exit_code, session_id, duration_ms, error.
Implementation adds: output_truncated, full_output_path, timed_out in relevant cases.

### Agent background field missing from all agent frontmatter
Architecture table lists `Background: no` for architect, code-reviewer, spec-reviewer, gap-analyst, journal-keeper; `Background: yes` for researcher. Only the researcher agent has a `background` field in its frontmatter. All others omit it entirely.

### Architect has no Write tool but is instructed to write files
Architecture lists architect tools as: Read, Grep, Glob, Bash. The architect's instructions tell it to write to `plan/architecture.md` and `plan/modules/*.md`. Writing is only possible via Bash, which is not explicitly stated.

## Guiding Principle Violations

None found. All 12 principles have evidence of adherence in the implementation.

## Undocumented Additions

- Resume detection in execute skill (not in architecture or work item 007)
- Worker agent retry-once policy in execute skill error handling
- Project source root derivation with four-step precedence in refine skill
- `IDEATE_MAX_CONCURRENCY` environment variable for concurrency configuration
- `cwd` argument passed to both `claude --cwd` and `subprocess.run(cwd=)` (belt-and-suspenders)
- Working directory existence validation before spawning

All undocumented additions are sensible safety measures or usability improvements. None contradict the specification.
