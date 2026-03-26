# Refine Interview — Cycle 027 (General)

**Date**: 2026-03-25
**Context**: Large pre-release v3.0 feature cycle. Six feature areas plus v2 cleanup. Testing ideate's ability to handle large cycles ("eat our own dogfood").

**Q: What changes do you want to make?**
A: Six areas: (1) Fix specs/ vs .ideate/ defect in skill validation — skills still check for markdown files. (2) Plan vs refine discussion — decided to keep separate, add init skill for existing codebases. (3) Telemetry for PPR weight tuning — research-driven metrics design for quality and cost optimization. (4) Build on first MCP startup — npm run build + gitignore dist/. (5) Reporting — cycle metrics, cost analysis, executive summaries as scripts. (6) SDLC hooks for external integrations matching Claude Code's hook API pattern (command + prompt types).

**Q: Should specs/ be retired?**
A: Yes. User will run final migration manually after confirming .ideate/ is fully functional. Skills must write through MCP tools. specs/ stays until confirmed, then one last migration + delete.

**Q: Plan vs refine — merge or keep separate?**
A: Keep separate. Plan is greenfield (no code exists). Init + refine covers existing codebases. Three entry points: plan (new project), init (existing code, no .ideate/), refine (existing .ideate/).

**Q: What are the core objectives for telemetry?**
A: Quality > cost > speed > human intervention. "Oneshot" planning — plan output should be good enough that execute passes review with zero rework. First-pass acceptance rate is the key metric. Context utilization (what was provided vs what was cited) is the key PPR tuning signal.

**Q: What kind of reporting?**
A: Scripts (not skills) that generate formatted reports. Cycle quality trends, cost analysis, executive summaries. Eye candy that shows ROI. Real-time status readable via /btw during execution. The human persona should feel in control and powerful.

**Q: What hook pattern?**
A: Match Claude Code's hook API — command (shell script) and prompt (LLM call) types. Agnostic hooks firing on SDLC events. Can be used for Jira tickets, Slack messages, etc. .ideate/hooks.json config.

**Q: Build on first startup — rebuild frequency?**
A: Once per version. Plugin cache is per-version. Use a version marker file. Don't ship built artifacts — dist/ should be gitignored.

**Q: Should the final migration be automated?**
A: No. Manual step. User runs the script, confirms, then proceeds. This is a pause point in execution.
