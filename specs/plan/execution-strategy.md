# Execution Strategy — Cycle 027

## Mode
Batched parallel — 4 dependency layers.

## Parallelism
Max concurrent workers: 6
Worktrees: enabled
Review cadence: incremental review per item

## Work Item Groups

### Group 1 (parallel — no dependencies)
- WI-208: Build on first MCP startup + gitignore dist/
- WI-209: Init skill definition
- WI-210: Plugin manifest + CLAUDE.md updates for init
- WI-212: Telemetry metrics schema extension
- WI-215: Cycle reporting script
- WI-216: Cost reporting script
- WI-217: Executive reporting script
- WI-218: SDLC hooks config schema + dispatcher
- WI-221: Architecture.md refresh
- WI-222: Resolve open domain questions

### Group 2 (depends on Group 1 items)
- WI-211: Architect agent init mode (depends on 209)
- WI-213: ideate_get_metrics MCP tool (depends on 212)
- WI-214: Skill telemetry instrumentation (depends on 212)
- WI-219: ideate_emit_event MCP tool (depends on 218)
- WI-223: README docs for report scripts (depends on 215, 216, 217)

### Group 3 (depends on Group 2)
- WI-220: Skill integration for hook events (depends on 219)

### Manual pause: User runs final migration script, confirms .ideate/ is source of truth, retires specs/

## Dependency Graph

```
208
209 → 211
210
212 → 213
212 → 214
215 ─┐
216 ─┼─ 223
217 ─┘
218 → 219 → 220
221
222
```

## Agent Configuration
- Workers: sonnet
- Incremental reviewers: sonnet
- WI-209 (init skill): may warrant opus for skill prompt writing quality — user discretion
