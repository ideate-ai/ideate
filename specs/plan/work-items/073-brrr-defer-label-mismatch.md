# Work Item 073: Fix DEFERRED/DEFER Label Mismatch in brrr

## Objective
Change the string comparison in `skills/brrr/SKILL.md` from `DEFERRED` to `DEFER` to match the proxy-human agent output contract, ensuring proxy-human deferrals are correctly captured in brrr's deferred items list.

## Acceptance Criteria

1. [ ] `skills/brrr/SKILL.md` line 317 checks for the string `DEFER` (not `DEFERRED`)
2. [ ] All other references to the deferral state in brrr SKILL.md use consistent `DEFER` spelling
3. [ ] `agents/proxy-human.md` and `skills/brrr/SKILL.md` use identical spelling for the deferral decision value
4. [ ] Phase 9 activity report correctly counts and displays deferred items from proxy-human decisions
5. [ ] The fix is verified by code inspection (no runtime test needed — single string literal change)

## File Scope

**Modify:**
- `skills/brrr/SKILL.md` (line 317 — change `DEFERRED` to `DEFER`)

**Read for verification:**
- `agents/proxy-human.md` (line 90 — confirm output contract uses `DEFER`)

## Dependencies

- **Blocked by:** None
- **Blocks:** None (can run in parallel with WI-072)

## Implementation Notes

Current code at `skills/brrr/SKILL.md:317`:
```markdown
if (decision === "DEFERRED") {
  deferredItems.push(...)
}
```

Change to:
```markdown
if (decision === "DEFER") {
  deferredItems.push(...)
}
```

Cross-reference with `agents/proxy-human.md:90`:
```markdown
Output: Decision: {PROCEED | DEFER | ESCALATE}
```

The values must match exactly. This is a one-line fix.

**Additional cleanup (optional within scope):**
- While editing brrr SKILL.md, also fix the fallback entry heading format for proxy-human-log.md (minor finding M4 from cycle 001)
- Standardize confidence level case to uppercase in proxy-human.md if inconsistent (minor finding M3)

These are optional one-line fixes that can be included if convenient, or deferred to a future cycle.

## Complexity

Trivial — single string literal change, no logic modification, verified by cross-reference.
