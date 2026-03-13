# Work Item 041: Add proxy-human Role and Fix brrr Invocation

## Objective

Add a `proxy-human` entry to `mcp/roles/default-roles.json` containing the decision-making system prompt from `agents/proxy-human.md`. Update `skills/brrr/SKILL.md` Phase 6a to invoke proxy-human via `role: "proxy-human"` and `model: "claude-opus-4-6"` in the `spawn_session` call, replacing the broken `agent: proxy-human` parameter that does not exist in the tool schema.

## Acceptance Criteria

1. `mcp/roles/default-roles.json` contains a `proxy-human` key with at minimum `system_prompt` field containing the decision-making instructions from `agents/proxy-human.md`
2. The proxy-human role in `default-roles.json` follows the same structure as the existing `worker`, `reviewer`, and `manager` role entries
3. `skills/brrr/SKILL.md` Phase 6a Andon routing section uses `role: "proxy-human"` (not `agent: proxy-human`) when calling `spawn_session`
4. `skills/brrr/SKILL.md` Phase 6a specifies `model: "claude-opus-4-6"` in the proxy-human spawn call
5. The `agent: proxy-human` parameter no longer appears anywhere in `skills/brrr/SKILL.md`
6. The spawn_session call in Phase 6a includes all required parameters: `prompt` (the Andon event description), `working_dir`, `role`, `model`
7. The prompt passed to the spawned proxy-human session includes the Andon event context: event description, artifact_dir, cycle_number

## File Scope

- modify: `mcp/roles/default-roles.json`
- modify: `skills/brrr/SKILL.md`

## Dependencies

- 039 (spawn_session model parameter)
- 040 (proxy-human.md model changed to sonnet, confirming model override is needed at spawn time)

## Implementation Notes

**default-roles.json**: The existing entries (`worker`, `reviewer`, `manager`) define the structure. Add:
```json
"proxy-human": {
  "system_prompt": "...(the decision-making instructions from agents/proxy-human.md)...",
  "allowed_tools": ["Read", "Grep", "Glob", "Write"],
  "max_turns": 20,
  "permission_mode": "acceptEdits"
}
```

Read `agents/proxy-human.md` to get the system prompt content. The system prompt should be the core decision-making instructions (the "you are" block and the 5-step evaluation process), not the frontmatter.

**brrr SKILL.md Phase 6a**: Find the Andon routing section (currently references `agent: proxy-human`). Replace with:

```
spawn_session(
  prompt="[Andon Event for proxy-human agent]\n\nArtifact directory: {artifact_dir}\nCycle: {cycle_number}\n\nEvent:\n{andon_event_description}",
  working_dir=artifact_dir,
  role="proxy-human",
  model="claude-opus-4-6",
  timeout=300
)
```

Preserve the fallback path for when spawn_session is unavailable (if one exists in the current spec).

## Complexity

Medium
