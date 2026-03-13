# Work Item 057: Update brrr to Use Agent Tool for Proxy-Human

## Objective

Remove brrr's dependency on spawn_session for invoking proxy-human. brrr should use the native Agent tool to invoke proxy-human as a subagent within the same session. This removes the MCP dependency for Andon decision-making.

## Acceptance Criteria

1. `skills/brrr/SKILL.md` Phase 6a uses the Agent tool to invoke proxy-human, not spawn_session
2. The Agent tool invocation specifies `agent: "proxy-human"` with appropriate prompt and model
3. No MCP tool calls remain in the proxy-human invocation path
4. The fallback path (when Agent tool unavailable) still exists and is documented

## File Scope

- modify: `skills/brrr/SKILL.md`

## Dependencies

None.

## Implementation Notes

Current brrr Phase 6a invokes proxy-human via:
```
spawn_session(
  role="proxy-human",
  model="claude-opus-4-6",
  ...
)
```

Replace with Agent tool invocation:
```
Agent tool with:
  subagent_type: "proxy-human"
  model: "claude-opus-4-6"
  prompt: [Andon event context]
```

The Agent tool is native to Claude Code and doesn't require MCP. The proxy-human agent definition (`agents/proxy-human.md`) remains in ideate.

## Complexity

Low