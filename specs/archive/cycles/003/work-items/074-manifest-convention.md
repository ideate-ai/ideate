# WI-074: Manifest Convention and Plan Skill Update

## Summary

Document `manifest.json` in the artifact conventions and add its creation to the plan skill's directory scaffolding step.

## Complexity

Small

## File Scope

| File | Operation | Description |
|------|-----------|-------------|
| `specs/artifact-conventions.md` | modify | Add `manifest.json` to directory structure diagram; add `manifest.json` artifact section |
| `skills/plan/SKILL.md` | modify | Add `manifest.json` to Phase 1.1 scaffold listing |

## Implementation Notes

### specs/artifact-conventions.md

1. In the directory structure diagram (the opening code block), add `manifest.json` as a top-level file in `{artifact-dir}/`:

```
{artifact-dir}/
├── manifest.json          ← add this line
├── steering/
...
```

2. Add a new section after the directory structure block (before the Steering Artifacts section):

```markdown
## `manifest.json`

**Purpose**: Identifies the schema version of this artifact directory. Used by migration scripts to determine which upgrades to apply.

**Format**:
```json
{"schema_version": 1}
```

**Phases**: plan (write), never modified by other phases
**Semantics**: Written once during `/ideate:plan` directory scaffolding. Not read or checked by any skill at runtime. Updated only by migration scripts when the schema version advances.
```

### skills/plan/SKILL.md

In Phase 1.1, the directory creation block currently ends with:

```
└── domains/
```

Add `manifest.json` to the structure listing and to the creation instruction. The current text reads:

> Once the user provides a path, create the full directory structure:
> ```
> {artifact-dir}/
> ├── steering/
> ...
> ```
> Do not create any artifact files yet. The structure is scaffolding only at this stage.

Change the instruction to:

> Once the user provides a path, create the directory structure and write `manifest.json`:
>
> ```
> {artifact-dir}/
> ├── manifest.json
> ├── steering/
> │   ├── research/
> │   └── interviews/
> ├── plan/
> │   ├── modules/
> │   └── work-items/
> ├── archive/
> │   ├── incremental/
> │   └── cycles/
> └── domains/
> ```
>
> Create `manifest.json` with the content:
> ```json
> {"schema_version": 1}
> ```
>
> Create `.gitkeep` files in all empty directories. No other artifact files yet.

## Acceptance Criteria

1. `specs/artifact-conventions.md` directory structure diagram includes `manifest.json` as a top-level entry
2. `specs/artifact-conventions.md` has a `manifest.json` section documenting purpose, format, phases, and semantics
3. `skills/plan/SKILL.md` Phase 1.1 directory structure listing includes `manifest.json`
4. `skills/plan/SKILL.md` Phase 1.1 instructs creation of `manifest.json` with `{"schema_version": 1}`
5. No other files modified
