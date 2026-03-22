# Review Summary — Cycle 004

## Overview

Cycle 004 (brrr cycle 1) delivered seven work items: three documentation propagation fixes for manifest.json (WI-088, WI-089, WI-090), deletion of stale migration scripts and cleanup of stale path references in artifact-conventions.md (WI-091), extension of the metrics.jsonl schema with token and MCP tracking fields across all five skills (WI-092), quality_summary event emission from the review skill (WI-093), and a new metrics reporting script (WI-094).

Six of the seven work items are correct and all their acceptance criteria are met. The manifest.json documentation is now consistent across README.md, CLAUDE.md, architecture.md, and artifact-conventions.md. The metrics schema extension is correctly applied across all six target files. The quality_summary event structure in skills/review/SKILL.md is well-formed.

WI-094 (report.sh) has two integration bugs that cause it to silently produce wrong output and to fail on auto-discovery for every real project. Both bugs originate from a spec-level inconsistency between WI-093 (which defined nested `findings.by_severity` keys) and WI-094's implementation (which reads flat top-level keys). The incremental reviewer for WI-094 did not catch either bug before the capstone.

## Verdict: Fail

### Findings that block convergence

**C1 — Per-Cycle Breakdown severity counts always 0** (`scripts/report.sh:207-209`)
`section_per_cycle_breakdown` reads `qe.get('critical', 0)` etc. directly from the quality_summary event object. The WI-093 schema stores these values at `findings.by_severity.critical` etc. The flat keys never exist; all three severity columns always display 0.
Source: code-quality C1, spec-adherence S1. Unmet: WI-094 criterion 7.

**C2 — Quality Trends severity counts always 0** (`scripts/report.sh:376-378`)
`section_quality_trends` has the same structural mismatch as C1. The Quality Trends table is always all zeros; the trend indicator always reports "stable."
Source: code-quality C2, spec-adherence S1. Unmet: WI-094 criterion 12.

**S1/S2 — Auto-discovery broken: `artifact_dir` vs. `artifactDir`** (`scripts/report.sh:83`)
`discover_metrics()` calls `config.get('artifact_dir')`. Every `.ideate.json` written by the skills uses the camelCase key `artifactDir`. Auto-discovery returns None and exits with an error for every real project. Only explicit `report.sh /path/to/metrics.jsonl` mode works.
Source: code-quality S1, spec-adherence S2, gap-analysis G-M1. Unmet: WI-094 criterion 3.

**G-S1 — `metrics.jsonl` absent from `specs/artifact-conventions.md`**
artifact-conventions.md is the authoritative artifact schema reference. metrics.jsonl — written by all five skills and the sole data source for report.sh — is not listed in the directory tree and has no schema section. The quality_summary event schema exists only in skills/review/SKILL.md.
Source: gap-analysis G-S1, code-quality M2.

### Unmet acceptance criteria

- WI-094 Criterion 3 (auto-discovery via `.ideate.json` walk) — key lookup fails (S1/S2)
- WI-094 Criterion 7 (Per-Cycle Breakdown Critical/Significant/Minor columns) — always 0 (C1)
- WI-094 Criterion 12 (Quality Trends with trend indicator) — counts always 0, trend always "stable" (C2)

## Items That Passed Cleanly

| WI | Title | Verdict | Notes |
|----|-------|---------|-------|
| 088 | README.md — add manifest.json, update migration section | Pass | 1 significant rework: fixed broken cross-reference in Migration subsection |
| 089 | CLAUDE.md — add manifest.json to artifact structure diagram | Pass | No findings |
| 090 | architecture.md — add manifest.json to permissions table and Section 8 | Pass | 4 significant rework: 14 stale `reviews/` paths in Sections 1/2/3/7 corrected |
| 091 | Delete stale migration scripts, fix artifact-conventions.md stale paths | Pass | No findings |
| 092 | Extend metrics.jsonl schema with token and MCP fields in all skills | Pass | 1 minor rework: added schema completeness note to brrr/phases/execute.md |
| 093 | Quality summary event emission from review skill | Pass | 3 minor rework: keyword list, suggestion field symmetry, work_items_reviewed fallback path |

WI-094 (report.sh) received a passing incremental review verdict but has three critical/significant integration bugs identified at the capstone.

## Minor Findings (non-blocking)

- **M1** (code-quality, spec-adherence): `skills/refine/SKILL.md` retains 6 stale `reviews/final/` path references at lines 87–92, 108, 124. Outside WI-091 scope.
- **M3** (code-quality): `fmt_ms(0)` returns "0s" rather than "-" for entries with missing timing data (`report.sh:57-68`).
- **G-M2** (gap-analysis): `brrr/phases/review.md` metrics instruction does not enumerate new token fields; deferred given consistent indirection pattern.

## Proposed Next Cycle (brrr cycle 2)

Three work items, all independent and parallelizable:

1. **Fix report.sh** — correct severity key path at lines 207–209 and 376–378; fix `artifact_dir` → `artifactDir` at line 83; update help text and error message; fix `fmt_ms(0)` display ambiguity. (Resolves C1, C2, S1/S2, OQ1, OQ2, OQ5)
2. **Document metrics.jsonl in artifact-conventions.md** — add to directory tree and add a schema section covering the standard agent-spawn event, quality_summary event, best-effort write semantics, and report.sh as consumer. (Resolves G-S1, OQ3)
3. **Fix stale reviews/final/ paths in skills/refine/SKILL.md** — update Phase 3.2 legacy fallback (lines 87–92) and Phase 5 (lines 108, 124) to reference `archive/cycles/{NNN}/`. (Resolves M1, OQ4)
