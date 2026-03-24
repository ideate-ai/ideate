## Refinement Interview — 2026-03-22

**Context**: Requirement evolution — user wants a benchmarking system to continuously measure and improve ideate's ability to produce quality code.

**Q: What aspect of quality matters most? Regression detection, model comparison, workflow effectiveness?**
A: Continuously improve ideate's ability to create quality code. Benchmarks measuring output based on qualitative and quantitative measurements. Non-exhaustive list: cost to run, time to run, ability to run without intervention, ability to plan and design sound architecture, ability to write clean idiomatic code, ability to anticipate design problems, ability to know when to engage humans for critical decisions.

**Q: Benchmark projects — repeatable test cases or evaluation against real projects?**
A: Detailed set of benchmark projects — contributing to a codebase, creating a single app of medium to large size, fixing a defect, etc.

**Q: Who judges qualitative dimensions — LLM-as-judge, human, proxy metrics, hybrid?**
A: Mix of objective and subjective measurements.

**Q: LLM-as-judge with human evaluation mode?**
A: Yes. The LLM-as-judge needs a mode where a human can also evaluate. Need tooling to ensure proper alignment between LLM and human scores.

**Q: Language scope for v1?**
A: TypeScript and Python — the two most common languages used daily.

**Q: Where does this live?**
A: `benchmarks/` directory in ideate.

**Q: Execution model?**
A: A shell script to run `claude -p`.

**Q: Principles still hold?**
A: Yes.

**Q: Opacity and Q&A scripting?**
A: Benchmark cases must be opaque to the LLMs and agents doing the work — don't pollute context. Also need Q&A-style guidance for the human operator to answer questions ideate might ask during planning/refinement. Must be consistent in answers across runs.
