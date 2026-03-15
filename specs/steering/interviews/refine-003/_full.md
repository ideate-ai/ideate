# Refinement Interview — 2026-03-13

**Context**: User request to add artifact schema versioning. Ideate has had 2 breaking schema changes to date (both handled with ad-hoc migration scripts). The user wants a version marker in every artifact directory so future schema migrations can be named and versioned (v1→v2, v2→v3) and applied non-destructively.

---

**Q: What's driving this refinement?**
A: Two prior breaking changes due to scaling concerns — steering docs grew too large and token-intensive, forcing structural changes. The existing ad-hoc migration scripts will be removed. Going forward, the user wants a version marker in each artifact directory.

**Q: What specifically should be versioned? Artifact directory schema, skill behavior, or both?**
A: Artifact directory schema only. Skills don't need migration or quality gates yet — that's a potential future addition.

**Q: Where should the version marker live, and in what format?**
A: A `manifest.json` file in the artifact directory root. Default suggestion of `{"schema_version": 1}` accepted.

**Q: Starting version number — v1 (fresh start) or v3 (to reflect 2 prior migrations)?**
A: Not explicitly decided — user's framing ("for this iteration, just a manifest file") indicates fresh start. Current schema is v1.

**Q: Should skills enforce the version at invocation time (refuse/warn if mismatched)?**
A: No enforcement for this iteration. The manifest is informational only — read by migration scripts, not by skills.
