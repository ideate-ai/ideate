# Refinement Plan — Artifact Schema Versioning (Cycle 003)

## What Is Changing

Adding a `manifest.json` file to the artifact directory structure. The manifest contains a schema version number, enabling future migrations to detect the current schema version and apply targeted upgrades.

## Triggering Context

User request: ideate has had 2 breaking schema changes to date (ad-hoc migration scripts exist for both). Going forward, the user wants a version marker in every artifact directory so future schema migrations can be versioned (`v1→v2`, `v2→v3`) and applied non-destructively.

## Scope

**Create:**
- `{artifact-dir}/manifest.json` — new file, created by `/ideate:plan` during directory scaffolding

**Modify:**
- `skills/plan/SKILL.md` — Phase 1.1 directory structure block: add `manifest.json` to the scaffold listing and creation step
- `specs/artifact-conventions.md` — directory structure diagram and new `manifest.json` section

**Out of scope:**
- No enforcement logic in skills (no version checks, no migration triggers)
- No migration scripts for prior schema versions (the two existing scripts will be removed separately)
- No changes to refine, execute, review, or brrr skills

## Expected Impact

After this cycle:
- New artifact directories created by `/ideate:plan` include `manifest.json` with `{"schema_version": 1}`
- The artifact convention document describes `manifest.json` as the canonical schema version marker
- Ideate's own `specs/` directory has a `manifest.json`

## New Work Items

WI-074 and WI-075 (2 items, parallelizable).
