# 005: Plan Skill

## Objective
Define the `/ideate:plan` skill — the interview-driven planning phase that takes a rough idea and produces exhaustively detailed specs.

## Acceptance Criteria
- [ ] `skills/plan/SKILL.md` exists with valid frontmatter (description, user-invocable: true, argument-hint)
- [ ] Skill asks for artifact directory location and creates the full directory structure
- [ ] Interview covers three tracks: intent, design, process — interleaved naturally
- [ ] Interview asks 1-2 questions at a time, uses answers to inform next questions
- [ ] Skill spawns `researcher` agents in background when topics arise, integrates findings
- [ ] Interview actively probes for ambiguity: flags vague terms ("appropriate", "clean", "as needed"), pushes for operationalization
- [ ] Interview detects completion: all tracks covered OR user says to move on
- [ ] Before closing interview, presents summary with open questions/risks
- [ ] Skill spawns `architect` agent to produce architecture doc with module decomposition
- [ ] Progressive decomposition: architecture → modules (with interface contracts) → work items
- [ ] Work items target Level 2-3 spec detail (implementation spec to atomic task)
- [ ] Each work item has machine-verifiable acceptance criteria where possible
- [ ] Non-overlapping file scope enforced across work items
- [ ] Dependency DAG validated (no cycles)
- [ ] 100% coverage check: work items collectively cover all module scope
- [ ] Execution strategy document produced based on process track answers
- [ ] All steering artifacts written: interview.md, guiding-principles.md, constraints.md
- [ ] All plan artifacts written: overview.md, architecture.md, modules/*.md, execution-strategy.md, work-items/*.md
- [ ] Journal initialized with planning session entry
- [ ] Final presentation: work item count, dependency graph, parallelism estimate, open concerns

## File Scope
- `skills/plan/SKILL.md` (create)

## Dependencies
- Depends on: 001, 002, 003
- Blocks: 007, 009

## Implementation Notes
This is the most complex skill. Key differences from v1:

**Ambiguity hunting**: The interview should not just gather requirements — it should actively search for places where the spec would be ambiguous. When the user says "it should handle errors appropriately," the skill should respond: "What specific errors? What does 'appropriately' mean for each? Should it retry, log, alert, fail silently, or propagate?" Every subjective qualifier must be operationalized.

**Progressive decomposition**: After the interview, the skill doesn't jump straight to work items. It first produces architecture (high-level components), then module specs (with interface contracts defining what each module provides and requires), then work items (atomic executable tasks). For small projects (fewer than 5 logical modules), the module layer can be skipped.

**Spec sufficiency validation**: Before finalizing work items, the skill should review them against the sufficiency heuristic: would two independent LLMs produce functionally equivalent output from this spec? If not, more detail is needed.

**Research integration**: When research agents return findings, the skill integrates relevant facts into its follow-up questions. It should not ask the user questions that the research already answered.

**Adaptive granularity**: The skill determines what decisions need user input based on the guiding principles. Technical choices that are clearly implied by the principles can be made without asking. Novel or high-impact decisions that the principles don't cover should be surfaced.

Tone: neutral, direct, no validation. If an idea has problems, say so with a clear explanation.

## Complexity
High
