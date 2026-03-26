# Decision Log — Cycle 019

> Synthesized from: journal.md (last 30 lines), review-manifest.md, code-quality.md, spec-adherence.md, gap-analysis.md.
> This log covers the four work items (WI-170 through WI-173) executed in response to cycle 018 capstone findings.

---

## Decisions Made This Cycle

### D-81: Migration script confirmed as a one-time v2→v3 conversion tool
- **Context**: Q-41 left open from cycle 018 — the script's intended operational model had not been stated.
- **Decision**: `migrate-to-v3.ts` and `migrate-to-v3.js` are one-time tools. Once the v3 `.ideate/` directory is populated, the script is not re-run. JSDoc header added to both files making this explicit (WI-172).
- **Rationale**: A hard cutover. An ongoing utility with idempotency requirements would add maintenance cost not justified by use frequency.
- **Implications**: No idempotency guarantees required. Closes Q-41.
- **Source**: Journal entry 2026-03-24 [refine]; Q-41

### D-82: MCP tools Phase 2 deferred — YAGNI applies
- **Context**: Source-authority question remained open after cycle 018 user decisions. The dev-copy `tools.ts` is a stub.
- **Decision**: Phase 2 MCP tool implementation deferred. Installed plugin version (2.1.0) provides working coverage. No Phase 2 work items until source-authority question is resolved and a concrete SDLC need is identified.
- **Rationale**: YAGNI guiding principle added after cycle 018: only build tools needed for SDLC facilitation, stakeholder reporting, and data collection; nothing dormant without a scoped phase.
- **Implications**: `tools.ts` remains a stub. Q-61 remains open.
- **Source**: Journal entry 2026-03-24 [refine]; cycle 018 user decisions

### D-83: `CURRENT_SCHEMA_VERSION` bumped 5→6 — `interview_responses` table removed
- **Context**: Cycle 018 user decision directed removal of `interview_responses` (dead schema, YAGNI).
- **Decision**: Version incremented 5→6; table DDL, `InterviewResponse` TypeScript interface, union member, and all dispatch entries removed (WI-171). WAL/SHM files deleted on mismatch.
- **Rationale**: `checkSchemaVersion` enforces GP-8 — mismatch triggers delete-and-rebuild from YAML. The bump is the correct signal path.
- **Implications**: Any existing `index.db` at version 5 deleted and rebuilt on next startup. Closes Q-59.
- **Source**: Journal entry 2026-03-24 [execute WI-171]

### D-84: Watcher debounce set at 500ms trailing, encapsulated inside `ArtifactWatcher`
- **Context**: Q-54 — burst writes caused N full rebuilds instead of 1.
- **Decision**: 500ms trailing debounce via `debounceTimers` map and `clearTimeout`/`setTimeout` in `onEvent()`. Configurable via `debounceMs` constructor param (WI-170).
- **Rationale**: Rebuild is idempotent; debounce is safe. 500ms coalesces typical burst writes.
- **Implications**: Closes Q-54. Tests must use `awaitWriteFinish: false` to exercise debounce logic (chokidar's built-in stabilization would otherwise coalesce before `onEvent` is called).
- **Source**: Journal entry 2026-03-24 [execute WI-170]

### D-85: File-path indexes added to all 13 typed tables; hash-check statements pre-created
- **Context**: Q-55 — up to 1,300 unindexed table scans per rebuild.
- **Decision**: `idx_{table}_file_path` indexes on all 13 typed tables. Hash-check prepared statements pre-created before the file loop (WI-171).
- **Implications**: Closes Q-55. File-path lookups converted from O(n) to O(log n).
- **Source**: Journal entry 2026-03-24 [execute WI-171]

### D-86: Drizzle constraint alignment — `primaryKey()` on `nodeFileRefs`, `unique()` on `edges`
- **Context**: Q-56 — Drizzle definitions omitted composite PRIMARY KEY and UNIQUE constraint.
- **Decision**: Constraints added to both Drizzle table definitions (WI-171). Definitions now mirror raw-SQL DDL.
- **Implications**: Closes Q-56. Future Drizzle upgrades that rely on constraint metadata for conflict resolution will behave correctly.
- **Source**: Journal entry 2026-03-24 [execute WI-171]

### D-87: `detectCycles` BFS queues replaced with index-pointer pattern
- **Context**: Q-57 — `Array.shift()` made BFS O(n²) for large graphs.
- **Decision**: `let head = 0; const node = queue[head++]` pattern in both BFS loops (WI-171).
- **Implications**: Closes Q-57. Restores O(n + e) complexity.
- **Source**: Journal entry 2026-03-24 [execute WI-171]

### D-88: `migrate-to-v3.js` staleness detection via `pretest` mtime check — `build:migration` script NOT added
- **Context**: Q-58 — dual-maintenance risk flagged three consecutive cycles.
- **Decision**: `pretest` script added to detect staleness; header comment documents recovery command. The `build:migration` npm script was not added (WI-172).
- **Implications**: Q-58 partially resolved — detection works but recovery path broken. See Q-63 (new open question).
- **Source**: Journal entry 2026-03-24 [execute WI-172]; gap-analysis.md I2

### D-89: `file_path` field set to relative output path in migration finding builder
- **Context**: Q-62 — finding builders emitted `file_path: null`, contradicting `NOT NULL` constraint.
- **Decision**: `file_path: outRelPath` set in both capstone and incremental finding builders in both `.ts` and `.js` (WI-172).
- **Implications**: Closes Q-62.
- **Source**: Journal entry 2026-03-24 [execute WI-172]

### D-90: Architecture source code index regenerated to reflect cycles 017–019 additions
- **Context**: Q-60 — source code index materially stale for `config.ts` and `migrate-to-v3.ts`.
- **Decision**: Index regenerated for five modules. `db.ts` row not updated — see Q-64 (new open question).
- **Implications**: Closes Q-60 partially. `metricsEvents` and `TYPE_TO_DRIZZLE_TABLE` still absent from `db.ts` row.
- **Source**: Journal entry 2026-03-24 [execute WI-173]; spec-adherence.md D1

---

## Questions Resolved This Cycle

- **Q-41**: Migration script scope — resolved: one-time v2→v3 conversion tool. Header added by WI-172.
- **Q-54**: Watcher debounce absent — resolved by WI-170: 500ms trailing debounce in `ArtifactWatcher`.
- **Q-55**: Hash-check loop unindexed scans — resolved by WI-171: 13 file_path indexes + pre-created statements.
- **Q-56**: Drizzle/DDL constraint divergence — resolved by WI-171: `primaryKey()` + `unique()` added.
- **Q-57**: `detectCycles` O(n²) BFS — resolved by WI-171: index-pointer pattern.
- **Q-59**: `interview_response` dead schema — resolved by WI-171: table and all registrations removed.
- **Q-60**: Source code index stale for `config.ts` and `migrate-to-v3.ts` — resolved by WI-173 (partially; `db.ts` row still incomplete, see Q-64).
- **Q-62**: Migration findings emit `file_path: null` — resolved by WI-172: relative output path set.

---

## New Open Questions

- **Q-63**: `build:migration` npm script absent — `migrate-to-v3.js` header and `pretest` warning both reference `npm run build:migration` which does not exist in `package.json`. Contributors following the recovery path hit `npm error Missing script: "build:migration"` immediately. Impact: Q-58's dual-maintenance risk remains unresolved at the recovery path. Source: gap-analysis.md I2.

- **Q-64**: `db.ts` source code index row incomplete — `TYPE_TO_DRIZZLE_TABLE` (exported at `db.ts:235`) and `metricsEvents` (exported at `db.ts:171`) absent from the architecture.md source code index row for `db.ts`. WI-173 updated five other module rows but not `db.ts`. Source: spec-adherence.md D1.

- **Q-65**: Stale 3-argument call sites in migrate tests — `migratePlanArtifacts`, `migrateSteeringArtifacts`, and `migrateInterviews` now accept two parameters; approximately 10 test call sites still pass a third argument silently discarded by JavaScript. Source: spec-adherence.md D2; gap-analysis.md I1.

- **Q-66**: Array-item branch in `toYaml` missing leading-whitespace guard — scalar quoting guard (line 76) has `/^\s/.test(value)` but array-item branch (line 110) does not. String array items with leading whitespace produce unquoted output and invalid YAML. Same gap in `migrate-to-v3.js`. Source: code-quality.md M2.

- **Q-67**: `checkSchemaVersion` version-0 bypass untested; may accept legacy corrupt databases — `user_version = 0` always returns `true` without deletion; intent is correct for fresh SQLite files but no test exercises the path; a pre-cycle-016 database with real tables would also have version 0. Source: code-quality.md M3; gap-analysis.md E1.

---

## Cross-References

### CR5: `toYaml` whitespace guard — scalar path fixed, array-item path missed
- Code-quality M1 (no test for scalar guard) and M2 (array-item path lacks the guard) trace to the same WI-172 change applied to one branch but not both. A single test covering the array-item branch would catch both issues simultaneously.

### CR6: Dual-maintenance recovery path broken — detection added, remedy absent
- Gap-analysis I2 (Significant) and code-quality confirmation that files are currently in sync together show: current state is safe, but the documented process for maintaining it is broken. Detection fires correctly; recovery command fails. Q-63 captures the full impact.

### CR7: `checkSchemaVersion` version-0 path — two reviewers, two angles
- Code-quality M3 (no test coverage) and gap-analysis E1 (semantic edge case for legacy databases) both flag `schema.ts:601`. Together: the code is correct for all current deployments, but the untested path creates regression risk and an unverified assumption about what version-0 means. Q-67 combines both.

### CR8: Architecture index partial update — `db.ts` row still incomplete after WI-173
- Spec-adherence D1 (only reviewer to catch) shows that WI-173's regeneration was applied selectively to modules changed in WI-162 through WI-171 but missed `db.ts`, which was also modified in WI-168 and WI-171. Q-64 captures the residual gap.
