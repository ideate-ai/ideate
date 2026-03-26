# Review Summary — Cycle 027

## Overview
Cycle 027 implemented 6 features (16 work items): build-on-startup, init skill, telemetry schema, reporting scripts, SDLC hooks, and v2 cleanup. All new source files exist, TypeScript builds cleanly, all report scripts are executable. The hook emission system is wired across all skills. Three agent definition files retain stale `archive/incremental/` paths — the only significant finding.

## Significant Findings
- [spec-reviewer] `agents/journal-keeper.md` references `archive/incremental/review-manifest.md` and `archive/incremental/` paths (lines 20, 66) — should use `.ideate/cycles/{NNN}/` canonical paths per P-19. Relates to: P-19, WI-207 scope gap.
- [spec-reviewer] `agents/gap-analyst.md` references `archive/incremental/` (line 24) — should use `.ideate/cycles/{NNN}/findings/` per P-19. Relates to: P-19.
- [spec-reviewer] `agents/spec-reviewer.md` references `archive/incremental/` (line 26) — should use `.ideate/cycles/{NNN}/findings/` per P-19. Relates to: P-19.

## Minor Findings
- [code-reviewer] The `ideate_get_metrics` tool reads from the `metrics_events` extension table, but the extended columns (input_tokens, output_tokens, etc.) are only populated when YAML files with those fields exist in `.ideate/`. Currently no skill writes YAML metrics files — metrics go to `metrics.jsonl` only. The tool will return empty aggregates until the pipeline writes structured YAML metrics. Relates to: WI-212/213 integration gap.
- [gap-analyst] No tests exist for `tools/metrics.ts` or `tools/events.ts`. The hooks system has 27 tests in `hooks.test.ts`, but the MCP tool wrappers are untested. Relates to: WI-213, WI-219.

## Suggestions
- [code-reviewer] The `.mcp.json` uses `"env": {"CLAUDE_PLUGIN_ROOT": "."}` as a fallback. This resolves the dev-environment warning but may cause issues if the MCP server is started from a different working directory. Consider using `__dirname` resolution in start.sh instead.
- [gap-analyst] The `ideate_get_metrics` tool would be more useful if it could also read from `metrics.jsonl` (the actual metrics file) rather than only from the SQLite table. The research recommended Option 1 (jsonl first) → Option 2 (table later).

## Findings Requiring User Input
None — all findings can be resolved from existing context.

## Proposed Refinement Plan
Three agent files need path updates (journal-keeper.md, gap-analyst.md, spec-reviewer.md). This is a 1 work item fix — same pattern as the prior `archive/incremental/` cleanup in WI-206. Can be addressed immediately or in the next cycle.
