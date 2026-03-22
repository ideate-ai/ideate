# Guiding Principles

## 1. Spec Sufficiency
A plan is not done until any reasonable question about the system can be answered from the specs alone. The test: two independent LLM runs given the same spec should produce functionally equivalent output. Anywhere they would diverge, the spec has an unresolved decision that must be made explicit.

This extends to all system dimensions — including user-facing ones. Visual identity, interaction design, user flows, accessibility requirements, and UX patterns must be resolved in the plan with the same rigor as data models or API contracts. A spec that fully defines backend behavior but leaves UI/UX to the executor's discretion is incomplete. The planning interview must surface these decisions explicitly.

> _Amended in refinement (2026-03-21): Added explicit requirement that specs cover UI/UX and visual identity decisions, not just technical architecture._

## 2. Minimal Inference at Execution
The executor should not make subjective decisions. Every architectural choice, technology selection, interface contract, error handling strategy, user experience pattern, visual identity decision, and behavioral detail should be resolved during planning. The executor follows instructions; it does not design.

> _Amended in refinement (2026-03-21): Expanded scope to include UX and visual identity decisions alongside technical choices. The plan phase — not the executor — is where visual and interaction design questions get answered._

## 3. Guiding Principles Over Implementation Details
Users care about objectives, not every technical choice. The tool must determine what level of granularity requires user input versus what can be delegated. Guiding principles serve as the decision framework — if a question can be answered by the principles, it should be answered without asking the user.

## 4. Parallel-First Design
Specs should be structured to maximize parallel execution. Work items must have non-overlapping scope and explicit dependency ordering. Foundational/sequential work is acceptable where necessary, but the default assumption is parallel. This applies beyond code — documentation, analysis, and review are also parallelizable.

## 5. Continuous Review
Review is not a phase that happens after execution — it overlaps with execution. Items are reviewed as they finish while other items continue building. The comprehensive end-of-cycle review is a capstone synthesis, not the first time anyone looks at the work. Catch issues as they occur.

## 6. Andon Cord Interaction Model
After initial planning, user interaction should be minimal and read-only by default. The user can see status but does not need to approve routine work. User intervention is reserved for critical issues that cannot be resolved from existing steering documents — like pulling an Andon cord in lean manufacturing. Stop, flag the issue, wait for direction.

## 7. Recursive Decomposition
Large projects decompose into modules, each with its own planning scope. The tool must handle arbitrary project scale by breaking work into nested levels — from high-level architecture down to atomic executable tasks. Where Claude Code's native capabilities limit recursion, external tooling (MCP servers, SDK orchestrators, CLI multiplexing) should be built to fill the gap.

## 8. Durable Knowledge Capture
Context windows are limited. All knowledge generated during planning, execution, and review must be captured in durable artifacts on disk. These artifacts serve as the inter-phase contract — no in-memory state carries between skill invocations. The artifact directory is the single source of truth.

## 9. Domain Agnosticism
The core workflow (explore idea → refine into plan → execute → review → iterate) is not specific to software. The tool should adapt its output format and evaluation criteria to the domain. For software: tests and type checks. For a business plan: key metrics. The evaluation criteria are part of the plan, not hardcoded into the tool.

## 10. Full SDLC Ownership
Ideate takes a project from rough idea to user-testable output. It does not stop at planning or at code generation — it produces something the user can evaluate. The user performs human-in-the-loop validation and re-engages with ideate for refinement if the output misses the mark.

## 11. Honest and Critical Tone
The tool speaks neutrally without validation, encouragement, or sugar-coating. A bad idea is identified as a bad idea with a clear explanation. No hedging qualifiers. No filler. The tool's job is to find problems and resolve ambiguity, not to confirm expectations.

## 12. Refinement as Validation
The refine phase serves double duty: fixing what's wrong AND adjusting what was asked for. Users are fallible and sometimes need to see results to understand what they actually need. Post-review is not just acceptance testing — it's validation that the original ask was correct. Requirements can change based on what the user learns from seeing working output.
