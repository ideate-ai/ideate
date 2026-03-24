## Refinement Interview — 2026-03-22 (General)

**Context**: Benchmarking system for measuring ideate's code quality output.

**Q: What to measure?**
A: Cost, time, autonomy, architecture quality, code quality/idiomaticity, problem anticipation, human engagement appropriateness. Mix of objective and subjective.

**Q: Benchmark projects?**
A: Multiple categories — greenfield app, contribute to existing codebase, fix defect, refactor. TypeScript and Python.

**Q: Evaluation model?**
A: LLM-as-judge with human evaluation mode for alignment/calibration. Both use same rubric.

**Q: Infrastructure?**
A: `benchmarks/` in ideate repo. Shell script runner using `claude -p`. Benchmark cases opaque to executing LLMs. Pre-scripted Q&A for reproducibility.

**Q: Principles?**
A: All unchanged.
