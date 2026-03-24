# Incremental Review — WI-104: brrr/phases/review.md — domain curator invocation + interview path fallback

**Verdict: Pass**

## Critical Findings

None.

## Significant Findings

None.

## Minor Findings

### M1: Metrics entry after domain-curator is partially specified
- **File**: `/Users/dan/code/ideate/skills/brrr/phases/review.md:201`
- **Issue**: The instruction after the domain-curator spawn says `record a metrics entry with phase: "6b", agent_type: "domain-curator"` but omits the explicit `model: "opus"` field that the reviewer-spawn metrics entries also omit. This is consistent with the other entries in this file, so it is not a deviation in itself — however, none of the post-spawn metrics instructions in this file specify `model`, while the schema in the controller (SKILL.md line 265) lists `model` as a required field. The domain-curator prompt specifies `Model: opus`, so the value is available; the instruction just does not tell the controller to record it. All four post-spawn instructions (code-reviewer×3, journal-keeper, domain-curator) have the same omission, so this is a pre-existing pattern rather than something introduced by this WI, but the curator entry is the only new one here.
- **Suggested fix**: Add `model: "opus"` to the domain-curator metrics note: `record a metrics entry with phase: "6b", agent_type: "domain-curator", model: "opus"` — consistent with the model field being available and matching the agent spec above it.

## Unmet Acceptance Criteria

None. Detailed verification:

1. **`### Spawn Domain Curator` section exists after the journal-keeper section** — Present at line 185. Section heading is `### Spawn Domain Curator (After Journal-Keeper Completes)`, which is ordered after `### Spawn Journal-Keeper (After Reviewers Complete)` at line 157. Confirmed.

2. **Domain-curator spawn includes artifact_dir, review source path, cycle number, and review type in the prompt** — All four fields are present in the prompt block (lines 194–197): `{artifact_dir}` (line 194), `{artifact_dir}/archive/cycles/{formatted_cycle_number}/` with file enumeration (line 195), `{cycle_number}` (line 196), `review type: cycle` (line 197). Confirmed.

3. **A metrics entry is recorded after the domain-curator returns** — Line 201: "After the domain-curator returns, record a metrics entry with `phase: "6b"`, `agent_type: "domain-curator"`". Confirmed.

4. **`## Artifacts Written` lists the domains/ update** — Line 297: `{artifact_dir}/domains/ — policies, decisions, and questions updated by domain-curator`. Confirmed.

5. **gap-analyst prompt includes the `steering/interviews/` fallback** — Lines 143–143: `If not, check {artifact_dir}/steering/interviews/ — read the most recent _full.md file found there (highest refine-NNN directory). If neither exists, proceed without interview context.` Confirmed.

6. **journal-keeper prompt includes the `steering/interviews/` fallback** — Lines 171–171: `If not, check {artifact_dir}/steering/interviews/ — read the most recent _full.md file found there. If neither exists, proceed without interview context.` Confirmed.
