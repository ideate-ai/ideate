# WI-146 Incremental Review

**Verdict: Pass** (after fixes)
**Cycle: 17**
**Reviewer: code-reviewer**

## Acceptance Criteria

- [x] `scripts/migrate-to-v3.ts` exists
- [x] `scripts/migrate-to-v3.sh` exists — shell wrapper
- [x] CLI: `<source-specs-dir> <target-ideate-dir> [--dry-run] [--force]`
- [x] Migrates: guiding-principles, constraints, work-items, domain policies/decisions/questions, research, journal, config.json
- [x] Dry-run mode: prints what would be created without writing
- [x] Error handling: warnings for unparseable sections, aborts if target exists without --force
- [x] Output YAML includes content_hash (SHA-256 over sorted canonical JSON) and token_count
- [x] Work item migration merges notes from plan/notes/{id}.md if present

## Findings

### C1 (resolved): Content hash computed over YAML serialization (unstable)
Fixed — hash now computed over sorted canonical JSON, stable against serializer changes.

### S1 (resolved): YAML serializer emitted invalid syntax for multi-key objects in arrays
Fixed — flow mapping syntax `{key: val, k2: v2}` now used for array element objects.

### S3 (resolved): Multi-line criteria lines were truncated
Fixed — continuation lines are now collected and merged into the preceding criterion.

### S5 (resolved): Dead `sectionRegex` variable in migrateJournal
Removed.

### M2 (resolved): Flow array parsing broke for unquoted YAML values
Fixed — `parseYamlFlowArray()` helper handles both quoted and unquoted formats.

### M3 (resolved): Journal entries missing content_hash and token_count
Fixed — journal entries now include both fields.

### S4 (accepted): Archive cycles, interviews, metrics.jsonl not migrated
These are not in the AC text. Deferred as future scope.
