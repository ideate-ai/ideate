---
## Refinement Interview — 2026-03-22

**Context**: Post-convergence refinement following brrr session (5 cycles, WI-102 through WI-116). Triggered by observation that ideate misses obvious quality mistakes in reviewed projects — specifically, code reviewers perform only static analysis and never verify that the project still builds or runs after a work item completes.

---

**Q: What specific change do you want to make?**

A: In code projects, ideate often misses obvious mistakes in testing. The in-cycle review fails to actually run the program to see if it will start up under nominal conditions. Finishing a work item that breaks an app is a fundamental requirement miss, not a small mistake.

**Q: Should this be a hard requirement (mandatory test execution steps) or guidance?**

A: Not a hard requirement — this kind of testing can take many forms. Provide better guidance in the prompts to understand how the app should be used and use a mix of static and dynamic testing strategies.

**Q: What does the healthy balance look like between excessive review overhead and never breaking an app?**

A: The purpose of ideate is to automate project iteration cycles in the same manner that humans do — domain driven design, parallel workstreams, incremental quality validation including Andon for critical mistakes. Finishing a work item which breaks an app is a fundamental requirement miss and isn't a small mistake. Bugs happen and there is room for error, but egregious mistakes (app can't run) are unacceptable. The balance: never leave the codebase unable to start after a completed work item, but don't run the full test suite on every single incremental review.

---

**Agreed design:**

- **Incremental review (per WI)**: Discover the project's testing model (README, package.json, Makefile, etc.). Smoke test — verify the project still builds or starts. Run tests targeted to the changed files. If startup fails → Critical finding → Andon.
- **Capstone review (per cycle)**: Run the full test suite. Dynamic validation appropriate to the project type.
- **Scope**: Guidance in the code-reviewer agent definition and in the spawn prompts (which set incremental vs. comprehensive scope).

**Scope boundary**: Only `agents/code-reviewer.md`, incremental reviewer spawn prompts in `skills/execute/SKILL.md` and `skills/brrr/phases/execute.md`, and capstone reviewer spawn prompts in `skills/review/SKILL.md` and `skills/brrr/phases/review.md`. No changes to steering, architecture, or other agents.
