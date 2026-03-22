## Verdict: Pass

All criteria satisfied post-rework; S1 cycle sort fixed (numeric), AC15 missing-file case fixed (returns empty, exits 0), M2-M3 cleaned up.

## Critical Findings

None.

## Significant Findings

### S1: Per-Cycle Breakdown sorts cycles lexicographically, not numerically
- **File**: `/Users/dan/code/ideate/scripts/report.sh:183`
- **Issue**: `all_cycles` is sorted with `key=lambda x: (x is None, str(x))`. When cycle values are integers (as they would be in a JSON-produced metrics file), `str()` coercion causes lexicographic ordering. Cycle 10 sorts between 1 and 2 (`'1' < '10' < '2'`). The Quality Trends section at line 363 sorts with `key=lambda e: (e.get('cycle') is None, e.get('cycle'))`, which uses native integer comparison and is correct. The two sections are inconsistent, and the Per-Cycle Breakdown ordering is wrong for any project reaching cycle 10+.
- **Impact**: The Per-Cycle Breakdown table rows appear out of order for projects with 10 or more cycles, making trend reading unreliable.
- **Suggested fix**: Change the sort key on line 183 to use numeric-aware ordering:
  ```python
  all_cycles = sorted(
      set(list(by_cycle.keys()) + list(quality_by_cycle.keys())),
      key=lambda x: (x is None, x != '(none)', x if isinstance(x, (int, float)) else str(x))
  )
  ```
  Or, more simply, separate the `'(none)'` sentinel from real cycle values and sort the real values natively before appending `'(none)'` at the end.

## Minor Findings

### M1: Missing metrics file exits 1 rather than producing an empty report
- **File**: `/Users/dan/code/ideate/scripts/report.sh:101`
- **Issue**: When the metrics file path is resolved via auto-discovery but the file does not yet exist (valid for a project that has never been run), `load_entries` prints an error to stderr and calls `sys.exit(1)`. Criterion 15 states "Empty/missing metrics.jsonl handled gracefully." The empty-file case (file exists, zero valid lines) correctly produces "No metrics data found." and exits 0. The missing-file case does not match that behaviour.
- **Suggested fix**: In `load_entries`, change the missing-file branch to return `([], [])` instead of exiting, then let `main` print "No metrics data found." and exit 0. The error message is still useful — print it as a warning to stderr rather than a fatal error, or emit it only when the path was given explicitly by the user.

### M2: Dead `x is None` branch in cycle sort key
- **File**: `/Users/dan/code/ideate/scripts/report.sh:183`
- **Issue**: The sort key `lambda x: (x is None, str(x))` includes a `x is None` guard, but `None` can never appear in `all_cycles`: `by_cycle` maps `None` cycles to the string `'(none)'` (line 180), and `quality_by_cycle` skips `None` cycles entirely (lines 172–175). The guard is unreachable dead code.
- **Suggested fix**: Remove the `x is None` guard once the numeric-sort fix from S1 is applied, or document why the guard exists.

### M3: `fmt_ms(0)` displays `0s` for cycles with no timing entries
- **File**: `/Users/dan/code/ideate/scripts/report.sh:196`
- **Issue**: In `section_per_cycle_breakdown`, cycles that exist only in `quality_events` (no corresponding metric entries) will show `0s` wall clock and `0` tokens rather than `-`, because `sum(...)` over an empty list returns 0 and `fmt_ms(0)` returns `'0s'`. This can mislead a reader into thinking a cycle ran but was instantaneous.
- **Suggested fix**: Check whether `cycle_entries` is empty and emit `-` explicitly:
  ```python
  wall_str = fmt_ms(wall) if cycle_entries else '-'
  tok_str = fmt_tokens(tok) if cycle_entries else '-'
  ```

## Unmet Acceptance Criteria

- [ ] **Criterion 15** (Empty/missing metrics.jsonl handled gracefully) — A missing metrics file causes `sys.exit(1)` with an error message rather than producing an empty report. Only a zero-byte or all-blank file is handled gracefully (exits 0). See M1.
