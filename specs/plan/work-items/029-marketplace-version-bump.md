# 029: Marketplace Version Bump

## Objective
Sync `marketplace.json` version to 0.3.0 to match `plugin.json`, which was bumped in a prior cycle.

## Acceptance Criteria
- [ ] `metadata.version` in `.claude-plugin/marketplace.json` is `"0.3.0"`
- [ ] `plugins[0].version` in `.claude-plugin/marketplace.json` is `"0.3.0"`
- [ ] No other fields in `marketplace.json` are modified

## File Scope
- `.claude-plugin/marketplace.json` (modify)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes

Two version fields require updating:
1. `metadata.version`: `"0.2.0"` → `"0.3.0"` (line 8)
2. `plugins[0].version`: `"0.2.0"` → `"0.3.0"` (line 15)

## Complexity
Low
