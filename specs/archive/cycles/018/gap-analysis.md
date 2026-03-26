# Gap Analysis — Cycles 018 + 019

**Scope**: WI-160 through WI-169. Covers the full project across both cycles: missing interview requirements, unhandled edge cases, incomplete integrations, missing infrastructure, and implicit requirements.

---

## Verdict: Pass

No critical or significant gaps block functionality. Two significant findings identified (II1/MI1 and MR1) — both deferred with documented rationale. Remaining findings are minor with concrete defer rationale.

---

## Missing Requirements from Interview

### MR1: `interview_response` type has no migration producer
- **Interview reference**: refine-017 interview: "Artifact format — YAML everywhere." The type list in WI-144 explicitly includes `InterviewResponse` as a first-class artifact type with its own table and `domain_tag`/`cycle` fields.
- **Current state**: `interview_response` has a full Drizzle table definition (`interviewResponses` in `db.ts`), a DDL block in `createSchema`, a `buildRow` case, a `TYPE_TO_TABLE` entry, and a TypeScript interface in `schema.ts`. The migration script produces `type: "interview"` for all interview files, which maps to `document_artifacts`. No code path produces a record with `type: "interview_response"`.
- **Gap**: The `interview_responses` table will never be populated. The type was designed for structured per-domain interview data with domain and cycle fields, distinct from the holistic document blob stored in `document_artifacts`. The distinction has been collapsed without documentation or a deliberate decision.
- **Severity**: Minor (deferred — the table exists but is a Phase 2+ capability. The current migration correctly handles interview files as document blobs. No data loss occurs; the structured indexing path is simply not yet built.)

### MR2: `detectCycles` limit tests insert 50,001 rows in-process — no injected limit path
- **Interview reference**: refine-018 interview: "detectCycles should add a depth/iteration limit — something like a maximum node or edge count check before running — to prevent runaway processing on large graphs."
- **Current state**: The traversal limit tests at `indexer.test.ts:673–699` exercise both throw paths. The edge-count test inserts `MAX_DEPENDENCY_EDGES + 1` = 50,001 rows via a loop. The incremental review (WI-161) flagged this and suggested mocking or parameterized limits.
- **Gap**: No mechanism exists to inject a smaller limit value for tests. Tests verify correctness at the cost of slow runtime. No exported factory or parameter for limit constants prevents lightweight unit coverage.
- **Severity**: Minor (deferred — test suite runs in under 3 seconds total. Revisit if limits are increased significantly.)

---

## Unhandled Edge Cases

### EC1: `rebuildIndex` cycle detection operates outside the write transaction
- **Component**: `mcp/artifact-server/src/indexer.ts`
- **Scenario**: `rebuildIndex` wraps all YAML parsing, upserting, edge extraction, and stale-row deletion inside a single SQLite transaction. After the transaction commits, `detectCycles(db)` is called as a separate read. Between the commit and the `detectCycles` SELECT, a concurrent file write could trigger another `rebuildIndex` call, meaning cycle detection runs against a state that is already being replaced.
- **Gap**: `cycles_detected` in the stats object may not correspond to the data that was committed in the same rebuild call.
- **Severity**: Minor (deferred — the watcher calls `rebuildIndex` serially in the current implementation, so the race window does not exist in practice.)

### EC2: `toYaml` does not escape strings that start with whitespace
- **Component**: `scripts/migrate-to-v3.ts`
- **Scenario**: The `toYaml` serializer checks for many problematic string prefixes but does not check for strings that start with a space or tab. A description field beginning with whitespace would be written as an unquoted YAML scalar, and the leading whitespace would be silently dropped by parsers.
- **Gap**: Silent data corruption on affected fields.
- **Severity**: Minor (deferred — actual migration content does not start with whitespace. Latent bug that would only manifest with unusual source content.)

### EC3: `migrateArchiveCycles` cycleSeq resets per cycle — potential finding ID collisions
- **Component**: `scripts/migrate-to-v3.ts:1140`
- **Scenario**: `cycleSeq` resets to `0` for each cycle directory. Two review files in the same cycle that produce findings with identical severity prefix and number (e.g., two `C1` findings) would produce the same ID and silently overwrite each other via upsert.
- **Gap**: Finding IDs are not guaranteed unique across review files within a cycle.
- **Severity**: Minor (deferred — in practice, each review file uses its own severity prefix and sequential numbering within the file. Structural collision is prevented by the finding format. Would only occur if two review files independently produced `C1`.)

---

## Incomplete Integrations

### II1: `.js` migration file dual-maintenance is undocumented
- **Interface**: `scripts/migrate-to-v3.ts` / `scripts/migrate-to-v3.js`
- **Gap**: The test file imports from `migrate-to-v3.js`, not the TypeScript source. The `.js` file must be kept manually in sync with the `.ts` source. There is no comment in either file, no `prebuild`/`pretest` script, and no CI step that enforces this. WI-162 M2 and WI-163 M1 incremental reviews both flagged this across two work items. Neither fix was applied. A contributor adding a function to `.ts` without updating `.js` will produce test failures with no explanation of why the `.js` file exists alongside compiled TypeScript.
- **Severity**: Significant (actionable — three consecutive work items touched both files without adding documentation. Minimum fix: a comment at the top of `migrate-to-v3.js` stating it must be kept in sync with the `.ts` source.)

### II2: `migratePlanArtifacts` and `migrateSteeringArtifacts` duplicate `writeOutput` logic inline
- **Interface**: `scripts/migrate-to-v3.ts` write path
- **Gap**: All original migration functions call `writeOutput`, which handles dry-run guards, `mkdirSync`, `writeFileSync`, and `ctx.created.push`. `migratePlanArtifacts` and `migrateSteeringArtifacts` (added in WI-163) duplicate this logic inline in four separate write blocks. The WI-163 incremental review flagged this as M1. Future changes to the write path will not apply to these two functions.
- **Severity**: Minor (deferred — no correctness impact.)

### II3: `migrateSteeringArtifacts` dry-run test does not cover the `guiding-principles.md` branch
- **Gap**: The dry-run test for `migrateSteeringArtifacts` only exercises the `constraints.md` branch. The `guiding-principles.md` branch has no dry-run test coverage.
- **Severity**: Minor (deferred — branches are structurally identical.)

### II4: Legacy `steering/interview.md` migration path has no test
- **Gap**: `migrateInterviews` handles two code paths: (1) legacy `steering/interview.md` → `interviews/legacy.yaml`, and (2) per-cycle files under `steering/interviews/**/*.md`. All three tests cover only path (2). Path (1) has zero test coverage.
- **Severity**: Minor (deferred — legacy path is three lines of straightforward logic.)

---

## Missing Infrastructure

### MI1: No sync mechanism or documentation between `migrate-to-v3.ts` and `migrate-to-v3.js`
- **Category**: Documentation / Build
- **Gap**: The `.js` file is a manually maintained copy. There is no `pretest` script that regenerates it. The `.js` file header has no comment explaining its origin or maintenance requirement. This is the third consecutive work item cycle (WI-162, WI-163, WI-169) to touch both files without adding this documentation.
- **Impact**: Every future contributor who adds to `migrate-to-v3.ts` must independently discover the dual-maintenance requirement through test failures.
- **Severity**: Significant (same root cause as II1 — actionable)

### MI2: No injectable limit mechanism for `detectCycles` traversal limit tests
- **Category**: Testing
- **Gap**: Tests verify the guards work but do so at full scale (50,001 edges). No way to run these tests with smaller injected limits to keep them fast and independent of the constant values.
- **Severity**: Minor (deferred — current tests run in under 3 seconds.)

---

## Implicit Requirements

### IR1: MCP server exposes zero tools — no user-visible explanation
- **Expectation**: A user registering `ideate-artifact-server` as an MCP server would expect to call tools against it.
- **Current state**: `tools.ts` exports `TOOLS = []` and `handleTool` throws `Unknown tool: {name}`. This is intentional per the Phase 1 architecture decision, but there is no README, no MCP server description field, and no `instructions` capability text explaining that tools will be added in Phase 2.
- **Severity**: Minor (deferred — known deliberate Phase 1 state. Address when Phase 2 write tools are implemented.)

### IR2: `extractSection` with empty section body untested
- **Expectation**: `extractSection` should handle a markdown file with a heading followed immediately by another heading (empty body).
- **Current state**: The `scope: ""` assertion for absent sections was added and verified. The regex correctly returns `""` for empty section bodies per analysis, but this specific input shape is not covered by tests.
- **Severity**: Minor (deferred — correctness verified by regex analysis in WI-169 incremental review.)
