# Work Item 048: Fix plugin.json Version

## Objective

Update `.claude-plugin/plugin.json` version from `0.3.0` to `0.4.0` to match `marketplace.json`. WI-038 bumped the marketplace version but did not update plugin.json.

## Acceptance Criteria

1. `.claude-plugin/plugin.json` `"version"` field reads `"0.4.0"`
2. No other content in plugin.json is modified

## File Scope

- modify: `.claude-plugin/plugin.json`

## Dependencies

None.

## Implementation Notes

Locate the `"version": "0.3.0"` field in `.claude-plugin/plugin.json` and change the value to `"0.4.0"`.

## Complexity

Trivial
