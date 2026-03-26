# Audit Findings: LLM Artifact Skills and Agents vs Updated Principles

**Audit date**: 2026-03-25
**Scope**: All 8 skill files, all 9 agent files
**Audited against**: GP-8, GP-13, P-6, P-8, P-10, P-14, P-19, P-26, P-32, and related policies

---

## Must-Fix Findings

### MF-1: `skills/plan/SKILL.md` — creates pre-v3 directory structure and manifest.json instead of .ideate/

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: 29-51
**Current text**: Phase 1.1 creates `{artifact-dir}/manifest.json` with `{"schema_version": 1}` and a directory tree including `archive/incremental/`, `domains/`, `steering/`, `plan/` as top-level directories under the user-chosen artifact directory.
**Violation**: P-19 (canonical .ideate/ paths), P-17 (config.json not manifest.json), P-25 (all artifacts are YAML), P-6 (artifact directory is .ideate/)
**Required change**: The plan skill should scaffold the `.ideate/` directory structure per the v3 architecture. `manifest.json` should be `.ideate/config.json`. The directory tree should reflect the v3 layout with `.ideate/cycles/`, `.ideate/work-items/`, etc. The entire Phase 1.1 directory scaffolding section needs rewriting to match v3 structure. Note: this is a large change that depends on the MCP artifact server's actual schema expectations. May warrant its own work item.

---

### MF-2: `skills/plan/SKILL.md` — writes markdown artifacts instead of YAML

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: 225-289 (Phase 3), 293-349 (Phase 4), 393-417 (work item format), 539-578 (Phase 7)
**Current text**: Plan skill instructs writing `steering/interview.md`, `steering/guiding-principles.md`, `steering/constraints.md` as markdown files. Work item notes are `plan/notes/NNN.md`. Domain files are `domains/{name}/policies.md`, `decisions.md`, `questions.md` as markdown.
**Violation**: P-25 (all machine-actionable artifacts are YAML), P-6 (accessed exclusively through MCP tools)
**Required change**: All machine-actionable artifacts should be written as YAML files through MCP tools. Human-readable output is generated on demand, not stored. The plan skill should call MCP write tools to create work items, principles, constraints, etc. as YAML. This is a sweeping change affecting nearly every phase of the plan skill.

---

### MF-3: `skills/plan/SKILL.md` — no MCP tool usage for artifact creation

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: entire file
**Current text**: The plan skill directly creates files using Write tool throughout. No MCP availability checks. No MCP tool calls for any artifact operations.
**Violation**: P-6 (MCP server is mandatory interface), P-26 (skills do not read/write YAML directly), P-32 (ideate artifact server is always present)
**Required change**: Plan skill must use MCP tools exclusively for artifact creation. Since the ideate artifact server is always present (P-32), the skill should call MCP tools directly without availability checks for ideate tools.

---

### MF-4: `skills/execute/SKILL.md` — MCP availability check with fallback for `ideate_get_work_item_context`

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 190-195
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_work_item_context`... If found: call it... If not found, read files manually:
```
**Violation**: P-32 (ideate artifact server is always present — no availability checks), P-6 (MCP is mandatory interface)
**Required change**: Remove the availability check and fallback. Call `ideate_get_work_item_context` directly. Remove the "If not found, read files manually" block (lines 196-208).

---

### MF-5: `skills/execute/SKILL.md` — MCP availability check with fallback for `ideate_get_execution_status`

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 79-94
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_execution_status`... If found... If not found, build `completed_items` manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_execution_status` directly. Remove manual fallback.

---

### MF-6: `skills/execute/SKILL.md` — MCP availability check with fallback for `ideate_append_journal`

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 482-487
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_append_journal`... If found... If not found, append manually to `journal.md`:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_append_journal` directly. Remove manual fallback.

---

### MF-7: `skills/execute/SKILL.md` — MCP availability check with fallback for `ideate_get_project_status`

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 518-522
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_project_status`... If found... If not found, aggregate status manually...
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_project_status` directly. Remove manual fallback.

---

### MF-8: `skills/execute/SKILL.md` — direct file writes to `archive/incremental/` and `journal.md`

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 338 (review output path), 480-506 (journal updates)
**Current text**: Writes review results to `archive/incremental/NNN-{name}.md` directly. Journal append uses manual file write as fallback.
**Violation**: P-6 (MCP is mandatory interface), P-19 (canonical .ideate/ paths — should be `.ideate/cycles/{NNN}/findings/`)
**Required change**: Use MCP tools for all artifact writes. Review output path should use v3 canonical paths.

---

### MF-9: `skills/execute/SKILL.md` — references `archive/incremental/` path instead of v3 canonical path

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 86, 338, 609
**Current text**: References `archive/incremental/*.md` for review files.
**Violation**: P-19 (canonical .ideate/ paths — should be `.ideate/cycles/{NNN}/findings/`)
**Required change**: Update all `archive/incremental/` references to `.ideate/cycles/{NNN}/findings/` per v3 architecture.

---

### MF-10: `skills/review/SKILL.md` — MCP availability check with fallback for `ideate_get_review_manifest`

**File**: `/Users/dan/code/ideate/skills/review/SKILL.md`
**Lines**: 143-146
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_review_manifest`... If found... If not found, build the manifest manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_review_manifest` directly. Remove manual fallback.

---

### MF-11: `skills/review/SKILL.md` — MCP availability check with fallback for `ideate_get_context_package`

**File**: `/Users/dan/code/ideate/skills/review/SKILL.md`
**Lines**: 177-180
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_context_package`... If found... If not found, assemble inline:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_context_package` directly. Remove manual fallback.

---

### MF-12: `skills/review/SKILL.md` — MCP availability check with fallback for `ideate_append_journal`

**File**: `/Users/dan/code/ideate/skills/review/SKILL.md`
**Lines**: 583-587
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_append_journal`... If found... If not found, append manually to `journal.md`:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_append_journal` directly. Remove manual fallback.

---

### MF-13: `skills/review/SKILL.md` — MCP availability check with fallback for `ideate_archive_cycle`

**File**: `/Users/dan/code/ideate/skills/review/SKILL.md`
**Lines**: 485-489
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_archive_cycle`... If found... If not found, archive manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_archive_cycle` directly. Remove manual fallback.

---

### MF-14: `skills/review/SKILL.md` — MCP availability check with fallback for `ideate_artifact_query`

**File**: `/Users/dan/code/ideate/skills/review/SKILL.md`
**Lines**: 120
**Current text**:
```
...look in your tool list for a tool whose name ends in `ideate_artifact_query`... If found, you may use it...
```
**Violation**: P-32 (ideate tools are always present — no need for availability check)
**Required change**: Remove the availability check framing. State that `ideate_artifact_query` is available for ad-hoc queries directly.

---

### MF-15: `skills/refine/SKILL.md` — MCP availability check with fallback for `ideate_get_context_package`

**File**: `/Users/dan/code/ideate/skills/refine/SKILL.md`
**Lines**: 52-55
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_context_package`... If found... If not found, read all existing artifacts:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_context_package` directly. Remove manual fallback.

---

### MF-16: `skills/refine/SKILL.md` — MCP availability check with fallback for `ideate_get_domain_state`

**File**: `/Users/dan/code/ideate/skills/refine/SKILL.md`
**Lines**: 71-74
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_domain_state`... If found... If not found, load the domain layer manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_domain_state` directly. Remove manual fallback.

---

### MF-17: `skills/refine/SKILL.md` — MCP availability check with fallback for `ideate_write_work_items`

**File**: `/Users/dan/code/ideate/skills/refine/SKILL.md`
**Lines**: 297-303
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_write_work_items`... If found... If not found, write manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_write_work_items` directly. Remove manual fallback.

---

### MF-18: `skills/refine/SKILL.md` — MCP availability check with fallback for `ideate_append_journal`

**File**: `/Users/dan/code/ideate/skills/refine/SKILL.md`
**Lines**: 335-339
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_append_journal`... If found... If not found, append manually to `journal.md`:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_append_journal` directly. Remove manual fallback.

---

### MF-19: `skills/refine/SKILL.md` — direct file reads of artifact directory contents

**File**: `/Users/dan/code/ideate/skills/refine/SKILL.md`
**Lines**: 56-101 (Phase 3 context loading)
**Current text**: Phase 3 loads artifacts by directly reading files: `steering/guiding-principles.md`, `steering/constraints.md`, `plan/overview.md`, etc.
**Violation**: P-6 (MCP is mandatory interface), P-26 (skills do not read YAML files directly)
**Required change**: All artifact reads should go through MCP tools. The `ideate_get_context_package` call already covers some of this, but the remaining manual file reads (steps 4-10, 11-14) should also use MCP tools.

---

### MF-20: `skills/brrr/SKILL.md` — MCP availability check with fallback for `ideate_get_convergence_status`

**File**: `/Users/dan/code/ideate/skills/brrr/SKILL.md`
**Lines**: 183-186
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_convergence_status`... If found... If not found, evaluate convergence manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_convergence_status` directly. Remove manual fallback.

---

### MF-21: `skills/brrr/phases/execute.md` — MCP availability check with fallback for `ideate_get_work_item_context`

**File**: `/Users/dan/code/ideate/skills/brrr/phases/execute.md`
**Lines**: 35-40
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_work_item_context`... If found... If not found, read files manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_work_item_context` directly. Remove manual fallback.

---

### MF-22: `skills/brrr/phases/execute.md` — MCP availability check with fallback for `ideate_get_execution_status`

**File**: `/Users/dan/code/ideate/skills/brrr/phases/execute.md`
**Lines**: 81
**Current text**:
```
**MCP availability check (execution status)**: If the `{completed_items}` set needs to be refreshed mid-cycle... look in your tool list for a tool whose name ends in `ideate_get_execution_status`... If found, call it...
```
**Violation**: P-32, P-6
**Required change**: Remove availability check framing. Call `ideate_get_execution_status` directly.

---

### MF-23: `skills/brrr/phases/execute.md` — MCP availability check with fallback for `ideate_append_journal`

**File**: `/Users/dan/code/ideate/skills/brrr/phases/execute.md`
**Lines**: 219-223
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_append_journal`... If found... If not found, append manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_append_journal` directly. Remove manual fallback.

---

### MF-24: `skills/brrr/phases/review.md` — MCP availability check with fallback for `ideate_get_context_package`

**File**: `/Users/dan/code/ideate/skills/brrr/phases/review.md`
**Lines**: 21-24
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_context_package`... If found... If not found, assemble inline:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_context_package` directly. Remove manual fallback.

---

### MF-25: `skills/brrr/phases/review.md` — MCP availability check with fallback for `ideate_get_review_manifest`

**File**: `/Users/dan/code/ideate/skills/brrr/phases/review.md`
**Lines**: 66-69
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_get_review_manifest`... If found... If not found, build the manifest manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_get_review_manifest` directly. Remove manual fallback.

---

### MF-26: `skills/brrr/phases/review.md` — MCP availability check with fallback for `ideate_archive_cycle`

**File**: `/Users/dan/code/ideate/skills/brrr/phases/review.md`
**Lines**: 268-272
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_archive_cycle`... If found... If not found, skip this step...
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_archive_cycle` directly. The "skip" fallback is no longer valid.

---

### MF-27: `skills/brrr/phases/review.md` — MCP availability check with fallback for `ideate_append_journal`

**File**: `/Users/dan/code/ideate/skills/brrr/phases/review.md`
**Lines**: 278-282
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_append_journal`... If found... If not found, append manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_append_journal` directly. Remove manual fallback.

---

### MF-28: `skills/brrr/phases/refine.md` — MCP availability check with fallback for `ideate_write_work_items`

**File**: `/Users/dan/code/ideate/skills/brrr/phases/refine.md`
**Lines**: 23-26
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_write_work_items`... If found... If not found, create manually:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_write_work_items` directly. Remove manual fallback.

---

### MF-29: `skills/brrr/phases/refine.md` — MCP availability check with fallback for `ideate_append_journal`

**File**: `/Users/dan/code/ideate/skills/brrr/phases/refine.md`
**Lines**: 36-40
**Current text**:
```
**MCP availability check**: Look in your tool list for a tool whose name ends in `ideate_append_journal`... If found... If not found, write a refinement summary manually to `{artifact_dir}/journal.md`:
```
**Violation**: P-32, P-6
**Required change**: Remove availability check. Call `ideate_append_journal` directly. Remove manual fallback.

---

### MF-30: `skills/plan/SKILL.md` — acceptance criteria rules say "avoid criteria requiring human judgment"

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: 420-431
**Current text**:
```
### Acceptance Criteria Rules

**Prefer machine-verifiable criteria:**
...
**Avoid criteria requiring human judgment:** "readable", "intuitive"...
If you find yourself writing such a criterion, it signals an unresolved design decision in the spec. Go back and resolve it.
...
**When machine verification is genuinely impossible** (e.g., prose quality in documentation), state the criterion as precisely as possible and note that it requires human review. This should be rare.
```
**Violation**: GP-13 (Appropriate Validation Strategy), P-8 (acceptance criteria use the most appropriate validation method)
**Required change**: Rewrite the acceptance criteria rules to reflect the updated validation strategy. Rather than "avoid criteria requiring human judgment," the skill should instruct: identify which criteria are objectively measurable (use machine verification) vs inherently subjective (use human-in-the-loop verification). Each criterion must have an explicit validation method. The "this should be rare" framing should be removed — human-in-the-loop is a first-class validation method, not an exception.

---

### MF-31: `agents/decomposer.md` — acceptance criteria rules say "avoid criteria that require human judgment"

**File**: `/Users/dan/code/ideate/agents/decomposer.md`
**Lines**: 97-108
**Current text**:
```
Avoid criteria that require human judgment: "readable", "intuitive", "well-structured", "appropriate". If you find yourself writing such a criterion, it signals an unresolved design decision. Resolve it by specifying what "well-structured" concretely means in this context.

When machine verification is genuinely impossible (e.g., prose quality in documentation), state the criterion as precisely as possible and note that it requires human review.
```
**Violation**: GP-13, P-8
**Required change**: Same as MF-30. Rewrite to recognize human-in-the-loop as a first-class validation method. Each criterion should state its validation method explicitly. Remove the framing that subjective criteria are always resolvable to machine-verifiable ones.

---

### MF-32: `skills/plan/SKILL.md` — references "outpost" for session spawning

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: 148
**Current text**:
```
Use the Agent tool to spawn a subagent with the researcher agent prompt, or use `spawn_session` if outpost is configured.
```
**Violation**: P-14 (outpost references should be generalized to "external MCP servers")
**Required change**: Replace "if outpost is configured" with "if an external session orchestration MCP server is available". The `spawn_session` tool reference should be framed as an external capability check, not an outpost-specific one. This is an external tool — keep the availability check pattern per P-32.

---

### MF-33: `skills/execute/SKILL.md` — references "outpost" for session spawning

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 306-308
**Current text**:
```
If the Agent tool is not available but the session-spawner MCP server (from outpost) is configured, fall back to `spawn_session`.
```
**Violation**: P-14 (outpost references should be generalized)
**Required change**: Replace "(from outpost)" with generic "external session orchestration MCP server" framing. Keep the availability check since this is an external tool.

---

### MF-34: `skills/review/SKILL.md` — references "outpost" for session spawning

**File**: `/Users/dan/code/ideate/skills/review/SKILL.md`
**Lines**: 203
**Current text**:
```
If the outpost MCP server is configured, `spawn_session` may be used as an alternative.
```
**Violation**: P-14
**Required change**: Replace "outpost MCP server" with "an external session orchestration MCP server".

---

## Should-Fix Findings

### SF-1: `skills/execute/SKILL.md` — Phase 2 reads artifacts directly without MCP

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 49-65 (Phase 2)
**Current text**: Phase 2 reads all plan artifacts by directly reading files: `plan/execution-strategy.md`, `plan/overview.md`, `plan/architecture.md`, etc.
**Inconsistency**: P-6 mandates MCP as the exclusive interface. While the execute skill uses MCP for some operations, Phase 2 loads everything via direct file reads.
**Recommended change**: Replace direct file reads with appropriate MCP tool calls (e.g., `ideate_get_context_package` for architecture/principles/constraints, `ideate_get_work_item_context` for individual work items).

---

### SF-2: `skills/execute/SKILL.md` — writes to `archive/incremental/` (pre-v3 path) via direct file write

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 338
**Current text**: `Write the review result to archive/incremental/NNN-{name}.md`
**Inconsistency**: P-19 specifies canonical paths under `.ideate/`. Reviews should be written to `.ideate/cycles/{NNN}/findings/` and written through MCP tools.
**Recommended change**: Use MCP tool to write findings to canonical v3 path.

---

### SF-3: `skills/brrr/phases/execute.md` — writes to `archive/incremental/` (pre-v3 path)

**File**: `/Users/dan/code/ideate/skills/brrr/phases/execute.md`
**Lines**: 117, 245, 253
**Current text**: Multiple references to writing review results to `{artifact_dir}/archive/incremental/NNN-{name}.md`.
**Inconsistency**: P-19 canonical paths.
**Recommended change**: Same as SF-2.

---

### SF-4: `skills/brrr/phases/review.md` — references `archive/incremental/` path

**File**: `/Users/dan/code/ideate/skills/brrr/phases/review.md`
**Lines**: 68, 72-73, 77, 306, 318
**Current text**: Multiple references to `archive/incremental/` for review manifest generation and file operations.
**Inconsistency**: P-19 canonical paths.
**Recommended change**: Update to v3 canonical paths.

---

### SF-5: `skills/review/SKILL.md` — references `archive/incremental/` and `reviews/incremental/` paths

**File**: `/Users/dan/code/ideate/skills/review/SKILL.md`
**Lines**: 73-74, 80, 153, 489-507, 720-721
**Current text**: Multiple references to `archive/incremental/` and legacy `reviews/incremental/` paths.
**Inconsistency**: P-19 canonical paths.
**Recommended change**: Update to v3 canonical paths. The legacy `reviews/incremental/` fallback can remain as a compatibility path but should be documented as deprecated.

---

### SF-6: `skills/brrr/SKILL.md` — builds completed items set from `archive/incremental/` directly

**File**: `/Users/dan/code/ideate/skills/brrr/SKILL.md`
**Lines**: 74-78 (Phase 3)
**Current text**: Manually globs `{artifact_dir}/archive/incremental/*.md` and reads verdict lines to build completed items set.
**Inconsistency**: P-6 (should use MCP tools), P-19 (pre-v3 path)
**Recommended change**: Use MCP tool (e.g., `ideate_get_execution_status`) to get completed items set.

---

### SF-7: `skills/refine/SKILL.md` — reads artifacts directly in Phase 3 even after MCP call

**File**: `/Users/dan/code/ideate/skills/refine/SKILL.md`
**Lines**: 56-101
**Current text**: After the MCP `ideate_get_context_package` call (which covers steps 1-3), the skill still directly reads files for steps 4-10 and 11-14.
**Inconsistency**: P-6 mandates MCP as exclusive interface for all artifact access.
**Recommended change**: Use MCP tools for remaining artifact reads. The domain layer load (steps 11-13) already has an MCP check for `ideate_get_domain_state`, but the intermediate steps (4-10) do not.

---

### SF-8: `agents/gap-analyst.md` — references `archive/incremental/` path

**File**: `/Users/dan/code/ideate/agents/gap-analyst.md`
**Lines**: 24-25
**Current text**:
```
- Any incremental reviews from `archive/incremental/`
```
**Inconsistency**: P-19 canonical paths.
**Recommended change**: Update to reference `.ideate/cycles/{NNN}/findings/` or note that the skill provides this context (agent should not reference specific paths if it receives context from the skill).

---

### SF-9: `agents/spec-reviewer.md` — references `archive/incremental/` path

**File**: `/Users/dan/code/ideate/agents/spec-reviewer.md`
**Lines**: 26-27
**Current text**:
```
You may also receive incremental review results from `archive/incremental/`.
```
**Inconsistency**: P-19 canonical paths.
**Recommended change**: Update to v3 canonical path or generalize to "incremental review results provided by the invoking skill."

---

### SF-10: `agents/journal-keeper.md` — references `archive/incremental/` path

**File**: `/Users/dan/code/ideate/agents/journal-keeper.md`
**Lines**: 20-21
**Current text**:
```
- The review manifest at `archive/incremental/review-manifest.md` (individual incremental review files at `archive/incremental/` are available...)
```
**Inconsistency**: P-19 canonical paths.
**Recommended change**: Update to v3 canonical paths.

---

### SF-11: `skills/plan/SKILL.md` — Acceptance Criteria section also says "Do not produce vague acceptance criteria"

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: 810
**Current text**:
```
- You do not produce vague acceptance criteria. If you cannot make a criterion machine-verifiable, you resolve the underlying ambiguity first.
```
**Inconsistency**: GP-13, P-8 — not all criteria need to be machine-verifiable. Some should use human-in-the-loop.
**Recommended change**: Change to: "You do not produce vague acceptance criteria. Every criterion has an explicit validation method — machine verification for objective criteria, human-in-the-loop for subjective criteria."

---

### SF-12: `skills/plan/SKILL.md` — "Spec Sufficiency Heuristic" lists "Acceptance criteria that require subjective judgment" as a failure

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: 466-470
**Current text**:
```
Check for:
- Ambiguous terms...
- Acceptance criteria that require subjective judgment
```
**Inconsistency**: GP-13, P-8 — subjective criteria are valid when paired with human-in-the-loop validation.
**Recommended change**: Change to: "Acceptance criteria that require subjective judgment without a stated validation method" — the issue is missing validation method, not subjectivity itself.

---

### SF-13: `agents/domain-curator.md` — references `ideate_artifact_semantic_search` with availability check

**File**: `/Users/dan/code/ideate/agents/domain-curator.md`
**Lines**: 131
**Current text**:
```
If the MCP tool `ideate_artifact_semantic_search` is available in your tool list: call it...
```
**Inconsistency**: P-32 says ideate tools are always present. However, semantic search may legitimately not be available if embeddings are not configured. This is a borderline case.
**Recommended change**: Clarify whether `ideate_artifact_semantic_search` is always available or conditionally available. If always available, remove the check. If conditionally available (depends on embedding model configuration), keep the check but reframe it as a capability check rather than an MCP availability check.

---

### SF-14: `skills/plan/SKILL.md` — domain files created as markdown, not YAML

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: 647-708 (Phase 8.3-8.4)
**Current text**: Creates `domains/{name}/policies.md`, `decisions.md`, `questions.md` as markdown files. Creates `domains/index.md` as markdown.
**Inconsistency**: P-25 (all machine-actionable artifacts are YAML).
**Recommended change**: Domain files should be YAML artifacts written through MCP tools.

---

### SF-15: `skills/plan/SKILL.md` — `journal.md` written as markdown

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: 557-564, 712-720
**Current text**: Creates and appends to `journal.md` as a markdown file.
**Inconsistency**: P-25 (YAML), P-7 (journal entries are write-once YAML files in `.ideate/cycles/{NNN}/journal/`).
**Recommended change**: Use MCP tools to write journal entries as YAML. The plan skill should call `ideate_append_journal` or equivalent.

---

### SF-16: `skills/execute/SKILL.md` — Phase 2 reads `plan/work-items.yaml` directly

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 57-63
**Current text**: Reads `plan/work-items.yaml` or globs `plan/work-items/*.md` directly.
**Inconsistency**: P-6 (MCP is mandatory interface), P-26 (skills do not read YAML directly).
**Recommended change**: Use MCP tool to retrieve work items.

---

### SF-17: `skills/brrr/phases/execute.md` — directly reads architecture, principles, constraints files for context digest

**File**: `/Users/dan/code/ideate/skills/brrr/phases/execute.md`
**Lines**: 21-31
**Current text**: Directly reads `{artifact_dir}/plan/architecture.md`, `{artifact_dir}/steering/guiding-principles.md`, `{artifact_dir}/steering/constraints.md` for context digest preparation.
**Inconsistency**: P-6 (MCP is mandatory interface).
**Recommended change**: Use `ideate_get_context_package` or similar MCP tool instead of direct file reads.

---

### SF-18: `skills/brrr/phases/review.md` — directly reads architecture, principles, constraints for context package assembly

**File**: `/Users/dan/code/ideate/skills/brrr/phases/review.md`
**Lines**: 27-36
**Current text**: Manual context package assembly reads `{artifact_dir}/plan/architecture.md`, `steering/guiding-principles.md`, `steering/constraints.md` directly.
**Inconsistency**: P-6 (MCP is mandatory interface). The MCP path is preferred but the fallback still reads directly.
**Recommended change**: Since ideate tools are always present, the manual assembly path is dead code. Remove it.

---

## Defer Findings

### DF-1: `agents/proxy-human.md` — model field says `sonnet` but P-11 says model override at spawn time

**File**: `/Users/dan/code/ideate/agents/proxy-human.md`
**Lines**: 6
**Current text**: `model: sonnet`
**Note**: P-11 says agent definitions default to sonnet and model overrides happen at spawn time. The brrr execute phase spawns proxy-human with `model: opus`. The agent definition is technically correct per P-11 — the override happens at spawn. No functional issue.

---

### DF-2: `agents/domain-curator.md` — model field says `opus` instead of `sonnet`

**File**: `/Users/dan/code/ideate/agents/domain-curator.md`
**Lines**: 8
**Current text**: `model: opus`
**Note**: P-11 says agent definitions should specify `model: sonnet` as default, with overrides at spawn time. The domain-curator's definition says `model: opus`. The review skill already implements dynamic model selection (sonnet vs opus based on conflict signals). The agent definition should say `sonnet` per P-11, with the skill overriding to `opus` when needed. Low functional impact since the skill already overrides.

---

### DF-3: `skills/execute/SKILL.md` — Phase 4.5 context digest reads architecture directly

**File**: `/Users/dan/code/ideate/skills/execute/SKILL.md`
**Lines**: 151-168
**Current text**: Phase 4.5 reads the full architecture document, guiding principles, and constraints directly to build a context digest.
**Note**: Similar to SF-17 but in the execute skill. The context digest preparation involves filtering and extracting sections, which may not map cleanly to a single MCP call. Could be addressed when the MCP server provides a digest-building tool.

---

### DF-4: `skills/plan/SKILL.md` — steering artifacts written as markdown

**File**: `/Users/dan/code/ideate/skills/plan/SKILL.md`
**Lines**: 225-289
**Current text**: `steering/interview.md`, `steering/guiding-principles.md`, `steering/constraints.md` created as markdown.
**Note**: P-25 says all machine-actionable artifacts are YAML. However, the plan skill is the initial bootstrapping phase that creates the artifact directory. If the MCP server is not yet running against this directory (first-time creation), the skill may need a bootstrapping path. This is a design question that needs resolution before implementation. Deferred pending v3 bootstrap flow design.

---

### DF-5: `skills/brrr/SKILL.md` — `brrr-state.md` is a markdown file

**File**: `/Users/dan/code/ideate/skills/brrr/SKILL.md`
**Lines**: 100-112
**Current text**: `brrr-state.md` uses a markdown-like format with YAML-ish fields.
**Note**: P-25 says all machine-actionable artifacts are YAML. `brrr-state.md` is machine-actionable (parsed for cycle state). Should be YAML. Low priority since it is ephemeral session state.

---

### DF-6: Agent responsibility boundaries (P-10) are still coherent with MCP

**Files**: All 9 agent files
**Assessment**: With MCP tools handling data access, agent boundaries remain appropriate:
- **code-reviewer**: code correctness, quality, security, tests (not spec adherence) -- still clear
- **spec-reviewer**: plan adherence, principle compliance (not code quality) -- still clear
- **gap-analyst**: missing items (not quality of existing items) -- still clear
- **journal-keeper**: synthesis and cross-referencing (not new findings) -- still clear
- **domain-curator**: domain knowledge distillation (not reviewing code) -- still clear
- **proxy-human**: Andon decisions (not reviewing or curating) -- still clear
- **researcher**: background research (not deciding) -- still clear
- **architect**: analysis and design (not implementation) -- still clear
- **decomposer**: work item creation (not architecture) -- still clear

No P-10 violations found. MCP data access does not blur agent boundaries since agents receive context from the invoking skill, not by querying MCP directly. Deferred as no action needed.

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Must-fix | 34 |
| Should-fix | 18 |
| Defer | 6 |

### Must-Fix Breakdown by Violation Type

| Policy violated | Count | Files affected |
|-----------------|-------|----------------|
| P-32 (MCP availability checks for ideate tools) | 22 | execute, review, refine, brrr, brrr/execute, brrr/review, brrr/refine |
| P-6/P-26 (MCP mandatory interface) | 5 | plan, execute, refine |
| P-14 (outpost references) | 3 | plan, execute, review |
| GP-13/P-8 (validation strategy) | 3 | plan, decomposer |
| P-19/P-25 (canonical paths / YAML format) | 1 | plan |

### MCP Availability Check Removal Summary

Every skill file except `skills/plan/SKILL.md` contains at least one "MCP availability check" pattern for ideate tools that must be converted to direct calls. The total count of availability check + fallback blocks to remove:

| File | ideate tool checks to remove |
|------|------------------------------|
| `skills/execute/SKILL.md` | 4 (`ideate_get_execution_status`, `ideate_get_work_item_context`, `ideate_append_journal`, `ideate_get_project_status`) |
| `skills/review/SKILL.md` | 4 (`ideate_get_review_manifest`, `ideate_get_context_package`, `ideate_append_journal`, `ideate_archive_cycle`) + 1 soft check (`ideate_artifact_query`) |
| `skills/refine/SKILL.md` | 4 (`ideate_get_context_package`, `ideate_get_domain_state`, `ideate_write_work_items`, `ideate_append_journal`) |
| `skills/brrr/SKILL.md` | 1 (`ideate_get_convergence_status`) |
| `skills/brrr/phases/execute.md` | 3 (`ideate_get_work_item_context`, `ideate_get_execution_status`, `ideate_append_journal`) |
| `skills/brrr/phases/review.md` | 4 (`ideate_get_context_package`, `ideate_get_review_manifest`, `ideate_archive_cycle`, `ideate_append_journal`) |
| `skills/brrr/phases/refine.md` | 2 (`ideate_write_work_items`, `ideate_append_journal`) |
| **Total** | **23** |

### External Tool Checks to PRESERVE

These availability checks are correct and should NOT be removed (they reference external tools per P-32):

| File | External tool check |
|------|---------------------|
| `skills/plan/SKILL.md` line 148 | `spawn_session` (once outpost ref is generalized) |
| `skills/execute/SKILL.md` line 307 | `spawn_session` (once outpost ref is generalized) |
| `skills/review/SKILL.md` line 203 | `spawn_session` (once outpost ref is generalized) |

---

## Self-Check

Walking the acceptance criteria from the work item description:

- [x] **Read every file listed** -- All 8 skill files and 9 agent files were read in full.
- [x] **Audit against GP-8 / P-6 / P-26 / P-32 (MCP mandatory)** -- 22 must-fix findings for MCP availability check removal, plus 5 must-fix for direct file access violations, plus 18 should-fix for remaining direct file access patterns.
- [x] **Audit against GP-13 / P-8 (validation strategy)** -- 3 must-fix findings (MF-30, MF-31) plus 2 should-fix (SF-11, SF-12) for acceptance criteria rules that treat human-in-the-loop as exceptional rather than first-class.
- [x] **Audit against P-19 (canonical paths)** -- 5 should-fix findings for `archive/incremental/` references in skills and 3 should-fix for `archive/incremental/` references in agents.
- [x] **Audit against P-14 (outpost references)** -- 3 must-fix findings for "outpost" mentions in plan, execute, and review skills.
- [x] **Audit against P-10 (non-overlapping responsibilities)** -- Assessed all 9 agents. No violations found; boundaries remain coherent with MCP. Documented in DF-6.
- [x] **Critical distinction: ideate tool checks removed, external tool checks preserved** -- The 23 ideate tool checks are flagged for removal. The 3 external `spawn_session` checks are identified as preservable (after generalizing the "outpost" reference).
- [x] **Each must-fix includes file, line range, current text, required change, which principle/policy** -- All 34 must-fix findings include these fields.
- [x] **Findings categorized as must-fix / should-fix / defer** -- 34 must-fix, 18 should-fix, 6 defer.
- [x] **Structured so each must-fix can become a work item** -- Each must-fix has enough specificity (file, lines, current text, required change) to be converted directly to a work item.
- [x] **Output written to specified path** -- Written to `/Users/dan/code/ideate/specs/archive/cycles/026/audit-findings.md`.
