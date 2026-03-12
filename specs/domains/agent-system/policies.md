# Policies: Agent System

## P-10: Each agent has a single, non-overlapping responsibility boundary
An agent's prompt must specify exactly what it is responsible for and what it is not; agents must not cross responsibility boundaries (e.g., code-reviewer does not assess spec adherence; spec-reviewer does not assess code quality).
- **Derived from**: GP-2 (Minimal Inference at Execution), GP-4 (Parallel-First Design)
- **Established**: planning phase
- **Status**: active

## P-11: Agent model defaults to sonnet; model overrides are applied at spawn time by the invoking skill
Agent definition files specify `model: sonnet` as default; skills that require a more capable model (e.g., opus for architect, decomposer, proxy-human) set the model parameter at spawn time, not in the agent definition.
- **Derived from**: GP-3 (Guiding Principles Over Implementation Details) — model selection is a spawn-time concern, not a hardcoded agent identity
- **Established**: cycle 001 (WI-040)
- **Status**: active

## P-12: Agents that run in the background must be declared with background: true in frontmatter; all others use background: false
The background field must be explicit in agent frontmatter so execution tools can determine parallelism without reading the spawning skill.
- **Derived from**: GP-4 (Parallel-First Design)
- **Established**: cycle 001 (WI-028)
- **Status**: active

## P-13: Agents communicate only through artifact files, not through return values passed between skills
An agent's output is written to a specified artifact path; the invoking skill reads that path after the agent completes; no in-memory result objects are passed between skill phases.
- **Derived from**: GP-8 (Durable Knowledge Capture), constraint C-2 (File-based coordination)
- **Established**: planning phase
- **Status**: active
