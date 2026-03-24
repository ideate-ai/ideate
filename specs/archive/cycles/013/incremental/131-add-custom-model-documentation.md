## Verdict: Pass

All acceptance criteria satisfied after rework. The "Custom Models" section documents model tiers, version pinning, Ollama endpoint configuration, minimum model requirements, and known limitations with example configuration blocks.

## Critical Findings

None.

## Significant Findings

### S1: Known Limitations description inverted `settings.json` precedence direction (FIXED)

- **File**: `README.md:782`
- **Issue**: Original text implied `settings.json` was expected to override shell env vars. The actual bug is that `settings.json` entries are silently dropped regardless of shell state.
- **Impact**: Users relying exclusively on `settings.json` would be told the wrong thing when diagnosing failures.
- **Resolution**: Rewritten to accurately describe the bug. Added second GitHub issue reference (#13827).

## Minor Findings

### M1: Second GitHub issue omitted (FIXED)

- **File**: `README.md:782`
- **Issue**: Research identified two active issues (#8500, #13827) but only #8500 was cited.
- **Resolution**: Added #13827 alongside #8500 in the citation.

## Unmet Acceptance Criteria

None (after rework).
