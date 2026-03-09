# 007: Execute Skill

## Objective
Define the `/ideate:execute` skill — builds the project by following the plan, using the agent strategy specified, with continuous incremental review.

## Acceptance Criteria
- [ ] `skills/execute/SKILL.md` exists with valid frontmatter (description, user-invocable: true, argument-hint)
- [ ] Skill locates artifact directory (from argument or by searching)
- [ ] Reads and validates: execution strategy, overview, architecture, guiding principles, constraints, all work items, module specs
- [ ] Validates dependency DAG — reports cycles and stops if found
- [ ] Presents execution plan to user: work items, dependency structure, parallelism, agent strategy, prerequisites
- [ ] Asks for confirmation before starting
- [ ] Supports three execution modes:
  - Sequential: one item at a time in dependency order
  - Batched parallel: groups of independent items via subagents, batches run sequentially
  - Full parallel: agent teams with shared task list
- [ ] For all modes: each subagent/teammate receives work item spec, architecture doc, relevant module spec, guiding principles, constraints
- [ ] Continuous incremental review: as each work item completes, spawns `code-reviewer` to validate
- [ ] Incremental review written to `reviews/incremental/NNN-{name}.md`
- [ ] Review finding handling:
  - Minor: fix immediately, note rework in journal
  - Significant/Critical within scope: fix, note in journal
  - Scope-changing or principle-violating: flag to user (Andon cord), wait for direction
- [ ] Journal updated after each work item completion with: status, deviations, decisions
- [ ] Status reporting to user at natural milestones (batch completion, dependency group transition)
- [ ] Unresolvable gaps collected and presented to user in batches rather than one-at-a-time interrupts
- [ ] Final summary: items completed, rework count, outstanding issues, deviations from plan
- [ ] Suggests `/ideate:review` for comprehensive evaluation
- [ ] For team mode: notes `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` requirement
- [ ] For parallel modes: uses worktree isolation when specified in execution strategy

## File Scope
- `skills/execute/SKILL.md` (create)

## Dependencies
- Depends on: 001, 004, 005, 006
- Blocks: 008

## Implementation Notes
The execute skill is the orchestrator. It doesn't write project code itself — it delegates to subagents or teammates, each of which receives a focused work item spec and the context needed to implement it.

**Continuous review architecture**: When an item completes, a `code-reviewer` is spawned immediately as a background agent (if possible) or foreground agent. In team mode, the `TaskCompleted` hook can trigger review validation. The key principle: review should not block other work from proceeding. If item A finishes and is being reviewed, items B and C should continue building.

**Andon cord mechanism**: During execution, the skill collects questions and issues that guiding principles can't resolve. Rather than interrupting the user for each one, it batches them and presents them at natural pause points (between dependency groups, or when a blocking issue prevents progress).

**Context for workers**: Each worker agent receives:
1. The work item spec (what to build)
2. The architecture doc (how it fits into the system)
3. The relevant module spec (interface contracts, boundary rules)
4. The guiding principles (decision framework for ambiguous situations)
5. The constraints doc (what not to do)
6. Relevant research from steering/research/ if applicable

**Module-aware execution**: If the plan includes module specs, the executor should pass the relevant module spec to each worker. Workers for the same module should be aware of the module's interface contracts to prevent drift.

**Recursive execution**: For large projects where decomposition produced sub-plans (via the MCP session spawner), the execute skill should be able to invoke sub-sessions for module-level execution. This requires the session-spawner MCP server to be configured.

## Complexity
High
