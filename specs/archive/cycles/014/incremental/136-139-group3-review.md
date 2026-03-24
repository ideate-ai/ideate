## Verdict: Fail

Three of four work items have significant problems: the ts-fix-defect source file contains a spoiling comment that reveals the root cause, the qa-scripts for ts-fix-defect and py-refactor fall below the minimum response count requirements, and the ts-fix-defect config is missing the expected_work_items fields present in the template and the other three cases.

## Critical Findings

None.

## Significant Findings

### S1: paginate.ts comment reveals the root cause to the agent

- **File**: `benchmarks/cases/ts-fix-defect/src/paginate.ts:22-28`
- **Issue**: The WI-137 acceptance criterion states the brief describes the symptom without revealing the root cause. The brief satisfies this — it only describes the duplicate-item symptom. However, the source file that is copied into the agent's workspace (`src/` is included per config-schema.yaml line 23) contains a 7-line block comment directly above the bug that names the exact faulty line (`start = (page - 1) * pageSize + (page > 1 ? 1 : 0)`) and provides a step-by-step explanation of why it is wrong. Any agent that reads the source file will have the root cause handed to it, making the "symptom without root cause" design intent void.
- **Impact**: The benchmark stops measuring whether the agent can diagnose the bug and becomes a transcription exercise. All runs on this case will score artificially high on defect-diagnosis quality dimensions.
- **Suggested fix**: Replace the long explanatory comment with a neutral one that does not name the fault. For example:
  ```ts
  // Page-size validation was added in a previous commit; the boundary
  // behaviour changed as a side effect.
  const start = (page - 1) * pageSize + (page > 1 ? 1 : 0);
  ```
  The incorrect arithmetic stays; only the explanation is removed.

### S2: ts-fix-defect qa-script has only 4 responses — below the WI-137 minimum of 4+

- **File**: `benchmarks/cases/ts-fix-defect/qa-script.yaml`
- **Issue**: WI-137 specifies the qa-script must have 8+ responses for ts-rest-api and 4+ for ts-fix-defect. The file has exactly 4 entries. "4+" conventionally means more than 4 (i.e., at least 5). If the spec means "at least 4" the count is borderline; if it means "more than 4" the file fails. Either way, covering only priority, testing, scope, and regression leaves common planning-phase questions unanswered: there is no entry for language/tooling, project structure, timeline, or success criteria. The fallback_answer handles unmatched questions but this is a thin coverage.
- **Impact**: Interview questions outside those four topics will all receive the generic fallback, making the agent's planning inputs less deterministic and reproducible than the other cases.
- **Suggested fix**: Add at least two more entries covering predictable topics. Minimal additions:
  ```yaml
  - keywords: ["language", "typescript", "framework", "tooling"]
    answer: "TypeScript only. The test suite uses vitest. No new runtime dependencies."
    priority: 10

  - keywords: ["success", "done", "criteria", "complete", "what does"]
    answer: "The bug is fixed, all existing tests pass, and at least one new test exercises the exact-boundary case."
    priority: 10
  ```

### S3: ts-fix-defect config.yaml is missing expected_work_items fields

- **File**: `benchmarks/cases/ts-fix-defect/config.yaml`
- **Issue**: The template (config.yaml lines 22-23) includes `expected_work_items_min` and `expected_work_items_max`. Both ts-rest-api and py-cli-tool set these fields. ts-fix-defect and py-refactor omit them entirely. The evaluate script and judge prompt use these bounds to assess whether the produced plan is appropriately scoped. Without them, the evaluator has no lower or upper bound signal for these two cases.
- **Impact**: The evaluator cannot flag an over-engineered 15-work-item plan or an under-specified 1-item plan for a fix-defect case. This weakens the quantitative scoring for these cases.
- **Suggested fix**: Add to `benchmarks/cases/ts-fix-defect/config.yaml`:
  ```yaml
  expected_work_items_min: 1
  expected_work_items_max: 3
  ```
  And to `benchmarks/cases/py-refactor/config.yaml`:
  ```yaml
  expected_work_items_min: 4
  expected_work_items_max: 8
  ```

## Minor Findings

### M1: py-refactor qa-script has only 6 responses — thin for an 8+ criterion

- **File**: `benchmarks/cases/py-refactor/qa-script.yaml`
- **Issue**: WI-138 requires py-refactor qa-script to have 4+ responses; it has 6, which satisfies the letter of the spec. However, common planning-phase questions for a refactor case — naming conventions, file structure, how to handle the Flask api.py, what to do with the `do_thing` mystery method — have no matching entry. The fallback is "Use sensible defaults appropriate for a Python refactoring task," which is too generic for questions about which files to touch. This is below the quality bar set by the other cases even if it satisfies the count.
- **Suggested fix**: Add entries for: (a) the Flask API wrapper and whether it is in scope, (b) the mystery `do_thing` method, (c) naming expectations.

### M2: Bug comment in paginate.ts uses first person and contains false reasoning

- **File**: `benchmarks/cases/ts-fix-defect/src/paginate.ts:22-25`
- **Issue**: The comment says "BUG: start uses a <= comparison instead of <, causing the start index to be bumped up by one when (page - 1) * pageSize equals total exactly — which never actually happens at start". This reasoning is incorrect: the actual bug is the ternary `(page > 1 ? 1 : 0)` appended to start, not a <= comparison. The comment describes a fictitious <= comparison that does not appear in the code. A developer reading the comment and the code simultaneously will encounter contradictory information.
- **Suggested fix**: Addressed by fixing S1 (removing the explanatory comment). If any comment is kept, it must accurately describe what the code actually does.

### M3: ts-fix-defect src contains only 4 TypeScript files, below the 3-8 range midpoint but within spec

- **File**: `benchmarks/cases/ts-fix-defect/src/` (index.ts, paginate.ts, paginate.test.ts, types.ts)
- **Issue**: WI-137 requires 3-8 TypeScript files with a deliberate bug. There are 4 files (including the test), which is within the stated range. However, the range implies a realistic-looking codebase. With only one logic file and one type file the agent sees minimal context to explore. This is borderline rather than a violation, but the src directory does not feel like "an existing codebase" — it looks like a stripped library with no real surrounding code.
- **Suggested fix**: Add one or two plausible supporting files (e.g., a thin client module that calls `paginate`, or a config file) to make the codebase feel like a real project rather than an isolated utility. This would also provide richer material for the agent to reason about scope.

### M4: py-refactor god class is 268 lines but spread across a single file with a module-level function

- **File**: `benchmarks/cases/py-refactor/src/processor.py`
- **Issue**: The WI-138 criterion states the file must contain a 200+ line god class. processor.py is 268 lines total; the `DataProcessor` class body spans lines 13-250 (approximately 237 lines of class content), with `do_summary` as a module-level function at lines 253-268. The 200+ line god class criterion is met. No finding on the count — this is a confirmation note.
- **Suggested fix**: None required on the line count. Noted here for traceability.

## Unmet Acceptance Criteria

- [ ] **WI-137**: ts-fix-defect brief describes symptom without revealing root cause — The brief itself is clean, but `src/paginate.ts` (copied into the workspace per config-schema.yaml) contains a detailed multi-line comment (lines 22-28) that explicitly identifies the faulty expression and explains the mechanism. The net effect is that the root cause is revealed to the agent.

- [ ] **WI-137**: ts-fix-defect qa-script has 4+ responses — The file has exactly 4 entries. If "4+" means more than 4 this criterion is unmet. If it means at least 4, it is met with no margin. Either way the coverage is insufficient relative to the other cases and the stated design intent of deterministic interview responses.

- [ ] **WI-137/138**: ts-fix-defect and py-refactor config.yaml files include expected_work_items bounds — Neither file contains `expected_work_items_min` or `expected_work_items_max`, which are present in the template and in the two greenfield cases.
