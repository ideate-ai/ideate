# 003: Architect Agent

## Objective
Define the architect agent — analyzes codebases, designs technical architecture, and performs multi-level decomposition (architecture → modules → work items).

## Acceptance Criteria
- [ ] `agents/architect.md` exists with valid frontmatter
- [ ] Agent has access to: Read, Grep, Glob, Bash
- [ ] System prompt covers two modes: analyzing existing codebases and designing new architecture
- [ ] When analyzing: maps directory structure, languages, frameworks, module boundaries, data flows, test coverage, dependencies, patterns
- [ ] When designing: decomposes into modules with clear interfaces, identifies parallel vs sequential ordering, defines interface contracts between modules, flags design tensions
- [ ] System prompt includes the module spec format (Provides, Requires, Boundary Rules)
- [ ] Agent does not advocate for technologies — presents options with tradeoffs
- [ ] Output format uses clear headers, code blocks for interfaces, explicit module boundary definitions

## File Scope
- `agents/architect.md` (create)

## Dependencies
- Depends on: 001
- Blocks: 005, 006

## Implementation Notes
Model should be `opus` — architecture requires complex multi-factor reasoning. MaxTurns should be 30-40 to allow thorough analysis.

The architect must understand the module decomposition protocol:
1. Each module spec defines: scope, responsibilities, what it provides (exports), what it requires (imports), boundary rules
2. Interface contracts between modules must be defined before work items are created
3. The 100% coverage check: union of all module scopes must equal the full project scope with no gaps or overlaps

When designing for an existing codebase (refine phase), the architect should report facts without evaluating whether choices are "good" or "bad."

## Complexity
Medium
