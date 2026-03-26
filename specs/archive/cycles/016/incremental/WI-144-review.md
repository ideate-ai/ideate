# WI-144 Incremental Review

**Verdict: Pass** (after fixes)
**Cycle: 17**
**Reviewer: code-reviewer**

## Acceptance Criteria

- [x] All TypeScript interfaces present: WorkItem, Finding, DomainPolicy, DomainDecision, DomainQuestion, GuidingPrinciple, Constraint, ModuleSpec, ResearchFinding, InterviewResponse, JournalEntry, MetricsEvent
- [x] `ArtifactCommon` has all required fields including `token_count` and `file_path`
- [x] `createSchema(db)` creates all typed tables in single transaction
- [x] edges table: `INTEGER PRIMARY KEY AUTOINCREMENT`, `UNIQUE(source_id, target_id, edge_type)`, `idx_edges_source`, `idx_edges_target`
- [x] node_file_refs: `PRIMARY KEY (node_id, file_path)`, `idx_file_refs_path`
- [x] `EDGE_TYPES` const and `EdgeType` union type exported
- [x] `Edge.id` is `number`

## Findings

### S1 (resolved): `edges.id` was `TEXT PRIMARY KEY` instead of `INTEGER PRIMARY KEY AUTOINCREMENT`
Fixed — callers no longer need to supply edge IDs.

### S2 (resolved): `UNIQUE(source_id, target_id, edge_type)` constraint was missing
Fixed — duplicate edges are now rejected at the DB level.

### S3 (resolved): `node_file_refs` missing `PRIMARY KEY (node_id, file_path)`
Fixed — deduplication enforced at DB level.

### M1 (resolved): `ArtifactCommon` missing `token_count` and `file_path`
Both fields added to the shared interface.

### M2 (resolved): Index named `idx_node_file_refs_path` instead of `idx_file_refs_path`
Renamed to match spec.

### M3 (accepted): `idx_edges_composite` redundant with UNIQUE implicit index
Removed the explicit index — UNIQUE constraint creates equivalent implicit index.

### M4 (accepted): `references` edge type undocumented in spec
Intentional addition — kept as a generic reference edge type for future use.
