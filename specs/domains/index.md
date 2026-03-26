# Domain Registry

current_cycle: 26

## Domains

### workflow
The five-skill SDLC lifecycle (plan, execute, review, refine, brrr), phase sequencing, Andon cord interaction model, continuous review architecture, and brrr convergence loop.
Files: domains/workflow/policies.md, decisions.md, questions.md

### artifact-structure
The artifact directory contract: what files exist, their paths, formats, read/write phase permissions, naming conventions, append-only semantics, and the module spec layer. From cycle 016 onward also covers the v3 `.ideate/` YAML+SQLite storage layer, edge type registry, migration tooling, and watcher/rebuild pipeline. From cycle 022 onward also covers the MCP artifact server tool suite (11 tools), class table inheritance schema (v1), and graph query infrastructure.
Files: domains/artifact-structure/policies.md, decisions.md, questions.md

### agent-system
All eight ideate agents (researcher, architect, decomposer, code-reviewer, spec-reviewer, gap-analyst, journal-keeper, proxy-human), their responsibility boundaries, tool grants, model defaults, invocation patterns, and output contracts.
Files: domains/agent-system/policies.md, decisions.md, questions.md

### project-boundaries
The ideate/outpost architectural separation, what belongs in each project, env var naming conventions, plugin manifest identity, and spec co-location rules.
Files: domains/project-boundaries/policies.md, decisions.md, questions.md

## Cross-Cutting Concerns

**brrr correctness**: Three open questions (Q-1, Q-2, Q-7) and one artifact question (Q-6) collectively describe a cluster of defects that prevent brrr from functioning correctly on a standard ideate installation (no outpost). All four should be addressed together in the next refinement cycle.

**Duplicate work item numbers**: Q-4 (artifact-structure) is a latent defect that affects workflow execution (Q-4 cross-references the execute and brrr skills). Any future `/ideate:execute` or `/ideate:brrr` run encounters ambiguous ordering for five number prefixes.

**brrr review phase architectural gap (cycle 006)**: Q-14 (workflow) and Q-15 (agent-system) were the two highest-priority open questions from cycle 006. Q-15 was resolved in cycle 003 (paths already correct). Q-14 is now resolved in cycle 004: WI-112 added the quality_summary emission block; WI-113 fixed the `skill` field value from `"review"` to `"brrr"` (D-27). Both the structural gap and the field value contradiction are closed.

**metrics.jsonl documentation cluster**: Q-16, Q-17, Q-18 (artifact-structure) are lower-priority carry-forward items from cycle 006 that can be bundled into a single documentation work item alongside structural fixes. D-30 (cycle 004) adds a significant gap: metrics.jsonl itself is absent from artifact-conventions.md. WI-115 addresses D-30; Q-16/Q-17/Q-18 remain open. Cycle 005 adds Q-22 (heading level) and Q-23 (placeholder convention) — both are single-line documentation fixes that belong in the same bundle.

**Suggestion field vestigial cluster (cycle 003)**: Q-19 (agent-system, no producer) and Q-16 (artifact-structure, no consumer) together indicate the `suggestion` sub-field in `by_reviewer` may be vestigial — added for schema symmetry but neither reliably produced nor consumed. These should be evaluated together.

**brrr vs standalone review divergence**: Q-20 (artifact-structure, review-manifest location) and D-19/P-18 (workflow, independent reimplementation) reflect ongoing divergence between the two review paths. Cycle 013 adds Q-36 (agent-system, domain-curator model selection) — brrr unconditionally uses opus while standalone review conditionally selects sonnet/opus. Any future work that touches review orchestration should audit both paths.

**Cross-item spec consistency (cycle 004)**: D-28 and D-29 (artifact-structure) document two bugs caused by independently-planned work items (WI-093 and WI-094) that shared a data contract but described it inconsistently. P-21 (workflow) codifies the mitigation: consumer planning notes must cite the producer's schema definition by file and section.

**Stale agent path references (cycle 005 reopened)**: Q-15 (agent-system) was marked resolved in cycle 003 but cycle 005 code-quality and gap-analysis independently confirmed the stale `reviews/incremental/` paths persist in `agents/spec-reviewer.md` and `agents/gap-analyst.md`. Q-15 is reopened. This should be bundled with Q-22 and Q-23 in the next documentation-fix work item.

**Startup failure protocol consistency (cycles 007-012)**: The startup-failure protocol is fully described in P-22 (amended through cycle 011). The context-appropriate smoke test generalization (D-44/WI-126) extended P-22 to cover library, CLI, e2e, and documentation-only projects. The infrastructure-failure regression-determination protocol is captured in P-23 (D-45/WI-128). Cycle 012 closed the two remaining follow-ups: Q-33 (inline prompt fragments updated by WI-129) and Q-34 (brrr label qualifier added by WI-129). The smoke test generalization is now complete across all locations.

**Smoke test inline prompt inconsistency (cycle 011)**: Resolved in cycle 012. Q-33 and Q-34 both closed by WI-129 (D-48). All inline prompts and labels now use language consistent with the generalized agent definition.

**Model configuration and tier aliases (cycle 013)**: D-49 (project-boundaries) established that custom model configuration belongs in Claude Code env vars, not ideate. D-50 (agent-system) replaced hardcoded model IDs with tier aliases to make env var overrides work. Three open questions remain: Q-35 (README table conflation), Q-36 (brrr unconditional opus), Q-37 (missing CLAUDE_CODE_SUBAGENT_MODEL documentation).

**v3 architecture Phase 1 gaps (cycle 016)**: D-52 through D-56 (artifact-structure) record the Phase 1 foundation decisions. Cycle 016 opened four questions (Q-38 through Q-41). Cycle 017 resolved three: Q-38 (watcher pattern, WI-150), Q-39 (files_failed counter, WI-152), Q-40 (schema migration via user_version, WI-152). Q-41 (migration script scope) resolved in cycle 019: one-time conversion tool, header added by WI-172 (D-81). P-24 (workflow) codifies that async event paths in background services require end-to-end integration tests.

**v3 Phase 1 completion gaps (cycle 017)**: Cycle 017 addressed all 10 planned work items with passing incremental reviews, but all three capstone reviewers issued Fail. Six significant gaps remain in the migration script (D-64 through D-67) and the Drizzle migration (D-64). Twelve new questions (Q-42 through Q-53) track the Phase 1 residual work. Two require user decisions before Phase 2: Q-44 (journal layout authority) and Q-51 (detectCycles criterion scope). P-30 (workflow) codifies the root cause: child work item specs must be cross-checked against parent feature specs for scope completeness.

**Incremental-vs-capstone review divergence pattern**: D-31 (cycle 004) and D-75 (cycle 017) independently demonstrate that incremental reviewers cannot detect cross-item spec completeness gaps. P-21 (cycle 004) and P-30 (cycle 017) provide complementary mitigations: P-21 addresses shared data contracts between producer/consumer pairs; P-30 addresses parent-child spec decomposition completeness.

**v3 Phase 1 residual resolution (cycle 018)**: Cycle 018 resolved 9 of 12 open questions from cycle 017: Q-42 (deleteStaleRows Drizzle, WI-160), Q-43 (finding field extraction, WI-162), Q-45 (remaining archive file types, WI-165/WI-168), Q-46 (plan artifact migration, WI-163), Q-47 (interview migration, WI-164), Q-48 (stale edge type names, WI-166), Q-49 (architecture.md paths, WI-166), Q-50 (CURRENT_SCHEMA_VERSION collision, WI-166/D-79), Q-52 (domainQuestions column, WI-167/D-80). All three capstone reviewers issued Pass. Five significant performance/maintenance findings opened 9 new questions (Q-54 through Q-62). The highest-priority carry-forward is Q-58 (migrate-to-v3.js dual-maintenance, flagged three consecutive times).

**Rebuild pipeline performance cluster (cycle 018)**: Q-54 (watcher debounce), Q-55 (unindexed file_path scans), and Q-57 (O(n^2) BFS) collectively describe a performance degradation pattern that compounds as artifact counts grow. All three resolved in cycle 019: D-84 (500ms debounce, WI-170), D-85 (file-path indexes + pre-created statements, WI-171), D-87 (index-pointer BFS, WI-171).

**Cycle 019 residual — fully resolved in cycle 020**: All five open questions from cycle 019 (Q-63 through Q-67) were closed by four parallel work items (WI-174 through WI-177). Q-63 (build:migration script absent) resolved by WI-174 (D-91). Q-64 (db.ts architecture row) resolved by WI-176. Q-65 (stale 3-arg test call sites) resolved by WI-175. Q-66 (toYaml array-item guard) resolved by WI-175 (D-92). Q-67 (checkSchemaVersion version-0 test) resolved by WI-177. Q-58 (dual-maintenance, carried three cycles) is now fully closed.

**Cycle 021 minor residual cluster**: Three low-severity carry-forwards from incremental reviews. Q-72 (workflow) tracks the intentional-but-undocumented outer-catch swallow in `pretest`. Q-73 (artifact-structure) tracks the version-mismatch test's reliance on `checkSchemaVersion`'s internal db.close() side-effect. Q-74 (artifact-structure) tracks the 11 untested conditions in the array-item quoting guard. All three are latent fragilities or documentation gaps; none require a dedicated refinement cycle.

**Cycle 020 minor residual cluster**: Fully resolved in cycle 021. Q-68 (stale artifacts) resolved by WI-178. Q-69 (toYaml array-item guard) resolved by WI-179. Q-70 (checkSchemaVersion coverage) resolved by WI-180. Q-71 (pretest fail-fast) resolved by WI-178.

**Cycle 022 MCP tool suite — recursive CTE cluster**: Q-75 (cycle protection), Q-76 (ambiguous column), and Q-78 (missing depth > 1 test) all relate to the same recursive CTE in `query.ts`. Q-78 is the root cause — the two significant findings (Q-75, Q-76) survived to capstone review because no test exercises the depth > 1 code path. All three are surgical fixes in a single file; recommended for next refinement cycle. This is the same test coverage gap pattern as D-57/P-24 (cycle 016): untested async/recursive paths survive incremental review.
