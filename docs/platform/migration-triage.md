# Migration Triage Report

**Date**: 2026-04-03
**Source**: WI-580 (migration error categorization) + WI-582 (SQLite parity audit)
**Project**: PR-003 (Migration Tool Refinement)

---

## Executive Summary

Two diagnostic spikes identified **793 total issues** across the migration pipeline and SQLite indexer:

- **714 migration errors** — 84% caused by a single Zod validation bug (nullable fields)
- **79 SQLite indexer defects** — 48% are missing extension table columns, 18% null-to-default coercion

The issues cluster into **3 root causes** that, when fixed, resolve ~90% of all problems:
1. Migration validator rejects nullable `cycle_created`/`cycle_modified` fields (598 errors)
2. SQLite extension tables missing columns for fields added after initial schema (38 defects)
3. Indexer `?? ""` / `?? "feature"` pattern coerces nulls to defaults (14 defects)

---

## Triage Table

| # | Finding | Owner | Severity | Fix Type | Phase |
|---|---|---|---|---|---|
| T-01 | Migration: `cycle_created`/`cycle_modified` nullable validation (598 errors) | Server | Critical | Zod schema: `.nullable().optional()` | 2 |
| T-02 | Migration: YAML indentation in findings (62 parse errors) | Plugin (data) | Minor | Fix YAML files or tolerant parser | 2 |
| T-03 | Migration: Unregistered artifact types — full_audit, code-quality, etc. (6 errors) | Server | Minor | Add to TYPE_TO_LABEL_MAP as Document | 2 |
| T-04 | Migration: Non-artifact files counted as errors (7 errors) | Server | Cosmetic | Add to discovery skip list | 2 |
| T-05 | SQLite: Missing `resolution` column in work_items (5/10 sampled) | Plugin | Significant | Add column + schema migration | 2 |
| T-06 | SQLite: Missing `title` column in findings (5/5 sampled) | Plugin | Significant | Add column + schema migration | 2 |
| T-07 | SQLite: Missing `title`, `source` columns in domain_decisions (2/5 sampled) | Plugin | Minor | Add columns + schema migration | 2 |
| T-08 | SQLite: Missing `completed_date` in phases (3/3 sampled) | Plugin | Minor | Add column + schema migration | 2 |
| T-09 | SQLite: Missing `current_phase_id` in projects (2/2 sampled) | Plugin | Significant | Add column + schema migration | 2 |
| T-10 | SQLite: GP field name mismatch (`title`/`body` vs `name`/`description`) | Plugin | Minor | Add fallback mapping in buildExtensionRow | 2 |
| T-11 | SQLite: Phase field `project_id` vs `project` variant | Plugin | Minor | Add fallback mapping | 2 |
| T-12 | SQLite: Metrics `event_name` overridden by `agent_type` (3/3 sampled) | Plugin | Significant | Fix precedence in indexer.ts | 2 |
| T-13 | SQLite: Null-to-default coercion via `?? ""` pattern (14 defects) | Plugin | Minor | Relax NOT NULL or document as intentional | 3 |
| T-14 | Migration: YAML other parse errors (22 errors) | Plugin (data) | Minor | Fix individual files or tolerant parser | 3 |
| T-15 | SQLite: Stale token_count (4/53 sampled) | None | Cosmetic | Self-correcting on rebuild | Accept |
| T-16 | SQLite: Missing file refs for WI-529 scope entries | None | Minor | Watcher timing — self-correcting | Accept |
| T-17 | SQLite: Phantom edge PH-015→PR-001 from write handler | None | Minor | Semantically correct, field name variant | Accept |
| T-18 | Neo4j: Ensure identical column/property treatment as SQLite fixes | Server | Critical | Mirror all SQLite schema changes in Neo4j | 3 |

---

## Phase 2: Defect Remediation — Proposed Work Items

### Server-side (ideate-server)

| WI | Title | Fixes | Complexity |
|---|---|---|---|
| S-01 | Fix Zod schema nullable validation for cycle fields | T-01 | Small |
| S-02 | Register missing artifact types in TYPE_TO_LABEL_MAP | T-03 | Small |
| S-03 | Add non-artifact files to discovery skip list | T-04 | Small |

### Plugin-side (ideate — this repo)

| WI | Title | Fixes | Complexity |
|---|---|---|---|
| P-01 | Add missing extension table columns (schema v5 migration) | T-05, T-06, T-07, T-08, T-09 | Medium |
| P-02 | Fix field name fallbacks in buildExtensionRow | T-10, T-11 | Small |
| P-03 | Fix metrics event_name precedence in indexer | T-12 | Small |

### Data cleanup (ideate — this repo)

| WI | Title | Fixes | Complexity |
|---|---|---|---|
| D-01 | Fix YAML indentation in early finding files | T-02 | Small |
| D-02 | Normalize field names in legacy YAML (GP title→name, PH project_id→project) | T-10, T-11 | Small |

---

## Phase 3: Equivalence Test Infrastructure — Scope Refinement

Based on the audit findings, the equivalence tests need to verify:

1. **All extension table fields match** — for each of the 11 missing columns identified, verify both backends store and return the same value
2. **Null handling is consistent** — verify both backends treat null/empty the same way for nullable fields
3. **Edge extraction is complete** — verify both backends produce identical edge sets from the same YAML
4. **Metrics payload structure** — verify the computed payload JSON matches between backends
5. **Token count and content hash** — verify both backends compute the same values (already confirmed identical in the audit)

### Test fixture requirements
- A synthetic `.ideate/` directory with ~20 artifacts covering all types
- Known field values for every field that the SQLite extension tables track
- At least one artifact per type with nullable fields set to null
- At least one work item with `depends`, `scope`, and `domain` fields to test edge extraction
- At least one metrics event with both `event_name` and `agent_type` set

---

## Phase 4: Production Validation — Scope Refinement

After Phase 2 fixes and Phase 3 tests:

1. Re-run migration against ideate/.ideate/ — target: <30 errors (down from 714)
2. Re-run SQLite parity audit (scripts/audit-sqlite-parity.mjs) — target: 0 significant defects
3. Run equivalence test suite — target: all StorageAdapter methods return identical results
4. Run dogfood acceptance criteria from migration-tool-spec.md Section 15
5. Produce final parity report confirming both backends are pristine

---

## Accepted Gaps

| Finding | Rationale |
|---|---|
| T-15: Stale token_count | Self-correcting on next rebuildIndex. No code fix needed. |
| T-16: Missing file refs for WI-529 | Watcher timing issue. Self-correcting on rebuild. |
| T-17: Phantom edge PH-015→PR-001 | Edge is semantically correct (phase does belong to project). Field name variant, not a bug. |

---

## Summary

| Category | Total Issues | Phase 2 Fixes | Accepted |
|---|---|---|---|
| Migration errors | 714 | 3 server WIs | — |
| SQLite defects | 79 | 3 plugin WIs + 2 data cleanup WIs | 3 accepted |
| **Total** | **793** | **8 work items** | **3 accepted** |

**Expected post-Phase-2 state**:
- Migration errors: 714 → ~22
- SQLite defects: 79 → ~4 (stale token counts only)
- Both backends: field-complete, edge-complete, hash-correct
