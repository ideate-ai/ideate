# 021: Plugin Validation

## Objective
Run `claude plugin validate` against the plugin manifest and fix any issues found. This criterion was deferred from work item 001 and never completed.

## Acceptance Criteria
- [ ] `claude plugin validate` is run against the plugin directory
- [ ] If validation fails, fix the issues in `.claude-plugin/plugin.json` and/or `.claude-plugin/marketplace.json`
- [ ] If validation passes, no changes needed — document the validation result in the journal
- [ ] If `claude plugin validate` is not available as a command, document this finding and manually verify the manifest against the Claude Code plugin specification

## File Scope
- `.claude-plugin/plugin.json` (modify)
- `.claude-plugin/marketplace.json` (modify)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes
Run the command from the project root: `claude plugin validate .`

If the command does not exist or is not recognized, check Claude Code documentation for the correct validation command or manual validation steps. The plugin format requires at minimum: `name`, `version`, `description` in plugin.json. Skills are discovered by convention (`skills/*/SKILL.md`), agents by convention (`agents/*.md`).

If validation reveals missing required fields (e.g., a `main` field, an `engines` field, or explicit skill/agent registration), add them. Document what was found and fixed.

## Complexity
Low
