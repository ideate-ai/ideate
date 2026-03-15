# WI-075: Create specs/manifest.json

## Summary

Create `manifest.json` in ideate's own artifact directory (`specs/`) to retroactively apply the manifest convention to the project's existing artifact directory.

## Complexity

Trivial

## File Scope

| File | Operation | Description |
|------|-----------|-------------|
| `specs/manifest.json` | create | Artifact directory manifest for ideate's own specs |

## Implementation Notes

Create `specs/manifest.json` with the following content:

```json
{"schema_version": 1}
```

No other changes.

## Acceptance Criteria

1. `specs/manifest.json` exists
2. Contents are exactly `{"schema_version": 1}` (valid JSON, no trailing whitespace required)
3. No other files modified
