## Verdict: Fail

Two bugs in report.sh cause quality finding columns to always display 0, and the auto-discovery key name diverges from the actual .ideate.json format used by the MCP server and all skill prompts.

## Critical Findings

### C1: Quality finding counts always read as zero in Per-Cycle Breakdown
- **File**: `/Users/dan/code/ideate/scripts/report.sh:207-209`
- **Issue**: `section_per_cycle_breakdown` reads severity counts directly off the quality_summary event object: `qe.get('critical', 0)`, `qe.get('significant', 0)`, `qe.get('minor', 0)`. The WI-093 schema (SKILL.md Phase 7.6.2) nests these under `findings.by_severity`: `{"findings": {"by_severity": {"critical": N, "significant": N, "minor": N}}}`. Those top-level keys will never exist; all three calls return 0.
- **Impact**: The Per-Cycle Breakdown table Critical, Significant, and Minor columns are always 0 regardless of actual review findings. The table is silently wrong every time quality_summary events exist.
- **Suggested fix**: Replace the three `qe.get(...)` calls at lines 207–209 with:
  ```python
  findings = qe.get('findings') or {}
  by_sev = findings.get('by_severity') or {}
  critical = by_sev.get('critical', 0) or 0
  significant = by_sev.get('significant', 0) or 0
  minor = by_sev.get('minor', 0) or 0
  ```

### C2: Quality finding counts always read as zero in Quality Trends
- **File**: `/Users/dan/code/ideate/scripts/report.sh:376-378`
- **Issue**: `section_quality_trends` has the same structural mismatch. Lines 376–378 read `e.get('critical', 0)`, `e.get('significant', 0)`, `e.get('minor', 0)` directly from the quality_summary event. Same wrong path as C1.
- **Impact**: The Quality Trends table is always all zeros; the trend indicator will always be 'stable' regardless of actual quality history.
- **Suggested fix**: Same pattern as C1. Replace the three `e.get(...)` calls with:
  ```python
  findings = e.get('findings') or {}
  by_sev = findings.get('by_severity') or {}
  critical = by_sev.get('critical', 0) or 0
  significant = by_sev.get('significant', 0) or 0
  minor = by_sev.get('minor', 0) or 0
  ```

## Significant Findings

### S1: Auto-discovery reads `artifact_dir` but .ideate.json stores `artifactDir` (camelCase)
- **File**: `/Users/dan/code/ideate/scripts/report.sh:83-85`
- **Issue**: `discover_metrics()` calls `config.get('artifact_dir')`. The MCP server (`mcp/artifact-server/src/config.ts:17`) reads `raw.artifactDir` — the JSON key is camelCase `artifactDir`, not snake_case `artifact_dir`. The review SKILL.md Phase 1.1 and brrr SKILL.md Phase 1 both reference `artifactDir` when describing how they read `.ideate.json`. Any actual `.ideate.json` file written by ideate or by users following the skill instructions will use `artifactDir`, causing `config.get('artifact_dir')` to return `None` and auto-discovery to fail with the error: `.ideate.json at {path} has no artifact_dir key`.
- **Impact**: Auto-discovery is broken for every user who does not manually pass a metrics path. The only functional usage mode is explicit `report.sh path/to/metrics.jsonl`.
- **Suggested fix**: Change line 83 to read both keys with preference for the canonical one:
  ```python
  artifact_dir = config.get('artifactDir') or config.get('artifact_dir')
  ```
  Update the error message at line 85 to name both key options. Update the help text at line 25 to document the key name as `artifactDir`.

## Minor Findings

### M1: Stale `reviews/final/` paths in skills/refine/SKILL.md are not fixed
- **File**: `/Users/dan/code/ideate/skills/refine/SKILL.md:87-92,108,124`
- **Issue**: WI-091 was scoped to `specs/artifact-conventions.md`. The refine skill still contains 6 references to the removed `reviews/final/` and `reviews/incremental/` paths in its legacy fallback block and Phase 5 interview instructions. These paths correspond to the deleted pre-migration layout.
- **Suggested fix**: The legacy fallback at lines 87–92 should reference `archive/cycles/{NNN}/` files, not `reviews/final/`. The Phase 5 reference at lines 108 and 124 to `reviews/final/summary.md` should be updated to `archive/cycles/{NNN}/summary.md` (reading the latest cycle directory). This was not part of WI-091's stated scope but represents an inconsistency introduced by the partial cleanup that cycle performed.

### M2: `metrics.jsonl` omitted from `archive/cycles/{NNN}/` directory listing in artifact-conventions.md
- **File**: `/Users/dan/code/ideate/specs/artifact-conventions.md:30-38`
- **Issue**: The directory structure diagram in artifact-conventions.md does not include `metrics.jsonl`, which was added at the artifact directory root level as part of WI-092. The README.md (WI-088) and architecture.md (WI-090) both include it; artifact-conventions.md does not.
- **Suggested fix**: Add `├── metrics.jsonl` to the directory tree at line 38, after `journal.md`, consistent with README.md line 83.

### M3: `fmt_ms` formats zero-millisecond wall clock as "0s" rather than "-"
- **File**: `/Users/dan/code/ideate/scripts/report.sh:57-68`
- **Issue**: `fmt_ms(0)` returns `"0s"` because `ms = int(0) = 0`, which is not `None`. Entries with no timing data default to `wall_clock_ms = 0` via the `or 0` fallback (lines 133, 199, 263), so a spawn with missing timing appears as `0s` rather than `-`. This is a display ambiguity: `0s` looks like a sub-second operation rather than missing data.
- **Suggested fix**: Add a check at the top of `fmt_ms`: `if not ms: return "-"` (which handles both `None` and `0`).

## Unmet Acceptance Criteria

None.
