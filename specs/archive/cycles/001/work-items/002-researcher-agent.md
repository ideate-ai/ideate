# 002: Researcher Agent

## Objective
Define the researcher agent — a background agent that investigates technologies, domains, patterns, and design questions during the interview phase. Returns structured findings.

## Acceptance Criteria
- [ ] `agents/researcher.md` exists with valid frontmatter (name, description, tools, model, maxTurns, background)
- [ ] Agent has access to: Read, Grep, Glob, WebSearch, WebFetch
- [ ] Agent runs in background (`background: true`)
- [ ] System prompt requires structured output: Summary, Key Facts, Recommendations, Risks, Sources
- [ ] System prompt instructs the agent to be thorough but concise, flag uncertainty, and not editorialize
- [ ] System prompt instructs the agent to save findings to a specified file path when a Write tool is available, or return findings in response when not

## File Scope
- `agents/researcher.md` (create)

## Dependencies
- Depends on: 001
- Blocks: 005, 006

## Implementation Notes
The researcher is spawned during plan and refine interviews when the user mentions a topic worth investigating. It runs in the background so the interview can continue. Results are integrated into follow-up questions.

Model should be `sonnet` for cost efficiency — research tasks are focused and don't require opus-level reasoning. MaxTurns should be 15-20 to allow thorough web search and document reading.

The agent should handle the case where WebSearch/WebFetch are denied (permission mode) by falling back to training knowledge with a clear disclaimer.

## Complexity
Low
