# Gap Analysis — Cycle 003

Scope: WI-111 (fix stale reviews/incremental/ path in spec-reviewer, gap-analyst, journal-keeper) and WI-112 (brrr/phases/review.md quality_summary emission).

---

## Pre-Analysis: Deferred Gap Check

`specs/domains/` exists. Checked all domain `questions.md` files before analysis.

Open questions with no new evidence from WI-111 or WI-112 — skipped:

- **Q-3** (spawn_session listed as primary path in plan/execute/review skills) — previously deferred, no new evidence; skipping.
- **Q-6** (proxy-human confidence level case inconsistency) — previously deferred, no new evidence; skipping.
- **Q-7** (brrr fallback entry heading format for proxy-human-log.md) — previously deferred, no new evidence; skipping.
- **Q-8** (no sub-subagents — recursive decomposition requires external tooling) — explicitly out of scope per constraint C-5; not a gap.
- **Q-13** (schema version 1 structural invariants not defined) — previously deferred, no new evidence; skipping.
- **Q-16** (findings.by_reviewer.suggestion has no consumer) — previously deferred, no new evidence; skipping.
- **Q-17** (skills/refine/SKILL.md inline metrics schema omits the cycle field) — previously deferred, no new evidence; skipping.
- **Q-18** (report.sh absent from README.md and plugin manifests) — previously deferred, no new evidence; skipping.

---

## Missing Requirements from Interview

None.

---

## Unhandled Edge Cases

None.

---

## Incomplete Integrations

### II1: brrr quality_summary event emits wrong skill field value
- **Interface**: `metrics.jsonl` quality_summary event — `skill` field
- **Producer**: `skills/brrr/phases/review.md`
- **Consumer**: `scripts/report.sh`
- **Gap**: `specs/artifact-conventions.md:735` canonically specifies that the `skill` field in a `quality_summary` event is `"review"` or `"brrr"` **depending on the emitter** — brrr-driven events must use `"brrr"`. WI-112's rework changed the field from `"brrr"` to `"review"` "for schema parity" (documented in `archive/incremental/112-brrr-review-quality-summary.md`). This contradicts the canonical spec. `report.sh` uses the `skill` field to attribute events to their source; brrr events claiming `"skill":"review"` are indistinguishable from standalone `/ideate:review` events. Any project that mixes brrr and standalone review invocations in the same `metrics.jsonl` will have silently incorrect per-skill quality trend attribution.
- **Severity**: Significant — the two-value enum in artifact-conventions.md:735 exists specifically to distinguish emitters. Emitting the wrong value defeats that purpose and silently corrupts per-skill breakdown data in report.sh Quality Trends.
- **Recommendation**: Address now — one-word fix: replace `"skill":"review"` with `"skill":"brrr"` in the JSON schema line at `skills/brrr/phases/review.md:235`. No design decision required; the canonical value is unambiguous in artifact-conventions.md:735. Q-14 should remain open until this fix is verified.

---

## Missing Infrastructure

None.

---

## Implicit Requirements

None.

---

## Cycle 002 Significant Finding Resolution

- **II1 from cycle 002** (WI-111 — stale `reviews/incremental/` path in three agent definitions): Confirmed resolved. Incremental review found all three agent files already used `archive/incremental/`; no changes were needed. Q-15 closed.
- **MI1 from cycle 002** (WI-112 — brrr review phase missing quality_summary emission): Partially resolved. The quality_summary emission block is present and structurally correct. One gap introduced by the rework: `"skill":"review"` should be `"skill":"brrr"` per artifact-conventions.md:735. Q-14 remains open pending this fix (tracked above as II1).
