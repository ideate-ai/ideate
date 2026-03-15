# Gap Analysis — Cycle 003

Scope: WI-074 (manifest convention + plan skill update) and WI-075 (create specs/manifest.json).

---

## Missing Requirements from Interview

### MR1: Migration script removal not captured in work items
- **Interview reference**: refine-003/_full.md — "The existing ad-hoc migration scripts will be removed."
- **Current state**: `scripts/migrate-to-cycles.sh` and `scripts/migrate-to-domains.sh` both exist. No work item targets their removal.
- **Gap**: The interview frames the manifest as a replacement for ad-hoc scripts. Neither cycle 003 work item mentions them. The README Migration section still documents `migrate-to-domains.sh`.
- **Severity**: Minor — scripts cause no harm while present; defer to a dedicated work item.

### MR2: schema_version value established but schema v1 never defined
- **Interview reference**: refine-003/_full.md — starting version not explicitly decided; "current schema is v1."
- **Current state**: `{"schema_version": 1}` is written and documented. What v1 comprises — which files, directories, structural invariants — is not stated anywhere.
- **Gap**: The manifest's stated purpose (enabling migration scripts to apply targeted upgrades) is not achievable without a definition of what each version number represents.
- **Severity**: Minor — schema still in flux; define v1 when writing the first migration script.

---

## Unhandled Edge Cases

None.

---

## Incomplete Integrations

### II1: README.md artifact directory structure diagram omits manifest.json
- **File**: `/Users/dan/code/ideate/README.md:38-85`
- **Gap**: The `{artifact-dir}/` directory tree lists every top-level file and directory but does not include `manifest.json`. The README is the primary user-facing reference for artifact layout.
- **Impact**: Users bootstrapping artifact directories from the README will not create `manifest.json`. The structure diagram is actively misleading.
- **Severity**: Significant — recommend address now (one-line addition).

### II2: CLAUDE.md artifact structure diagram omits manifest.json
- **File**: `/Users/dan/code/ideate/CLAUDE.md`
- **Gap**: CLAUDE.md's "Artifact structure" section has a `specs/` directory tree with no `manifest.json` entry. This file is loaded as project context for every Claude Code session on the ideate repository.
- **Impact**: Agents following CLAUDE.md's diagram may treat a missing `manifest.json` as correct or fail to create it.
- **Severity**: Significant — recommend address now (one-line addition).

### II3: specs/plan/architecture.md permissions table omits manifest.json
- **File**: `/Users/dan/code/ideate/specs/plan/architecture.md`
- **Gap**: The read/write permissions table has no row for `manifest.json`, leaving no formal record of which phases may or may not touch it.
- **Severity**: Minor — defer; artifact-conventions.md is the live canonical reference for reviewers.

---

## Missing Infrastructure

### MI1: No enumeration of what schema version 1 comprises
- **Gap**: `specs/artifact-conventions.md` documents manifest.json's purpose and format but does not enumerate the structural invariants that define a v1-compliant artifact directory. No versioning policy exists (what warrants a version increment vs. a backward-compatible addition).
- **Severity**: Minor — defer until the first migration script is being written.

---

## Implicit Requirements

### IR1: All artifact directory structure references should be consistent with manifest.json addition
- **Current state**: `specs/artifact-conventions.md` and `skills/plan/SKILL.md` are updated and correct. `README.md`, `CLAUDE.md`, and `specs/plan/architecture.md` contain structure references that omit `manifest.json`.
- **Severity**: Significant (for README.md and CLAUDE.md); Minor (for architecture.md).
