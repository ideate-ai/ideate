# Decision Log — Cycle 004

## Planning Phase

### D1: Bundle manifest.json documentation propagation with new metrics work
- **When**: refine-004 planning session, 2026-03-20
- **Decision**: Address the three cycle 003 open questions (OQ1–OQ3) about manifest.json omissions from README.md, CLAUDE.md, and architecture.md in the same cycle as metrics instrumentation (WI-092 through WI-094), rather than as a standalone micro-cycle.
- **Rationale**: All seven work items touch documentation artifacts and are non-overlapping; bundling reduces cycle overhead while clearing the outstanding documentation debt from cycle 003.
- **Implications**: Three documentation fixes (WI-088, WI-089, WI-090) run in parallel with each other and in parallel with the metrics and scripting work, consistent with GP-4.

### D2: Extend metrics.jsonl schema with token and MCP tracking fields
- **When**: refine-004 planning, 2026-03-20
- **Decision**: Add four token-accounting fields (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`) and one tool-call counter (`mcp_tools_called`) to the metrics.jsonl agent-spawn event. Propagate to all five skill SKILL.md files and brrr/phases/execute.md.
- **Rationale**: Token cost and MCP tool usage are the primary levers for evaluating spawn efficiency. These fields must be present in the log before a reporting script can surface them.
- **Implications**: Projects with earlier-cycle metrics entries will not have these fields; consumers must treat them as nullable. The WI-094 report script was designed with `or 0` fallbacks accordingly.

### D3: Emit a quality_summary event from the review skill after findings are compiled
- **When**: refine-004 planning, 2026-03-20
- **Decision**: After the four review agents complete and before the journal-keeper runs, the review skill emits a structured `quality_summary` event to metrics.jsonl storing severity counts nested under `findings.by_severity` and per-reviewer breakdowns under `findings.by_reviewer`.
- **Rationale**: The reporting script (WI-094) needs machine-readable review-cycle outcome data to populate the Per-Cycle Breakdown and Quality Trends tables. Storing the data in metrics.jsonl keeps the single-file telemetry pattern already established.
- **Implications**: The nested `findings.by_severity` structure was specified in WI-093 SKILL.md but WI-094's implementation note implied flat top-level keys. This inconsistency was not caught before execution and produced the C1/C2 schema mismatch bugs in report.sh.

### D4: Implement report.sh as a standalone Python-inside-shell script using stdlib only
- **When**: refine-004 planning, WI-094 note
- **Decision**: `scripts/report.sh` wraps a Python heredoc using only Python stdlib (`json`, `sys`, `os`, `pathlib`, `datetime`). No third-party libraries.
- **Rationale**: The script must run in any environment where ideate is installed without a separate dependency install step.
- **Implications**: Output formatting is constrained to what plain Python can produce.

### D5: Auto-discovery walks parent directories for .ideate.json to locate metrics.jsonl
- **When**: refine-004 planning, WI-094 note
- **Decision**: If no explicit metrics path is passed, `discover_metrics()` walks from `$PWD` to the filesystem root looking for `.ideate.json`, reads the artifact directory key, and constructs the metrics path from it.
- **Rationale**: Users running `report.sh` from anywhere inside a project should not need to remember the metrics file path.
- **Implications**: The key name was documented in the work item note as `artifact_dir` (snake_case). The canonical key used by all skills and the MCP artifact server is `artifactDir` (camelCase). This mismatch was not caught during planning and produced the S1 bug at `report.sh:83`.

### D6: Remove stale migration scripts and fix stale reviews/ path references in artifact-conventions.md
- **When**: refine-004 planning, 2026-03-20
- **Decision**: Delete `scripts/migrate-to-cycles.sh` and `scripts/migrate-to-domains.sh` (deferral from cycle 003 OQ4) and fix all remaining `reviews/` path references in `specs/artifact-conventions.md` (cycle 003 OQ6). Scope WI-091 to these two tasks only.
- **Rationale**: The cycle 003 interview stated these scripts would be removed; removal was deferred at that time.
- **Implications**: WI-091 was scoped narrowly to artifact-conventions.md; `skills/refine/SKILL.md` was not in scope and retained 6 stale `reviews/final/` references (flagged as M1 in both code-quality and spec-adherence).

---

## Execution Phase

### D7: WI-090 required a second pass to fix stale paths in architecture.md Sections 1, 2, 3, and 7
- **When**: WI-090 incremental review, 2026-03-20
- **Decision**: The incremental review found 14 remaining stale `reviews/` path references in sections not covered by the original work item scope. These were fixed during rework before the item was marked complete.
- **Rationale**: Continuous review model — incremental reviews trigger rework before the capstone.
- **Implications**: architecture.md is now fully consistent on the `archive/` path convention.

### D8: WI-093 executor placed severity counts nested under findings.by_severity
- **When**: WI-093 execution, 2026-03-20
- **Decision**: The executor placed severity counts at `findings.by_severity.critical`, `findings.by_severity.significant`, `findings.by_severity.minor` in the emitted JSON structure.
- **Rationale**: The WI-093 SKILL.md spec defined a nested structure.
- **Implications**: WI-094's report.sh was implemented with flat key reads (`qe.get('critical', 0)`), producing a permanent mismatch. This is the root cause of C1 and C2.

### D9: WI-094 incremental review passed despite schema mismatch and key-name bug being present
- **When**: WI-094 incremental review, 2026-03-20
- **Decision**: The incremental reviewer accepted the implementation as passing (with one significant rework item for lexicographic sort). The C1/C2 schema mismatch and S1 key-name bug were not caught at the incremental stage.
- **Rationale**: Not recorded.
- **Implications**: The bugs propagated to the capstone review where they were caught as critical findings. The cycle 004 verdict is Fail.

---

## Review Phase

### D10: Cycle 004 verdict: Fail
- **When**: Capstone review, 2026-03-20
- **Decision**: All three reviewers (code-quality, spec-adherence, gap-analysis) issued Fail verdicts.
- **Rationale**: Two critical bugs (C1, C2: severity counts always 0) and two unmet acceptance criteria (WI-094 criteria 7 and 12) in report.sh; one broken auto-discovery path (S1/S2: `artifact_dir` vs. `artifactDir`); one significant documentation gap (G-S1: `metrics.jsonl` absent from artifact-conventions.md).
- **Implications**: A brrr cycle 2 is required to fix report.sh and close the artifact-conventions.md documentation gap.

### D11: Domain curator skipped for cycle 004
- **When**: Post-review synthesis, 2026-03-20
- **Decision**: The domain curator was not run after cycle 004.
- **Rationale**: The findings are implementation bugs and integration mismatches in a single script (report.sh), not policy-grade decisions or new conventions that warrant domain knowledge updates.
- **Implications**: No domain layer changes this cycle.

---

## Open Questions

### OQ1: report.sh severity counts always display as 0
- **Source**: code-quality C1 (lines 207–209), C2 (lines 376–378); spec-adherence S1; unmet WI-094 criteria 7 and 12
- **Impact**: Per-Cycle Breakdown and Quality Trends tables are silently wrong. Every row shows 0 Critical, 0 Significant, 0 Minor. Trend indicator always reports "stable."
- **Fix**: Replace flat `qe.get('critical', 0)` etc. with `qe.get('findings', {}).get('by_severity', {}).get('critical', 0)` at lines 207–209 and 376–378.
- **Consequence of inaction**: Every report generated shows incorrect quality data. Users cannot use report.sh to assess project quality history.

### OQ2: report.sh auto-discovery fails for all real projects
- **Source**: code-quality S1 (line 83); spec-adherence S2; gap-analysis G-M1
- **Impact**: `discover_metrics()` looks for `artifact_dir`; every ideate project uses `artifactDir`. Auto-discovery returns None and exits with an error. Only explicit path mode works.
- **Fix**: Change line 83 to `config.get('artifactDir') or config.get('artifact_dir')`. Update help text (line 25) and error message (line 85).
- **Consequence of inaction**: Auto-discovery mode is permanently broken. The discoverability feature of report.sh is non-functional for all real projects.

### OQ3: metrics.jsonl absent from specs/artifact-conventions.md
- **Source**: gap-analysis G-S1 (significant); code-quality M2
- **Impact**: artifact-conventions.md is the authoritative artifact schema reference. metrics.jsonl has no entry in the directory tree and no schema section.
- **Consequence of inaction**: New contributors cannot find the metrics.jsonl schema from the canonical reference document. Future schema changes have no stable home.

### OQ4: Stale reviews/final/ paths remain in skills/refine/SKILL.md
- **Source**: code-quality M1; spec-adherence M1
- **Impact**: Phase 3.2 (lines 87–92) and Phase 5 (lines 108, 124) reference `reviews/final/summary.md`, which was removed in the domain layer migration.
- **Consequence of inaction**: Refine skill is brittle for projects on the pre-migration layout if the legacy fallback is exercised.

### OQ5: fmt_ms(0) displays "0s" for entries with missing timing data
- **Source**: code-quality M3
- **Impact**: Spawns with no `wall_clock_ms` appear as "0s" rather than "-".
- **Fix**: Add `if not ms: return "-"` at the top of `fmt_ms`.
- **Consequence of inaction**: Wall-clock column is ambiguous for spawns without timing data. Minor display issue only.

### OQ6: brrr/phases/review.md metrics instruction does not enumerate new token fields
- **Source**: gap-analysis G-M2
- **Impact**: Minor navigability friction. No functional gap; the indirection to controller SKILL.md resolves correctly.
- **Recommendation**: Defer — consistent indirection pattern across phase files.

---

## Cross-References

### CR1: report.sh schema mismatch — severity counts nested vs. flat
- **Code review**: C1 (lines 207–209), C2 (lines 376–378)
- **Spec review**: S1 — same finding; root cause attributed to inconsistency between WI-093 and WI-094 specs
- **Gap analysis**: Not separately flagged
- **Connection**: Spec-level inconsistency — WI-094's note implied flat keys while WI-093's SKILL.md defined a nested structure. Both work items were internally consistent but conflict at the integration boundary. OQ1 is the remediation item.

### CR2: report.sh auto-discovery key name mismatch
- **Code review**: S1 (line 83)
- **Spec review**: S2 — same finding, unmet acceptance criterion 3
- **Gap analysis**: G-M1 — HELP string also documents the wrong key name
- **Connection**: Both the code bug and the documentation gap touch the same region of report.sh. Address together. OQ2 covers both.

### CR3: metrics.jsonl not in artifact-conventions.md
- **Code review**: M2 — directory tree missing `metrics.jsonl`
- **Spec review**: No finding
- **Gap analysis**: G-S1 — significant gap: no directory tree entry and no schema section
- **Connection**: artifact-conventions.md requires both a tree entry and a new schema section. OQ3 covers both.

### CR4: Stale reviews/ paths in skills/refine/SKILL.md
- **Code review**: M1 — 6 references at lines 87–92, 108, 124
- **Spec review**: M1 — same finding, same lines
- **Gap analysis**: Not separately flagged
- **Connection**: Both reviewers independently identified the same omission from WI-091's scope. Findings are in agreement. OQ4 is the remediation item.
