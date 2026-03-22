# Change Plan — Cycle 008

**Triggered by**: Cycle 007 minor findings OQ1, OQ2, OQ3 (residual documentation inconsistencies from WI-100's partial fix)

---

## What is changing

### Group 1: Remaining documentation cluster (WI-101)

Three one-liner fixes deferred from cycle 007:

1. **`skills/plan/SKILL.md:730`**, **`skills/execute/SKILL.md:575`**, **`skills/review/SKILL.md:643`** — Add `"cycle":null,` between `"phase":"<id>"` and `"agent_type":"<type>"` in each inline agent-spawn metrics schema. WI-100 fixed `skills/refine/SKILL.md` but not these three. The canonical schema in `specs/artifact-conventions.md:720` has the field; the three omissions are now an internal inconsistency among skill files.

2. **`scripts/report.sh`** — Update the Quality Trends empty-state message at the line containing "No quality data recorded" to reference both `/ideate:review` and `/ideate:brrr` instead of only `/ideate:review`. After WI-098 added quality_summary emission to the brrr review phase, users running brrr-only projects receive incorrect guidance when the Quality Trends section is empty.

3. **`specs/artifact-conventions.md`** — Add a sentence to the `metrics.jsonl` → `quality_summary` schema section noting that `quality_summary` is emitted only by review-phase orchestrators (`skills/review/SKILL.md` and `skills/brrr/phases/review.md`) and briefly explaining why (only these phases produce severity-classified findings). This records the scoping rationale for future maintainers.

---

## What is NOT changing

- All other skill, agent, or phase documents
- All scripts other than `report.sh`
- Architecture, modules, MCP server
- Guiding principles (confirmed unchanged)

---

## Expected impact

- After WI-101: all five skill inline schemas match the canonical `cycle` field structure. Report tooling that buckets by `cycle` will correctly handle entries from plan, execute, and review.
- After WI-101: report.sh empty-state message gives correct guidance for both `/ideate:review` and `/ideate:brrr` users.
- After WI-101: future maintainers have a written rationale for `quality_summary` scoping in the canonical schema document.

---

## Scope boundary

File-level scope:
- `skills/plan/SKILL.md`, `skills/execute/SKILL.md`, `skills/review/SKILL.md`
- `scripts/report.sh`
- `specs/artifact-conventions.md`
