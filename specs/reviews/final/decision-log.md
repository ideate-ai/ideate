# Decision Log and Open Questions

## Decision Log

### Planning Phase

#### DL1: Clean-Slate Reimplementation
- **When**: Planning
- **Decision**: Build ideate v2 as a complete reimplementation with no assumptions from v1.
- **Rationale**: Use ideate to redesign itself (dogfooding). Clean-slate avoids inherited design bias.
- **Implications**: All design choices justified from first principles. No v1 user migration addressed.

#### DL2: Spec Sufficiency as Primary Quality Standard
- **When**: Planning
- **Decision**: A plan is complete only when two independent LLMs given the same spec would produce functionally equivalent output.
- **Rationale**: LLMs struggle with large tasks due to underspecified plans.
- **Implications**: High bar for planning interview depth and work item specification breadth.

#### DL3: Progressive Decomposition (Architecture → Modules → Work Items)
- **When**: Planning
- **Decision**: Three-level decomposition with interface contracts at the module level.
- **Rationale**: LLMs are good at small, well-bounded tasks.
- **Implications**: 5-module threshold for intermediate module specs. May be too rigid for complex smaller projects.

#### DL4: Parallel-First Execution
- **When**: Planning
- **Decision**: Agent teams as default; sequential and batched as secondary modes.
- **Rationale**: Speed and quality priorities. User preference for teams mode.
- **Implications**: Non-overlapping scope required. All three modes must be supported.

#### DL5: Andon Cord Interaction Model
- **When**: Planning
- **Decision**: Minimal post-planning user interaction. Issues batched at natural pause points.
- **Rationale**: User requested minimal post-planning interaction. Principles serve as decision framework.
- **Implications**: Principles must be thorough enough to resolve most runtime decisions.

#### DL6: External MCP Session-Spawner
- **When**: Planning
- **Decision**: Build a Python MCP server for recursive sub-session spawning.
- **Rationale**: Recursive decomposition requires sub-session invocation; Claude Code cannot natively do this.
- **Alternatives**: Multiple sequential runs (no tooling), Claude Agent SDK orchestration.
- **Implications**: Python runtime dependency. Language choice deferred during planning.

#### DL7: Guiding Principles as Delegation Framework
- **When**: Planning
- **Decision**: Principles are the single decision framework for autonomous vs. user-input decisions.
- **Rationale**: Users care about objectives, not every implementation detail.

#### DL8: Durable Artifact Directory as Inter-Phase Contract
- **When**: Planning
- **Decision**: All knowledge on disk. No in-memory state between skill invocations.
- **Rationale**: Context windows are limited. Artifact directory is single source of truth.

#### DL9: Continuous Review Overlapping Execution
- **When**: Planning
- **Decision**: Incremental reviews during execution; capstone synthesis at end.
- **Rationale**: Catching issues at creation is faster than batch review.

#### DL10: Domain Agnostic Core, Software Primary
- **When**: Planning
- **Decision**: Core workflow is domain agnostic. Evaluation criteria come from the plan.
- **Rationale**: User goal with software as near-term focus.

#### DL11: Scope: Idea to User-Testable Output
- **When**: Planning
- **Decision**: Stop at user-testable output. No ongoing maintenance or deployment.
- **Rationale**: User-defined scope boundary.

### Execution Phase

#### DL12: Python for MCP Session-Spawner
- **When**: Execution — work item 010
- **Decision**: Python implementation selected.
- **Rationale**: Not documented. Language choice was deferred during planning.
- **Implications**: Python 3.10+ dependency. TypeScript alternative never formally evaluated.

#### DL13: Incremental Review Format Richer Than Conventions
- **When**: Execution — work items 007, 008
- **Decision**: Execute skill and code-reviewer use richer format than artifact-conventions.md specifies.
- **Rationale**: More informative format. Assessment: conventions should be updated to match.
- **Implications**: artifact-conventions.md is inconsistent with practice. Not fixed this cycle.

---

## Open Questions

### OQ1: Spec Sufficiency Runtime Heuristic
- **Question**: How does the tool pragmatically validate spec sufficiency at runtime?
- **Source**: Journal — explicitly deferred.
- **Impact**: Plan skill cannot reliably signal "done."
- **Who answers**: Technical investigation.
- **Consequence of inaction**: Plans declared complete with unanswered questions. Core quality guarantee weakened.

### OQ2: Token Budget for Recursive Sessions
- **Question**: How are token budgets bounded across the session tree?
- **Source**: Journal — explicitly deferred.
- **Impact**: Large projects could exhaust budgets with no warning.
- **Who answers**: Technical investigation.
- **Consequence of inaction**: Runaway cost with no safeguard.

### OQ3: Python vs TypeScript Rationale
- **Question**: Was Python the right choice? Decision was never formally evaluated.
- **Source**: Journal — deferred during planning, silently resolved during execution.
- **Who answers**: User decision.
- **Consequence of inaction**: Python stands by default. Undocumented language choice.

### OQ4: artifact-conventions.md Format Inconsistency
- **Question**: Conventions doc doesn't match actual review format used by agents.
- **Source**: Multiple incremental reviews.
- **Who answers**: Technical investigation.
- **Consequence of inaction**: Conventions doc drifts from reality.

### OQ5: Plugin Manifest Validation Never Run
- **Question**: Does plugin.json pass `claude plugin validate`?
- **Source**: Incremental review 001.
- **Who answers**: Technical investigation — run the command.
- **Consequence of inaction**: Plugin may fail to load.

### OQ6: Module Spec Threshold Rigidity
- **Question**: Should 5-module threshold be softened or made configurable?
- **Source**: Incremental review 005-006.
- **Who answers**: Design review.
- **Consequence of inaction**: Complex small projects miss progressive decomposition benefits.

### OQ7: --allowedTools CLI Syntax
- **Question**: Does Claude CLI accept comma-separated tool names?
- **Source**: Incremental review 007-008-010.
- **Who answers**: Technical investigation — test it.
- **Consequence of inaction**: Tool allowlist feature may be silently broken.
