# Policies: Artifact Structure

## P-6: The artifact directory is the sole inter-phase contract
All inter-phase state must reside in named files in the artifact directory on disk; no in-memory state carries between skill invocations; each skill starts cold and reads what it needs.
- **Derived from**: GP-8 (Durable Knowledge Capture)
- **Established**: planning phase
- **Status**: active

## P-7: journal.md is strictly append-only
No skill or agent may edit or delete existing journal entries; every phase adds entries with a phase tag and date header; the journal is the authoritative chronological record.
- **Derived from**: GP-8 (Durable Knowledge Capture)
- **Established**: planning phase
- **Status**: active

## P-8: Work item acceptance criteria must be machine-verifiable where possible
Work items must express acceptance criteria as test pass/fail, type checks, structural assertions, or behavioral contracts; criteria requiring subjective human judgment signal unresolved ambiguity in the spec.
- **Derived from**: GP-1 (Spec Sufficiency), constraint C-7
- **Established**: planning phase
- **Status**: active

## P-9: Work item numbers are globally unique and continue from the highest existing number in refinement cycles
New work items in a refinement cycle must be numbered starting from the highest existing work item number plus one; no two work items may share the same three-digit prefix.
- **Derived from**: GP-4 (Parallel-First Design) — execution tooling globs by prefix; duplicates cause ambiguous ordering
- **Established**: planning phase
- **Status**: active

## P-17: Every artifact directory must contain a manifest.json with a schema_version field
The plan skill creates `manifest.json` with `{"schema_version": 1}` during initial directory scaffolding; the file is written once and updated only by migration scripts, never by execute, review, or refine phases.
- **Derived from**: D-17 (manifest.json as schema version marker)
- **Established**: cycle 003
- **Status**: active
