# Incremental Review: WI-134 — Scoring Rubric Definition

**File reviewed**: `benchmarks/rubric.yaml`
**Reviewer**: claude-sonnet-4-6
**Date**: 2026-03-22

---

## Verdict: Fail

Two acceptance criteria are not met: the exact term "error handling style" does not appear in any descriptor, and "question relevance" does not appear in any descriptor text (only in the `description` metadata field).

---

## Critical Findings

None.

---

## Significant Findings

None.

---

## Minor Findings

### M1: "error handling style" not referenced in `code_idiomaticity` descriptors

- **File**: `benchmarks/rubric.yaml:103–151`
- **Issue**: The acceptance criterion requires `code_idiomaticity` to reference "language conventions, framework patterns, naming, error handling style". The first three terms appear. The phrase "error handling style" does not appear anywhere in the file. The descriptors discuss error handling substantively (lines 111–113, 121–123, 129–131, 138–141, 147–151) but never use the specific compound term "error handling style".
- **Suggested fix**: Add the phrase "error handling style" explicitly in at least one descriptor, for example in the score 1 descriptor: "…and error handling style is either absent or foreign to the language…"

### M2: "question relevance" not referenced in `human_engagement_appropriateness` descriptors

- **File**: `benchmarks/rubric.yaml:210–261`
- **Issue**: The acceptance criterion requires `human_engagement_appropriateness` to reference "question relevance, question count, info gathered vs burden". The phrase "question relevance" appears only in the `description` metadata field (line 211), not in any descriptor. "Question count" appears in all five descriptors. The info-gathered-vs-burden concept appears in descriptors at lines 230 and 248 ("ratio of information gathered to human burden", "information-to-burden ratio"). The score 1, 3, 4, and 5 descriptors address relevance conceptually (e.g., "irrelevant to the actual decision space", "generally relevant") but the compound phrase "question relevance" is absent.
- **Suggested fix**: Add the phrase "question relevance" explicitly in at least one descriptor, for example in the score 3 descriptor: "Question relevance is high — questions target genuine decision points…"

### M3: `cost_tokens` has an undocumented `fields` key

- **File**: `benchmarks/rubric.yaml:23–25`
- **Issue**: `cost_tokens` includes a `fields` key (`input_tokens`, `output_tokens`) that no other quantitative dimension has and that is not part of the spec's required schema (`name`, `description`, `unit`, `direction`). This creates an inconsistency in the quantitative schema.
- **Suggested fix**: Either document the `fields` key in a comment explaining its purpose and apply it consistently to dimensions that have sub-fields, or remove it if it is not consumed by the benchmark runner.

---

## Unmet Acceptance Criteria

- [ ] **code_idiomaticity refs: language conventions, framework patterns, naming, error handling style** — The exact term "error handling style" does not appear in any descriptor. See M1.
- [ ] **human_engagement refs: question relevance, question count, info gathered vs burden** — The exact phrase "question relevance" does not appear in any descriptor text. See M2.

---

## Spot-Check Results

**Descriptor word counts**: All 20 descriptors (5 per qualitative dimension × 4 dimensions) were verified. The minimum count observed was 54 words (architecture_quality score 4). All descriptors substantially exceed the 20-word minimum. Criterion satisfied.

**Required term presence** (spot-checked two dimensions):

| Dimension | Required term | Present in descriptors? |
|---|---|---|
| `architecture_quality` | component separation | Yes (lines 58, 67, 76, 85, 94) |
| `architecture_quality` | interface clarity | Yes (lines 62, 86) |
| `architecture_quality` | dependency direction | Yes (line 60) |
| `architecture_quality` | scalability | Yes (lines 63, 98) |
| `code_idiomaticity` | language conventions | Yes (lines 109, 118) |
| `code_idiomaticity` | framework patterns | Yes (lines 110, 120, 128, 137, 146) |
| `code_idiomaticity` | naming | Yes (lines 109, 119, 128, 136, 145) |
| `code_idiomaticity` | error handling style | **No** — phrase absent from all descriptors |
| `human_engagement_appropriateness` | question relevance | **No** — phrase absent from all descriptors |
| `human_engagement_appropriateness` | question count | Yes (lines 218, 227, 237, 246, 257) |
| `human_engagement_appropriateness` | info gathered vs burden | Yes (lines 230, 248) |
