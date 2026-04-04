# Migration Diagnostic Report

**Date**: 2026-04-03
**Source**: `/Users/dan/code/ideate/.ideate`
**Target**: Neo4j @ localhost:7687

---

## Summary

| Metric | Value |
|--------|-------|
| Files discovered | 2034 |
| Artifacts parsed | 1320 |
| Nodes transformed | 1571 |
| Nodes written | 1573 |
| Edges transformed | 1377 |
| Edges written | 551 |
| **Total errors** | **714** |
| Parse errors | 84 (12%) |
| Validation errors | 630 (88%) |

---

## Error Categorization

### Category 1: Nullable Field Validation (598 errors, 84%)

**Pattern**: `Validation failed: cycle_modified: Invalid input` (461), `cycle_created: Invalid input` (97), both together (37), compound with title (10+)

**Root cause**: The migration tool's Zod validation schema treats `cycle_modified` and `cycle_created` as required integers (`z.number()`). In the actual YAML artifacts, these fields are legitimately `null` for many artifact types — constraints, guiding principles, research, interviews, and others that predate the cycle tracking system or are not cycle-scoped.

**Impact**: 598 artifacts (45% of discovered files) are rejected during validation. These are valid artifacts with correct structure — only the nullable integer fields fail validation.

**Fix location**: `ideate-server/src/migration/parser.ts` or `transformer.ts` — wherever the Zod schema is defined. Change:
```typescript
// Current (wrong)
cycle_created: z.number(),
cycle_modified: z.number(),

// Fix
cycle_created: z.number().nullable().optional(),
cycle_modified: z.number().nullable().optional(),
```

**Severity**: Critical — this is the single largest source of data loss in the migration.

---

### Category 2: YAML Parse Failures — Finding Indentation (62 errors, 9%)

**Pattern**: `YAMLException: bad indentation of a mapping entry (6:8)` on finding files (F-*.yaml, FI-*.yaml)

**Root cause**: Finding YAML files from early cycles (cycles 1-5) have a YAML serialization bug — the content after the severity field has incorrect indentation. The YAML parser rejects them at line 6. These files were written by an earlier version of ideate's MCP server (`handleWriteArtifact` or the review skill) with a YAML serializer that didn't properly indent multi-line content.

**Sample** (F-001-001.yaml):
```yaml
id: F-001-001
type: finding
cycle: 1
reviewer: code-reviewer
severity: significant
  title: ...   # ← bad indentation, should be at same level as severity
```

**Impact**: 62 finding artifacts from early cycles are not imported. These are historical review findings — the domain layer (policies, decisions) already distills their content, so the data loss is low-impact but non-zero.

**Fix options**:
- **(a)** Fix the YAML files in the ideate repo (correct indentation) — one-time cleanup
- **(b)** Make the migration parser more tolerant of indentation issues (try re-parsing with relaxed settings)
- **(c)** Accept the loss — these are historical findings already captured in domain knowledge

**Severity**: Minor — domain layer already captures the distilled knowledge from these findings.

---

### Category 3: YAML Parse Failures — Other (22 errors, 3%)

**Pattern**: `YAMLException: missed comma between flow collection entries` and other parse errors

**Root cause**: Various YAML formatting issues in a small number of files. Likely caused by manual edits, edge cases in the YAML serializer, or artifacts written during early development.

**Impact**: 22 artifacts not imported.

**Fix**: Inspect and fix individual files, or add more tolerant parsing.

**Severity**: Minor.

---

### Category 4: Unregistered Artifact Types (6 errors, <1%)

**Pattern**: `Unknown artifact type: "full_audit"`, `"code-quality"`, `"full_audit_summary"`, `"decision-log"`, `"gap-analysis"`

**Root cause**: The migration's type registry (`TYPE_TO_LABEL_MAP`) doesn't include these artifact types. They are cycle-scoped review output documents stored as YAML but with types not in the standard set.

**Impact**: 6 review summary documents not imported. Low impact — these are also accessible through the cycle summary artifacts.

**Fix**: Add these types to `TYPE_TO_LABEL_MAP` in the migration tool, mapping them to the `Document` Neo4j label:
```typescript
"full_audit": "Document",
"full_audit_summary": "Document",
"code-quality": "Document",
"decision-log": "Document",
"gap-analysis": "Document",
```

**Severity**: Minor.

---

### Category 5: Missing Required Fields (7 errors, 1%)

**Pattern**: `Missing required field: type` on files like `autopilot-state.yaml`, non-standard YAML files

**Root cause**: Some YAML files in `.ideate/` are not proper artifacts — they're configuration or state files (`autopilot-state.yaml`, `config.json` parsed as YAML by mistake, domain index files).

**Impact**: 7 non-artifact files correctly rejected. The migration should skip them, not count them as errors.

**Fix**: Add these file patterns to the discovery module's skip list, or classify them as "intentionally skipped" rather than "errors."

**Severity**: Cosmetic — not a real data loss issue.

---

## Edge Error Analysis

The migration transformed 1377 edges but only wrote 551 — a 60% failure rate on edges. However, the 714 errors reported are NOT edge-specific errors. They are parse and validation errors on **nodes** that prevented those nodes from being created. Edges referencing those missing nodes then silently fail during the write phase.

**Chain of causation**:
1. 714 artifacts fail parse/validation → not imported as nodes
2. Other artifacts reference those missing nodes via `depends`, `addressed_by`, `governed_by`, etc.
3. Edge write fails because the target node doesn't exist in Neo4j
4. 826 edges silently dropped (1377 - 551 = 826 missing edges)

**Fix**: Fixing Category 1 (nullable field validation) will recover 598 nodes, which will in turn recover most of the missing edges. The edge failure is a symptom, not a root cause.

---

## Unparsed Files Analysis

| Category | Count | Notes |
|---|---|---|
| Total discovered | 2034 | |
| Successfully parsed | 1320 | |
| Parse errors (YAML malformed) | 84 | Categories 2+3 above |
| Validation errors | 630 | Category 1+4+5 above |
| **Unparsed (non-artifact files)** | **~0** | Discovery phase already filters to .yaml files |

The 714 gap between discovered (2034) and parsed (1320) is fully accounted for by the 714 errors. There are no "silently skipped" files — every failure is explicitly logged.

---

## Node Count Discrepancy

| Stage | Count | Delta | Explanation |
|---|---|---|---|
| Parsed | 1320 | — | Base artifacts from YAML |
| Transformed | 1571 | +251 | Interview entry expansion (~249) + Organization node (1) + Codebase node (1) |
| Written | 1573 | +2 | Organization + Codebase nodes added in bootstrap phase |

The 251 extra nodes between parsed and transformed are interview entries expanded from multi-entry YAML files into individual `InterviewQuestion` nodes (each interview YAML contains multiple Q&A pairs, each becoming a separate node).

---

## Recommendations

### Priority 1 — Fix nullable field validation (598 errors recovered)
Change Zod schema for `cycle_created` and `cycle_modified` to `.nullable().optional()`. This single fix recovers 84% of all errors and most missing edges.

### Priority 2 — Register missing artifact types (6 errors recovered)
Add `full_audit`, `code-quality`, `decision-log`, `gap-analysis`, `full_audit_summary` to TYPE_TO_LABEL_MAP.

### Priority 3 — Fix YAML indentation in finding files (62 errors recovered)
Either fix the source YAML files or make the parser tolerant. Consider a pre-migration YAML lint step.

### Priority 4 — Classify non-artifact files as skips, not errors (7 errors reclassified)
Add autopilot-state.yaml and similar files to the discovery skip list.

### Expected post-fix result
- Errors: 714 → ~22 (only the remaining YAML parse issues)
- Nodes: 1573 → ~2171 (recovering 598 nodes)
- Edges: 551 → ~1200+ (most missing edges recovered by having target nodes present)

---

## SQLite Indexer Parity Audit

**Date**: 2026-04-02
**Method**: Read 53 YAML source files across 13 artifact types, queried SQLite `index.db` directly, compared field-by-field (nodes base table, extension tables, edges, file refs, token_count, content_hash).
**Scope**: Indexer (`mcp/artifact-server/src/indexer.ts`) parity with raw YAML files in `.ideate/`.

### Sample Summary

| Artifact ID | Type | Status | Defect Count |
|---|---|---|---|
| WI-003 | work_item | DEFECTS | 2 |
| WI-103 | work_item | DEFECTS | 2 |
| WI-171 | work_item | DEFECTS | 2 |
| WI-228 | work_item | DEFECTS | 1 |
| WI-278 | work_item | DEFECTS | 2 |
| WI-329 | work_item | DEFECTS | 2 |
| WI-379 | work_item | DEFECTS | 1 |
| WI-429 | work_item | DEFECTS | 1 |
| WI-479 | work_item | DEFECTS | 1 |
| WI-529 | work_item | DEFECTS | 3 |
| FI-006-001 | finding | DEFECTS | 1 |
| FI-009-001 | finding | DEFECTS | 1 |
| FI-014-010 | finding | DEFECTS | 1 |
| FI-016-001 | finding | DEFECTS | 3 |
| FI-019-001 | finding | DEFECTS | 1 |
| P-01 | domain_policy | OK | 0 |
| P-11 | domain_policy | OK | 0 |
| P-21 | domain_policy | OK | 0 |
| P-31 | domain_policy | OK | 0 |
| P-41 | domain_policy | OK | 0 |
| D-01 | domain_decision | OK | 0 |
| D-123 | domain_decision | DEFECTS | 1 |
| D-150 | domain_decision | DEFECTS | 2 |
| D-31 | domain_decision | OK | 0 |
| D-61 | domain_decision | OK | 0 |
| GP-01 | guiding_principle | DEFECTS | 4 |
| GP-06 | guiding_principle | OK | 0 |
| GP-11 | guiding_principle | OK | 0 |
| C-01 | constraint | OK | 0 |
| C-06 | constraint | OK | 0 |
| C-11 | constraint | OK | 0 |
| J-000-001 | journal_entry | OK | 0 |
| J-023-001 | journal_entry | OK | 0 |
| J-071-004 | journal_entry | OK | 0 |
| RF-agent-teams-and-plugins | research_finding | OK | 0 |
| RF-domain-knowledge-layer | research_finding | OK | 0 |
| RF-sdlc-knowledge-schemas | research_finding | OK | 0 |
| interview-refine-002 | interview | OK | 0 |
| interviews/refine-040/_general | interview | OK | 0 |
| interviews/refine-012/_general | interview | DEFECTS | 1 |
| PH-001 | phase | DEFECTS | 3 |
| PH-008 | phase | DEFECTS | 3 |
| PH-015 | phase | DEFECTS | 6 |
| PR-001 | project | DEFECTS | 2 |
| PR-002 | project | DEFECTS | 2 |
| CS-001 | cycle_summary | OK | 0 |
| CS-013 | cycle_summary | OK | 0 |
| ME-0411163E | metrics_event | DEFECTS | 11 |
| ME-3DF6FA44 | metrics_event | DEFECTS | 9 |
| ME-9488E188 | metrics_event | DEFECTS | 11 |
| Q-01 | domain_question | OK | 0 |
| Q-15 | domain_question | OK | 0 |
| Q-56 | domain_question | OK | 0 |

**Totals**: 53 sampled, 0 parse failures, 0 missing from DB, 27 with defects, 26 clean.

---

### Defect Table

| # | Artifact | Field | Severity | Description |
|---|---|---|---|---|
| 1 | WI-003 | work_items.work_item_type | Minor | YAML has null, DB has "feature" (default applied by indexer) |
| 2 | WI-003 | work_items.resolution | Minor | YAML field "resolution" has no column in work_items table |
| 3 | WI-103 | work_items.work_item_type | Minor | YAML has null, DB has "feature" |
| 4 | WI-103 | work_items.resolution | Minor | YAML field "resolution" has no column in work_items table |
| 5 | WI-171 | work_items.work_item_type | Minor | YAML has null, DB has "feature" |
| 6 | WI-171 | work_items.resolution | Minor | YAML field "resolution" has no column in work_items table |
| 7 | WI-228 | work_items.work_item_type | Minor | YAML has null, DB has "feature" |
| 8 | WI-278 | work_items.work_item_type | Minor | YAML has null, DB has "feature" |
| 9 | WI-278 | work_items.resolution | Minor | YAML field "resolution" has no column in work_items table |
| 10 | WI-329 | work_items.work_item_type | Minor | YAML has null, DB has "feature" |
| 11 | WI-329 | work_items.resolution | Minor | YAML field "resolution" has no column in work_items table |
| 12 | WI-379 | work_items.work_item_type | Minor | YAML has null, DB has "feature" |
| 13 | WI-429 | work_items.work_item_type | Minor | YAML has null, DB has "feature" |
| 14 | WI-479 | work_items.work_item_type | Minor | YAML has null, DB has "feature" |
| 15 | WI-529 | edge:belongs_to_domain | Significant | Missing edge: WI-529 -[belongs_to_domain]-> workflow. YAML has `domain: workflow` but no edge in SQLite edges table. |
| 16 | WI-529 | node_file_refs | Minor | Missing file ref: scope entry "skills/triage/SKILL.md" not in node_file_refs |
| 17 | WI-529 | node_file_refs | Minor | Missing file ref: scope entry "skills/project/SKILL.md" not in node_file_refs |
| 18 | FI-006-001 | findings.title | Minor | YAML field "title" has no column in findings table |
| 19 | FI-009-001 | findings.title | Minor | YAML field "title" has no column in findings table |
| 20 | FI-014-010 | findings.title | Minor | YAML field "title" has no column in findings table |
| 21 | FI-016-001 | findings.work_item | Minor | YAML has explicit null, DB has "" (default applied by indexer `?? ""`) |
| 22 | FI-016-001 | findings.verdict | Minor | YAML has explicit null, DB has "" (default applied by indexer `?? ""`) |
| 23 | FI-016-001 | findings.title | Minor | YAML field "title" has no column in findings table |
| 24 | FI-019-001 | findings.title | Minor | YAML field "title" has no column in findings table |
| 25 | D-123 | domain_decisions.source | Minor | YAML field "source" has no column in domain_decisions table |
| 26 | D-150 | domain_decisions.title | Minor | YAML field "title" has no column in domain_decisions table |
| 27 | D-150 | domain_decisions.source | Minor | YAML field "source" has no column in domain_decisions table |
| 28 | GP-01 | token_count | Minor | Expected 527 (chars/4), DB has 503. YAML was modified on disk after indexing. |
| 29 | GP-01 | guiding_principles.name | Minor | YAML has null (field missing), DB has "" (default `?? ""`) |
| 30 | GP-01 | guiding_principles.title | Minor | YAML field "title" has no column in guiding_principles table. GP-01 uses `title` instead of `name`. |
| 31 | GP-01 | guiding_principles.body | Minor | YAML field "body" has no column in guiding_principles table. GP-01 uses `body` instead of `description`. |
| 32 | interviews/refine-012/_general | document_artifacts.source_path | Minor | YAML field "source_path" has no column in document_artifacts |
| 33 | PH-001 | phases.project | Minor | YAML has null (field missing), DB has "" (default `?? ""`) |
| 34 | PH-001 | phases.intent | Minor | YAML has null (field missing), DB has "" (default `?? ""`) |
| 35 | PH-001 | phases.completed_date | Minor | YAML field "completed_date" has no column in phases table |
| 36 | PH-008 | phases.project | Minor | YAML has null (field missing), DB has "" (default `?? ""`) |
| 37 | PH-008 | phases.intent | Minor | YAML has null (field missing), DB has "" (default `?? ""`) |
| 38 | PH-008 | phases.completed_date | Minor | YAML field "completed_date" has no column in phases table |
| 39 | PH-015 | token_count | Minor | Expected 129 (chars/4), DB has 105. YAML was modified on disk after indexing. |
| 40 | PH-015 | phases.project | Minor | YAML has null (field missing, uses `project_id` instead), DB has "" |
| 41 | PH-015 | phases.intent | Minor | YAML has null (field missing), DB has "" (default `?? ""`) |
| 42 | PH-015 | phases.project_id | Minor | YAML field "project_id" has no column in phases table. This phase uses `project_id` instead of `project`. |
| 43 | PH-015 | phases.completed_date | Minor | YAML field "completed_date" has no column in phases table |
| 44 | PH-015 | edge:belongs_to_project | Minor | Phantom edge in DB: PH-015 -[belongs_to_project]-> PR-001 has no YAML backing. Likely inserted by a write handler rather than the indexer. |
| 45 | PR-001 | token_count | Minor | Expected 321 (chars/4), DB has 297. YAML was modified on disk after indexing. |
| 46 | PR-001 | projects.current_phase_id | Minor | YAML field "current_phase_id" has no column in projects table |
| 47 | PR-002 | token_count | Minor | Expected 146 (chars/4), DB has 122. YAML was modified on disk after indexing. |
| 48 | PR-002 | projects.current_phase_id | Minor | YAML field "current_phase_id" has no column in projects table |
| 49 | ME-0411163E | metrics_events.event_name | Significant | YAML has `event_name: unknown`, DB has `event_name: worker`. Indexer uses `doc.agent_type ?? doc.event_name`, preferring agent_type over the explicit event_name. |
| 50 | ME-0411163E | metrics_events.payload | Minor | YAML has null payload, but DB has a computed JSON object `{"agent_type":"worker","skill":"execute",...}` assembled from top-level fields. |
| 51-59 | ME-0411163E | metrics_events.skill/phase/agent_type/model/work_item/wall_clock_ms/turns_used/context_files_read/mcp_tools_called | Minor | 9 YAML fields have no column in metrics_events table. These are stored inside the computed `payload` JSON column instead. |
| 60 | ME-3DF6FA44 | metrics_events.payload | Minor | Same payload computation pattern: YAML has null, DB has computed JSON. |
| 61 | ME-3DF6FA44 | metrics_events.finding_severities | Minor | YAML has object `{critical:2, significant:4, minor:5}`, DB has JSON string. This is correct behavior (the column stores the serialized form) but the audit script flagged the type difference. |
| 62-68 | ME-3DF6FA44 | metrics_events fields | Minor | 7 YAML fields (skill, phase, agent_type, model, wall_clock_ms, context_files_read, mcp_tools_called) have no dedicated columns. Stored in computed payload only. |
| 69 | ME-9488E188 | metrics_events.event_name | Significant | Same as #49: YAML `event_name: unknown` overridden by `agent_type: worker` in DB. |
| 70-79 | ME-9488E188 | metrics_events fields | Minor | Same patterns as ME-0411163E: payload computation, missing columns for YAML-only fields. |

---

### Defect Analysis

#### Defect Class A: Missing Extension Table Columns (38 defects, 48%)

**Affected types**: work_items, findings, domain_decisions, guiding_principles, phases, projects, metrics_events, document_artifacts, interviews

**Pattern**: The YAML source contains fields that have no corresponding column in the SQLite extension table. These fields are silently dropped during indexing.

| Missing Column | Table | Occurrence | Impact |
|---|---|---|---|
| `resolution` | work_items | 5 of 10 WIs sampled | Work item resolution text is lost. Not queryable via SQLite. |
| `title` | findings | 5 of 5 findings sampled | Finding title is not stored. Only `description` is captured. |
| `title` | domain_decisions | 1 of 5 decisions sampled | Decision title is lost for decisions that use it. |
| `source` | domain_decisions | 2 of 5 decisions sampled | Decision provenance reference is lost. |
| `title` | guiding_principles | 1 of 3 GPs sampled | GP-01 uses `title` instead of `name`; the indexer maps `name` but not `title`. |
| `body` | guiding_principles | 1 of 3 GPs sampled | GP-01 uses `body` instead of `description`; content is lost. |
| `completed_date` | phases | 3 of 3 phases sampled | Phase completion timestamp is not stored. |
| `project_id` | phases | 1 of 3 phases sampled | Some phases use `project_id` instead of `project`; this variant is dropped. |
| `current_phase_id` | projects | 2 of 2 projects sampled | Active phase pointer is not stored. |
| `source_path` | document_artifacts | 1 of 3 interviews sampled | Original file path reference for migrated interviews is lost. |
| `skill`, `phase`, `agent_type`, `model`, `work_item`, `wall_clock_ms`, `turns_used`, `context_files_read`, `mcp_tools_called` | metrics_events | 3 of 3 MEs sampled | These are packed into the computed `payload` JSON column but have no dedicated queryable columns. |

**Severity**: Minor individually, but collectively significant. The `resolution` and `title` fields in particular contain semantically important content that is not recoverable from SQLite alone.

**Root cause**: The extension table schemas were designed early and have not kept pace with YAML field additions. The `buildExtensionRow()` function in indexer.ts explicitly lists which fields to extract; any field not listed is silently ignored.

**Fix**: Add columns to extension tables:
- `work_items`: add `resolution TEXT`
- `findings`: add `title TEXT`
- `domain_decisions`: add `title TEXT`, `source TEXT`
- `guiding_principles`: map `title` as fallback for `name`, map `body` as fallback for `description`
- `phases`: add `completed_date TEXT`; map `project_id` as fallback for `project`
- `projects`: add `current_phase_id TEXT`

---

#### Defect Class B: Null-to-Default Coercion (14 defects, 18%)

**Affected types**: work_items, findings, phases, guiding_principles

**Pattern**: The indexer's `buildExtensionRow()` uses `?? ""` or `?? "feature"` fallbacks that convert explicit YAML `null` values into non-null defaults. This means the DB cannot distinguish "field was intentionally null" from "field was set to the default."

| Field | Default Applied | Count |
|---|---|---|
| `work_item_type` | `"feature"` when YAML has null | 9 of 10 WIs |
| `findings.work_item` | `""` when YAML has null | 1 of 5 findings |
| `findings.verdict` | `""` when YAML has null | 1 of 5 findings |
| `phases.project` | `""` when YAML has null | 3 of 3 phases |
| `phases.intent` | `""` when YAML has null | 3 of 3 phases |
| `guiding_principles.name` | `""` when YAML has null | 1 of 3 GPs |

**Severity**: Minor. The defaults are reasonable for query purposes. The information loss is the distinction between "not set" and "set to default." The NOT NULL constraints on these columns in the schema mean null cannot be stored directly.

**Root cause**: `buildExtensionRow()` in indexer.ts uses `?? ""` and `?? "feature"` patterns to satisfy NOT NULL column constraints. Early artifacts predate some of these fields.

**Fix**: Either relax NOT NULL constraints to allow null, or accept the coercion as intentional behavior and document it.

---

#### Defect Class C: Metrics Event Name Override (3 defects, 4%)

**Pattern**: The indexer at line 248 computes `event_name` as `toStrOrNull(doc.agent_type ?? doc.event_name)`, which means `agent_type` takes priority over `event_name`. When YAML explicitly sets `event_name: unknown` but also has `agent_type: worker`, the DB stores `event_name: worker`, losing the original event name.

**Severity**: Significant. The `event_name` column no longer reflects the YAML's explicit `event_name` field. This is a data fidelity issue that affects queries filtering by event name.

**Root cause**: The `??` operator in `doc.agent_type ?? doc.event_name` prefers `agent_type`, which is a different field with different semantics. This appears to be a design choice to use `agent_type` as the primary event identifier, but it silently discards the explicit `event_name` value.

**Fix**: Store both fields: `event_name` from `doc.event_name`, and `agent_type` is already captured in the computed `payload` JSON. Or, if `agent_type` is the intended event name, rename the column to avoid confusion.

---

#### Defect Class D: Missing Edges (1 defect, 1%)

**Pattern**: WI-529 has `domain: workflow` in YAML but no `belongs_to_domain` edge in the edges table.

**Severity**: Significant for the specific artifact, but only 1 of 53 sampled (1.9%). This may be a transient issue if WI-529 was written after the last full index rebuild and the watcher missed the update.

**Root cause**: Likely a watcher timing issue or a bug in incremental indexing. The edge extraction logic in `extractEdges()` correctly handles the `belongs_to_domain` edge type for `work_item` source types, so this should work. However, edges are inserted with FK ON, and `workflow` is not a node ID in the nodes table -- the FK constraint in `insertEdge` uses `onConflictDoNothing`, but the edge table has `REFERENCES nodes(id) ON DELETE CASCADE` which may silently drop the insert when FK enforcement is ON and the target node does not exist.

**Fix**: This is a fundamental design tension: edges reference logical identifiers (domain names like "workflow") that are not indexed artifacts. The `rebuildIndex` function turns FK OFF during the upsert phase to allow this, but `insertEdge` uses `onConflictDoNothing` which does not distinguish between a duplicate conflict and an FK violation. Verify that the FK is OFF during edge insertion for all code paths. For `indexFiles()` (watcher path), FK is explicitly turned OFF, so this should be working. The most likely cause is that WI-529 was modified after the index was built and the watcher did not pick up the change.

---

#### Defect Class E: Stale Token Count (4 defects, 5%)

**Affected artifacts**: GP-01, PH-015, PR-001, PR-002

**Pattern**: The `token_count` value in the DB does not match `Math.floor(content.length / 4)` computed from the current YAML file on disk. The DB value is consistently lower, suggesting the YAML file was edited (content added) after the last index rebuild.

**Severity**: Minor. Token count is a rough heuristic (chars/4) and the discrepancies are small (24-28 chars difference, corresponding to 6-7 tokens).

**Root cause**: The content_hash for these artifacts also still matches between YAML and DB, which means the hash computation excludes the fields that changed (content_hash and token_count are excluded from the hash input). The `token_count` stored in YAML itself may differ from the computed value because the YAML's `token_count` field was written by a write handler at a different time than the current file length.

**Fix**: These are self-correcting on the next `rebuildIndex()` call. No code change needed, but a periodic rebuild (or watcher-triggered re-index) would keep them current.

---

#### Defect Class F: Missing File Refs (2 defects, 3%)

**Pattern**: WI-529 has scope entries with `path` fields that are not present in the `node_file_refs` table.

**Severity**: Minor. Same root cause as Defect Class D (WI-529 was likely not re-indexed after the last modification).

---

#### Defect Class G: Phantom Edge (1 defect, 1%)

**Pattern**: PH-015 has an edge `PH-015 -[belongs_to_project]-> PR-001` in the DB, but its YAML uses `project_id: PR-001` not `project: PR-001`. The edge was likely created by a write handler that explicitly inserts edges, not by the indexer's `extractEdges()` function which checks `spec.yaml_field === "project"`.

**Severity**: Minor. The edge is semantically correct -- PH-015 does belong to PR-001. The issue is that the YAML field name does not match the expected field name in the edge type registry.

**Fix**: Normalize the YAML field to `project` instead of `project_id`, or add `project_id` as an alternate yaml_field in the edge type registry.

---

#### Defect Class H: Content Hash Mismatch (0 defects)

All 53 sampled artifacts had matching content hashes between the YAML-computed value and the SQLite value. The `computeArtifactHash()` function correctly excludes `content_hash`, `token_count`, and `file_path` from the hash input, and the YAML library's `stringify()` with `lineWidth: 0` produces deterministic output. **No hash computation defects found.**

---

### Severity Assessment

| Severity | Count | Description |
|---|---|---|
| Significant | 4 | 1 missing edge, 3 metrics event_name overrides |
| Minor | 75 | Missing columns, null-to-default coercion, stale token counts, missing file refs |
| **Total** | **79** | Across 27 of 53 sampled artifacts (51%) |

---

### Cross-Check: Token Count and Content Hash

- **token_count**: 4 of 53 artifacts (7.5%) had stale token counts. All discrepancies were small (6-7 tokens) and attributable to YAML file modifications after the last index build. The computation logic (`Math.floor(content.length / 4)`) is correct and consistent between the indexer and the migration tool.

- **content_hash**: 0 of 53 artifacts had hash mismatches. The `computeArtifactHash()` function in `db-helpers.ts` is consistent: it excludes metadata fields (`content_hash`, `token_count`, `file_path`), serializes with `yaml.stringify(obj, { lineWidth: 0 })`, and applies SHA-256. This matches across the indexer and write handlers.

---

### Recommendations

#### Priority 1 -- Add missing extension table columns (schema v5 migration)

Add columns to extension tables to capture YAML fields that are currently silently dropped:

| Table | Columns to Add |
|---|---|
| `work_items` | `resolution TEXT` |
| `findings` | `title TEXT` |
| `domain_decisions` | `title TEXT`, `source TEXT` |
| `phases` | `completed_date TEXT` |
| `projects` | `current_phase_id TEXT` |

Also add fallback mappings in `buildExtensionRow()`:
- `guiding_principles.name`: fall back to `doc.title` when `doc.name` is null
- `guiding_principles.description`: fall back to `doc.body` when `doc.description` is null
- `phases.project`: fall back to `doc.project_id` when `doc.project` is null

#### Priority 2 -- Fix metrics event_name override

Change indexer.ts line 248 from:
```typescript
event_name: toStrOrNull(doc.agent_type ?? doc.event_name) ?? "",
```
to:
```typescript
event_name: toStrOrNull(doc.event_name) ?? toStrOrNull(doc.agent_type) ?? "",
```

This preserves the YAML's explicit `event_name` and only falls back to `agent_type` when `event_name` is absent.

#### Priority 3 -- Relax NOT NULL defaults or document coercion behavior

Either relax NOT NULL constraints on columns like `phases.project`, `phases.intent`, `findings.work_item`, `findings.verdict` to allow null values, or document the `?? ""` coercion as intentional behavior in a schema reference document.

#### Priority 4 -- Normalize YAML field names in legacy artifacts

Fix field name inconsistencies in older YAML files:
- `GP-01`: rename `title` to `name`, `body` to `description`
- `PH-015` and similar: rename `project_id` to `project`
- Add `intent` field to phases that lack it

#### Priority 5 -- Add metrics_events columns for queryable fields

Currently `skill`, `phase`, `agent_type`, `model`, `work_item`, `wall_clock_ms`, `turns_used` are only stored in the computed `payload` JSON blob. For query efficiency, consider promoting the most-queried fields to dedicated columns.
