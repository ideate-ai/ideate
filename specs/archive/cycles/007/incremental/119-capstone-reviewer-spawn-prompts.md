## Verdict: Pass

Both modified files correctly add the dynamic testing instruction to the code-reviewer spawn prompt, referencing "comprehensive scope" and the agent's Dynamic Testing section. All acceptance criteria are satisfied.

## Critical Findings

None.

## Significant Findings

None.

## Minor Findings

None.

## Unmet Acceptance Criteria

None.

---

## Evidence

### AC1: `skills/review/SKILL.md` section 4.1 code-reviewer prompt includes the dynamic testing instruction

**Satisfied.** Lines 219–220 of `/Users/dan/code/ideate/skills/review/SKILL.md` contain:

```
> **Dynamic testing (comprehensive scope)**: After your static review, perform the dynamic checks defined in your agent instructions under "Dynamic Testing > Comprehensive review scope". Discover the project's test model and run the full test suite. Report test failures per the severity guidance in your agent instructions.
```

### AC2: `skills/brrr/phases/review.md` code-reviewer prompt includes the dynamic testing instruction

**Satisfied.** Lines 109–110 of `/Users/dan/code/ideate/skills/brrr/phases/review.md` contain:

```
  > **Dynamic testing (comprehensive scope)**: After your static review, perform the dynamic checks defined in your agent instructions under "Dynamic Testing > Comprehensive review scope". Discover the project's test model and run the full test suite. Report test failures per the severity guidance in your agent instructions.
```

### AC3: Both instructions reference "comprehensive scope"

**Satisfied.** Both prompts contain the phrase "comprehensive scope" in the instruction header ("Dynamic testing (comprehensive scope)").

### AC4: Both instructions reference the agent's Dynamic Testing section (added by WI-117)

**Satisfied.** Both instructions direct the agent to its own instructions "under 'Dynamic Testing > Comprehensive review scope'". The agent definition at `/Users/dan/code/ideate/agents/code-reviewer.md` lines 69–100 contains a "Dynamic Testing" section with a subsection "Comprehensive review scope (full project)" at line 93 (the heading reads "**Step 3 — Comprehensive review scope (full project):**"). The cross-reference is accurate: the phrase in the prompts ("Dynamic Testing > Comprehensive review scope") is a navigable path into that section.

### AC5: No other sections in either file are modified

**Spot-checked.** In `skills/review/SKILL.md`, the new lines appear only within section 4.1 (the code-reviewer prompt block, lines 219–220). All other sections (4.2 spec-reviewer, 4.3 gap-analyst, 4b.1 journal-keeper, and every phase outside 4a) are unchanged. In `skills/brrr/phases/review.md`, the new lines appear only in the code-reviewer prompt block (lines 109–110). The spec-reviewer and gap-analyst prompts and all surrounding phases are unchanged.

### Dynamic Testing

The changed files are markdown skill definitions with no executable code. The project's build artifact is the MCP artifact server at `/Users/dan/code/ideate/mcp/artifact-server/`. Build completed successfully (`npm run build` → `tsc` exit 0). No build failures introduced by WI-119. The project has a test runner (`vitest`) but tests are scoped to the MCP server source and are not relevant to markdown skill definition changes; they were not run as they cannot be triggered by changes to skill markdown files.
