# Refine Interview — Cycle 026 (General)

**Date**: 2026-03-25
**Context**: Pre-release refinement for v3.0. Four changes driven by user decisions about how ideate should work going forward.

**Q: Should the ideate MCP artifact server be optional or required?**
A: Required. It's an intrinsic part of v3. Ideate cannot function without it due to PPR-based retrieval. MCP availability checks should still apply to *other* MCP servers and tools (external skills, commands, agents). The intention is that ideate identifies tools which can enhance its ability to produce work — the artifact server is not one of those optional enhancements, it's core infrastructure.

**Q: Should all acceptance criteria be machine-verifiable?**
A: No. Some topics are fundamentally subjective — aesthetics are personal opinion. In those cases, use human-in-the-loop verification. Identify the best way to validate and go with it. Subjective details can be agreed upon during planning, then validated objectively against the spec that documents the agreement. Example: get approval for an aesthetic choice, then validate against the spec which defines it.

**Q: Should we update documentation?**
A: Yes. Create ARCHITECTURE.md for deep technical content. README stays high-level usage. Documentation should be current and detailed.

**Q: Should we audit skills and agents for principle adherence?**
A: Yes. The recent policy and principal changes warrant a change in how skills decide things. The audit should produce findings that drive subsequent work items via mid-cycle decomposition.

**Q: One cycle with mid-cycle decomposition, or two cycles?**
A: One cycle. WI-201 (audit) produces findings, which become WI-202+ work items in the same cycle.

**Q: Remove outpost references?**
A: Yes. Remove references to outpost. P-14 ("no MCP servers in ideate") is already violated and should be rewritten.
