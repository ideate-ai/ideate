# Constraints

## Technology Constraints

1. **Claude Code plugin format.** The core product is a Claude Code plugin — markdown skill definitions, agent definitions, plugin manifest. No runtime code is required for the core workflow, but external tooling (MCP servers, SDK orchestrators) may be built to extend capabilities.

2. **File-based coordination.** All inter-phase state lives in YAML files in the `.ideate/` directory. No in-memory state between skill invocations. Each skill reads what it needs from artifacts — either directly from YAML files or via MCP tools backed by the SQLite runtime index — and writes its outputs as YAML files. The SQLite index is a derived cache; skills must never write directly to it.

3. **Agent teams as preferred execution mode.** Design for agent teams with shared task lists as the default, with batched subagents as fallback. Sequential mode available for small projects or constrained environments.

4. **Worktree isolation for parallel execution.** When multiple agents work in parallel on the same repository, use git worktree isolation to prevent file conflicts.

5. **No sub-subagents or nested teams.** Claude Code does not support subagents spawning their own subagents or teams creating sub-teams. Recursive workflows require external tooling (MCP server, SDK orchestrator, or shell scripts using `claude --print`).

## Design Constraints

6. **Non-overlapping work item scope.** Two work items that touch the same file must be sequenced via dependency ordering or the scope must be split. This is required for parallel execution correctness.

7. **Machine-verifiable acceptance criteria preferred.** Work item acceptance criteria should be testable without human judgment wherever possible — test pass/fail, type checking, structural assertions, behavioral contracts. Criteria requiring subjective evaluation signal unresolved ambiguity in the spec.

8. **Progressive decomposition.** Large projects decompose in levels: Intent → Architecture → Modules → Work Items. Not all levels are needed for small projects. The tool should detect project scale and skip intermediate levels when unnecessary.

9. **Interface contracts before parallel decomposition.** When decomposing into modules for parallel work, shared interfaces must be defined before individual modules are planned. This prevents inconsistent assumptions across independently-planned modules.

## Process Constraints

10. **Front-loaded interaction.** The interview phase is where the user invests time. After planning, the user should be able to step back. Execution and review proceed with minimal user input unless critical issues arise.

11. **Continuous review during execution.** Review overlaps with execution. Completed items are reviewed immediately while other items continue. The final comprehensive review is additive, not the sole quality check.

12. **Andon cord for critical issues only.** During execution, the user is not asked for routine decisions. The system flags issues to the user only when guiding principles cannot resolve them. Flagged issues can be batched.

13. **Neutral, critical tone throughout.** All skills and agents communicate without encouragement, validation, praise, enthusiasm, or hedging qualifiers. Problems are stated directly with explanations.

## Scope Constraints

14. **Spec creation through user-testable output.** The tool's scope covers the full path from idea to working, testable result. It does not cover ongoing maintenance, deployment operations, or monitoring — those are the user's responsibility after delivery.

15. **Software-primary, domain-flexible.** Software development is the primary use case and the one optimized for. Other domains (business plans, documentation projects, etc.) should work with the same workflow but may lack domain-specific evaluation tools.

16. **External tooling is in scope.** If limitations in Claude Code's capabilities (no recursive subagents, no subprocess spawning) prevent the tool from achieving its goals, building external software (MCP servers, CLI tools, SDK-based orchestrators) to fill the gap is in scope.
