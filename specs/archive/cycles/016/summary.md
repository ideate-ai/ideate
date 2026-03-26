# Review Summary

## Overview

The Phase 1 foundation (`.ideate/` scaffolding, YAML schemas, SQLite rebuild pipeline, migration script, test suite, edge type registry) is structurally sound with 84 passing tests and a clean build. The core indexing loop — walk YAML files, hash-compare, upsert rows, extract edges — is implemented correctly. One critical and two significant issues prevent the system from functioning as specified: the watcher never fires for any files inside `.ideate/`, making live incremental rebuild impossible; the migration script is missing three of its fifteen acceptance criteria; and the server crashes on startup misconfiguration rather than providing a diagnostic.

## Critical Findings

- [code-reviewer] Watcher `ignored` pattern `/(^|[/\\])\../` matches `.ideate/` itself — chokidar suppresses all events; `rebuildIndex` on file change never executes — relates to: WI-145

## Significant Findings

- [code-reviewer] Module-level mutable state in `migrate-to-v3.ts` (`errors`, `created`, `ideateDir`, `sourceDir`, `dryRun`, `force`) is not concurrency-safe — safe today under sequential tests, will corrupt state under parallel vitest workers — relates to: WI-149
- [code-reviewer] `resolveArtifactDir({})` called at module top level in `index.ts:19` with no error handling — misconfigured invocation crashes with a raw stack trace instead of a user-readable message — relates to: WI-143
- [code-reviewer] `upsertRow` interpolates `Object.keys(row)` directly into SQL without key validation — currently safe because all callers go through `buildRow`, but latent injection risk if a future caller passes attacker-influenced keys — relates to: WI-145
- [spec-reviewer] Migration script omits three declared conversion steps: archive cycle markdown, `journal.md`, and `metrics.jsonl` — three of fifteen WI-146 acceptance criteria are unmet — relates to: WI-146
- [spec-reviewer] Watcher `ignored` pattern excludes all hidden directories; WI-145 criterion "watcher.ts triggers incremental rebuild on YAML file changes in .ideate/" is functionally unmet — relates to: WI-145
- [gap-analyst] Migration script omits journal, archive cycle, and metrics steps — running migration produces an incomplete `.ideate/` directory missing all historical data — relates to: WI-146
- [gap-analyst] Watcher never fires for `.ideate/` changes — incremental rebuild is absent at runtime — relates to: WI-145

## Minor Findings

- [code-reviewer] `deleteStaleRows` issues three `DELETE` statements per stale row rather than batching — relates to: WI-145
- [code-reviewer] `walkDir` swallows `readdirSync` errors silently — callers receive `files_scanned: 0` with no diagnostic — relates to: WI-145
- [code-reviewer] `persistent: false` in watcher config — in any context without other event-loop refs, process may exit before watch events fire — relates to: WI-145
- [code-reviewer] Journal entry hashing in migration script duplicates `buildArtifact` logic inline rather than calling it — relates to: WI-146
- [code-reviewer] No integration test for watcher triggering a reindex — the watcher bug (C1) would have been caught by such a test — cross-cutting
- [spec-reviewer] `idx_edges_composite(source_id, target_id, edge_type)` absent as named index; implicit UNIQUE index satisfies functional purpose but the WI-144 criterion is technically unmet — relates to: WI-144
- [spec-reviewer] `belongs_to_domain` `source_types` includes `work_item` — undocumented in `specs/plan/notes/148.md` — relates to: WI-148
- [spec-reviewer] WI-149 scope entry in `work-items.yaml` lists `scripts/migrate-to-v3.test.ts`; actual file is `mcp/artifact-server/src/__tests__/migrate.test.ts` — relates to: WI-149
- [gap-analyst] No error signal when YAML files fail to parse — `RebuildStats` has no `files_failed` field — relates to: WI-145
- [gap-analyst] No artifact ID uniqueness check — duplicate manually-assigned IDs silently overwrite each other during upsert — cross-cutting
- [gap-analyst] No schema upgrade path for existing `index.db` when DDL changes in future cycles — relates to: WI-144
- [gap-analyst] `addresses` and `amends` edge types have `yaml_field: null` and no extraction path — they cannot appear in the live database from YAML content alone — relates to: WI-148
- [gap-analyst] No recovery if `rebuildIndex` fails at startup — server crashes rather than falling back to empty-index mode — relates to: WI-145

## Suggestions

- [code-reviewer] Replace `persistent: false` with `persistent: true` or add a comment explaining the intent
- [gap-analyst] Add a `files_failed` counter to `RebuildStats` and log parse errors at warn level

## Findings Requiring User Input

- **`upsertRow` SQL injection risk (code-reviewer S3)**: The current call path is safe. The question is whether this should be hardened now (add key validation guard) or deferred to Phase 2 when external data may flow through this path. Impact of deferring: low risk today, higher risk once MCP write tools are added. Impact of addressing now: small, self-contained fix.

- **`addresses` and `amends` edges (gap-analyst G6)**: These edge types are defined in the registry but produce no edges from YAML. Acceptable if Phase 2 will add explicit write tools. If there is no Phase 2 plan for these, they should either be removed from the registry or documented as "write-only via API." No architectural decision is blocking — this is a documentation/intent question.

## Proposed Refinement Plan

The review identified 1 critical and 6 significant findings. A targeted refinement cycle is recommended to address them before Phase 2 tool implementation begins.

**Scope for `/ideate:refine`:**

1. **Fix watcher ignored pattern** (`watcher.ts:24`) — change `/(^|[/\\])\../` to exclude only `index.db*` files; add integration test for watcher → rebuild path. This is a one-line fix with a test.

2. **Complete migration script** (`scripts/migrate-to-v3.ts`) — implement `migrateJournal` (converts `journal.md` entries to YAML `journal_entry` documents), `migrateArchiveCycles` (converts `archive/cycles/{NNN}/*.md`), and metrics copy. Update WI-146 criteria in `work-items.yaml` to reflect the actual test file path for WI-149.

3. **Fix module-level state in migration script** — move six module-globals inside `runMigration` and thread them as parameters to helpers. This makes the script safe for parallel test execution.

4. **Add startup error handling** (`index.ts`) — wrap `resolveArtifactDir` and `rebuildIndex` in try/catch with a clean exit message.

5. **Documentation cleanup** — update `specs/plan/notes/148.md` to document `work_item` as a source type for `belongs_to_domain`; update WI-149 scope entry; decide fate of `addresses`/`amends` edges.

Estimated scope: 4–6 work items, medium complexity. Items 1 and 3 are independent. Item 2 is the largest. Items 4 and 5 are small.
