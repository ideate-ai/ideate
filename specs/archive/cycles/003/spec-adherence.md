# Spec Adherence Review — Cycle 003

Scope: WI-074 (Manifest Convention and Plan Skill Update) and WI-075 (Create specs/manifest.json).

---

## Architecture Deviations

### D1: Review artifact section headings in artifact-conventions.md use stale path prefix (pre-existing)

- **Expected**: Artifact path references in `specs/artifact-conventions.md` should use `archive/incremental/` and `archive/cycles/{NNN}/` to match the current directory layout.
- **Actual**: Section headings and in-text path references in the Review Artifacts portion (lines ~357–641) still use `reviews/incremental/` and `reviews/final/`.
- **Note**: Pre-existing inconsistency. The WI-074 M1 rework fixed the directory structure diagram but not the Review Artifacts section headings, which were outside WI-074's scope. Not a cycle 003 delivery failure.

---

## Unmet Acceptance Criteria

### WI-074

- [x] `specs/artifact-conventions.md` directory structure diagram includes `manifest.json` as top-level entry
- [x] `specs/artifact-conventions.md` has a `manifest.json` section documenting purpose, format, phases, and semantics
- [x] `skills/plan/SKILL.md` Phase 1.1 directory structure listing includes `manifest.json`
- [x] `skills/plan/SKILL.md` Phase 1.1 instructs creation of `manifest.json` with `{"schema_version": 1}`
- [x] No other files modified

### WI-075

- [x] `specs/manifest.json` exists
- [x] Contents are exactly `{"schema_version": 1}`
- [x] No other files modified

---

## Principle Violations

None.

---

## Naming/Pattern Inconsistencies

### N1: Review Artifacts section headings in artifact-conventions.md use stale paths

Same as D1 above. `specs/artifact-conventions.md` lines ~357–641 reference `reviews/incremental/` and `reviews/final/` throughout the Review Artifacts section body, inconsistent with the corrected directory structure diagram. Pre-existing; not introduced by cycle 003.

---

## Undocumented Additions

None.
