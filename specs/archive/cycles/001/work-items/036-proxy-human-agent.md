# Work Item 036: Proxy Human Agent

## Objective

Create an agent definition that acts as the human decision-maker during autonomous brrr cycles. When an Andon event occurs and the human is absent, this agent evaluates the issue against guiding principles and makes a decision with full authority.

## Acceptance Criteria

1. Agent definition at `agents/proxy-human.md` with valid YAML frontmatter.
2. Frontmatter: `name: proxy-human`, `model: claude-opus-4-6`, `background: false`, `maxTurns: 40`.
3. Tools list: `[Read, Grep, Glob, Bash]`. Read access to all artifacts. Bash for running tests and checks.
4. Agent prompt covers all of the following:
   a. Reading `steering/guiding-principles.md` and `steering/constraints.md` as primary decision authority
   b. Reading the full Andon event description from input
   c. Evaluating the event: is it answerable from guiding principles? Is it answerable from constraints? Is it a tactical implementation decision or an architectural one?
   d. Making the decision — do not defer to the human for decisions that guiding principles can answer
   e. Recording the decision in a structured entry: `{timestamp, event_summary, decision, rationale, principles_cited[], confidence: high|medium|low, implications[]}`
   f. Appending the decision to `{artifact_dir}/proxy-human-log.md`
   g. If the event is genuinely unanswerable from principles (e.g., requires user to provide external credentials, or contradicts two principles), record it as "deferred" with explanation — do NOT make something up
5. Agent prompt specifies: the agent has full authority except where guiding principles genuinely conflict or where external information is required that no principle can substitute for.
6. Input contract: artifact_dir path, Andon event description (string), cycle number.
7. Output contract: structured decision entry written to `proxy-human-log.md`; returns decision summary as response text.

## File Scope

- create: `agents/proxy-human.md`

## Dependencies

None (parallel with 030, 032, 035).

## Implementation Notes

- Use opus model — Andon decisions may involve complex contextual reasoning.
- The proxy-human agent is explicitly NOT a rubber-stamp. It must genuinely evaluate against principles. The prompt should model the behavior of a principal who reads the spec carefully, not one who always approves.
- "Confidence" field captures honest uncertainty: high = clearly answerable from principles; medium = judgment call within spirit of principles; low = at edge of principle coverage, consider flagging for human review anyway.
- `proxy-human-log.md` uses append semantics — each invocation adds one entry. It is never overwritten.

## Complexity

Medium
