# Change Plan — Cycle 027

**Trigger**: Pre-release v3.0 feature expansion — 6 feature areas plus v2 cleanup.

**What is changing**:

1. **Build on first startup** (WI-208) — start.sh runs npm run build on first startup per version. dist/ gitignored. No more shipping compiled artifacts.

2. **Init skill** (WI-209, 210, 211) — New `/ideate:init` skill for existing codebases. Scaffolds `.ideate/`, runs architect survey, lightweight interview, bootstraps domain layer. Separate from plan (which is greenfield).

3. **Telemetry + PPR metrics** (WI-212, 213, 214) — Extended metrics schema capturing context artifact IDs, outcome, finding counts, cache hit rates. New `ideate_get_metrics` MCP tool for aggregated analysis. Skills instrumented to capture extended fields. Driven by research at `steering/research/ppr-telemetry-metrics.md`.

4. **Reporting** (WI-215, 216, 217, 223) — Three report scripts: cycle quality trends, cost analysis, executive summary. README updated with documentation.

5. **SDLC hooks** (WI-218, 219, 220) — Event system matching Claude Code hook API pattern. Supports command (shell) and prompt (LLM) hook types. 7 SDLC events. Hook dispatcher + `ideate_emit_event` MCP tool. Skills emit events at key points.

6. **v2 cleanup** (WI-221, 222) — Architecture.md refresh (outpost refs, stale sections, source index). Open domain questions resolved.

**What is NOT changing**: Core SDLC workflow, existing MCP tools (11 tools preserved), schema v1 (additive changes only for metrics), existing agent definitions (except architect init mode).

**Scope boundary**: 16 work items (WI-208–223). Touches skills/, agents/architect.md, mcp/artifact-server/, scripts/, .gitignore, CLAUDE.md, README.md, plugin manifest, specs/plan/architecture.md, specs/domains/.

**Note**: Skills still write to `specs/` paths during this cycle. The user will run a final migration to `.ideate/` and retire `specs/` after confirming v3 is fully functional.
