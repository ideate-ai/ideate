# Server Migration Fixes

**Date**: 2026-04-03
**Author**: WI-584
**Addresses**: T-01, T-03, T-04 from migration-triage.md
**Expected outcome**: Migration error count drops from 714 to <30

---

## Background

Running the YAML-to-Neo4j migration against `ideate/.ideate/` with the current server code produces 714 errors. The breakdown from `migration-diagnostic-report.md`:

| Category | Errors | Root cause |
|---|---|---|
| Nullable `cycle_created`/`cycle_modified` fields | 598 (84%) | Zod rejects `null` on these fields |
| Unregistered artifact types | 6 (<1%) | TYPE_TO_LABEL_MAP missing entries |
| Non-artifact files treated as errors | 7 (1%) | Discovery does not skip `autopilot-state.yaml` etc. |
| YAML parse failures (malformed files) | 103 (14%) | Source data issues — out of scope for this spec |

Fixes 1-3 below address the server-side root causes. After applying them, the only remaining errors should be the ~22 YAML parse failures caused by malformed source files in the ideate repo itself — those are data cleanup work (D-01 in migration-triage.md), not server bugs.

---

## Fix 1: Nullable `cycle_created`/`cycle_modified` fields in Zod schema

### What to change

In `BaseArtifactSchema`, the `cycle_created` and `cycle_modified` fields must accept `null` as a valid value. Many artifacts (constraints, guiding principles, research findings, interview files, and others that predate cycle tracking) have these fields set to `null` in YAML. The current schema rejects them.

**File**: `ideate-server/src/migration/parser.ts`

**Current code** (lines 59-60):

```typescript
cycle_created: z.union([z.string(), z.number()]).optional(),
cycle_modified: z.union([z.string(), z.number()]).optional(),
```

**Change to**:

```typescript
cycle_created: z.number().nullable().optional(),
cycle_modified: z.number().nullable().optional(),
```

**Rationale for the type narrowing**: The diagnostic confirmed that all non-null `cycle_created`/`cycle_modified` values in the YAML corpus are integers (cycle numbers such as `1`, `12`, `42`). No artifact uses a string value for these fields. Narrowing from `z.union([z.string(), z.number()])` to `z.number()` is therefore safe and matches the intended schema. The `.nullable()` allows `null`. The `.optional()` allows the field to be absent entirely.

### Test to write first

Add to `ideate-server/tests/unit/discovery-parser.test.ts` in the `parseArtifactFromString — valid YAML` describe block:

```typescript
it("accepts cycle_created and cycle_modified as null", () => {
  const yaml = `
id: C-001
type: constraint
title: Must use TypeScript
cycle_created: null
cycle_modified: null
`;
  const result = parseArtifactFromString(yaml, "/fake/C-001.yaml");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.artifact.parsed["cycle_created"]).toBeNull();
  expect(result.artifact.parsed["cycle_modified"]).toBeNull();
});

it("accepts cycle_created and cycle_modified as integers", () => {
  const yaml = `
id: GP-042
type: guiding_principle
title: Favor composition
cycle_created: 3
cycle_modified: 12
`;
  const result = parseArtifactFromString(yaml, "/fake/GP-042.yaml");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.artifact.parsed["cycle_created"]).toBe(3);
  expect(result.artifact.parsed["cycle_modified"]).toBe(12);
});

it("accepts an artifact where cycle_created and cycle_modified are absent", () => {
  const yaml = `
id: DP-001
type: domain_policy
title: Some policy
`;
  const result = parseArtifactFromString(yaml, "/fake/DP-001.yaml");
  expect(result.ok).toBe(true);
});
```

### Expected result after fix

- 598 previously-failing artifacts now pass validation.
- All constraints, guiding principles, research findings, and other non-cycle-scoped artifacts with `null` cycle fields are accepted.
- The three test cases above pass (red before the fix, green after).

---

## Fix 2: Add missing artifact types to `TYPE_TO_LABEL_MAP`

### What to change

Five artifact types used in cycle-scoped review output YAML files are not registered in the type map. The parser rejects them with `Unknown artifact type: "full_audit"` etc. All five should map to the `Document` Neo4j label, consistent with the existing Document subtypes pattern.

**File**: `ideate-server/src/services/id-generator.ts`

**Location**: The `TYPE_TO_LABEL_MAP` constant (line 24). The existing Document-subtype block ends at line 82:

```typescript
  DOMAIN_INDEX: { label: "Document", prefix: "DOC", cycleScoped: false },
};
```

**Add these entries before the closing `};`**:

```typescript
  FULL_AUDIT: { label: "Document", prefix: "DOC", cycleScoped: true },
  FULL_AUDIT_SUMMARY: { label: "Document", prefix: "DOC", cycleScoped: true },
  CODE_QUALITY: { label: "Document", prefix: "DOC", cycleScoped: true },
  DECISION_LOG: { label: "Document", prefix: "DOC", cycleScoped: true },
  GAP_ANALYSIS: { label: "Document", prefix: "DOC", cycleScoped: true },
```

**Note on key naming**: Keys in `TYPE_TO_LABEL_MAP` are `UPPER_SNAKE_CASE` versions of the YAML `type` field. The YAML files use hyphenated types (`code-quality`, `decision-log`, `gap-analysis`) and underscored types (`full_audit`, `full_audit_summary`). The transformer converts type values with `toUpperSnakeCase()` which calls `.toUpperCase()` — this converts `code-quality` to `CODE-QUALITY`, not `CODE_QUALITY`. See the note in "Additional parser fix" below.

**Also update `KNOWN_TYPES` in parser.ts** to accept these types during parse-time validation:

**File**: `ideate-server/src/migration/parser.ts`

**Location**: The `KNOWN_TYPES` set (lines 17-45).

**Add these entries**:

```typescript
  "full_audit",
  "full_audit_summary",
  "code-quality",
  "decision-log",
  "gap-analysis",
```

**Also update the writer's `labelForType` function**:

**File**: `ideate-server/src/migration/writer.ts`

**Location**: The `labelForType` function (lines 85-116). Add entries in the `map` object:

```typescript
    full_audit: "Document",
    full_audit_summary: "Document",
    "code-quality": "Document",
    "decision-log": "Document",
    "gap-analysis": "Document",
```

### Test to write first

Add to `ideate-server/tests/unit/discovery-parser.test.ts`:

```typescript
describe("parseArtifactFromString — unregistered review output types", () => {
  const reviewOutputTypes = [
    "full_audit",
    "full_audit_summary",
    "code-quality",
    "decision-log",
    "gap-analysis",
  ];

  for (const artifactType of reviewOutputTypes) {
    it(`accepts type "${artifactType}"`, () => {
      const yaml = `
id: DOC-test-${artifactType}
type: ${artifactType}
`;
      const result = parseArtifactFromString(yaml, `/fake/${artifactType}.yaml`);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        // Print error message on failure to ease diagnosis
        console.error(result.error);
        return;
      }
      expect(result.artifact.artifactType).toBe(artifactType);
    });
  }
});
```

### Expected result after fix

- 6 previously-failing artifacts are accepted by the parser.
- All five types resolve to the `Document` label in the writer.
- All five test cases above pass (red before the fix, green after).

---

## Fix 3: Skip non-artifact files during discovery

### What to change

Several files in `.ideate/` are configuration or runtime state files, not YAML artifacts. The discovery phase currently attempts to parse them and logs 7 errors when they fail. These files should be silently skipped.

The specific file confirmed in the diagnostic report is `autopilot-state.yaml`. The pattern likely extends to any YAML file at the root of `.ideate/` that is not an artifact, including any future state files.

**File**: `ideate-server/src/migration/discovery.ts`

**Approach**: Add an explicit skip list of filenames (not paths, just basenames) that should be excluded from discovery. Check this list in `discoverArtifacts` (or inside `collectYamlFiles`) after enumerating files.

**Add a constant near the top of the file, after the imports**:

```typescript
/**
 * YAML files at any depth under .ideate/ that are NOT artifact files.
 * These are configuration or runtime state files and should be silently
 * skipped rather than parsed and counted as errors.
 */
const SKIP_FILENAMES = new Set([
  "autopilot-state.yaml",
  "config.yaml",
]);
```

**Modify `collectYamlFiles`** to filter skipped filenames:

```typescript
} else if (entry.isFile()) {
  const ext = path.extname(entry.name).toLowerCase();
  if ((ext === ".yaml" || ext === ".yml") && !SKIP_FILENAMES.has(entry.name)) {
    results.push(fullPath);
  }
}
```

### Test to write first

Add to `ideate-server/tests/unit/discovery-parser.test.ts` in the `discoverArtifacts` describe block (the block that uses a temp directory):

```typescript
it("skips autopilot-state.yaml and config.yaml during discovery", async () => {
  // Create a minimal .ideate/ tree with one real artifact and two skip-listed files
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ideate-skip-test-"));
  try {
    const workItemsDir = path.join(tempDir, "work-items");
    await fs.mkdir(workItemsDir);

    // A real artifact that should be discovered
    await fs.writeFile(
      path.join(workItemsDir, "WI-001.yaml"),
      "id: WI-001\ntype: work_item\ntitle: Test\n",
    );

    // Non-artifact files that should be skipped
    await fs.writeFile(
      path.join(tempDir, "autopilot-state.yaml"),
      "active: false\n",
    );
    await fs.writeFile(
      path.join(tempDir, "config.yaml"),
      "version: 1\n",
    );

    const discovered = await discoverArtifacts(tempDir);
    const names = discovered.map((f) => path.basename(f.filePath));

    expect(names).toContain("WI-001.yaml");
    expect(names).not.toContain("autopilot-state.yaml");
    expect(names).not.toContain("config.yaml");
    expect(discovered).toHaveLength(1);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
```

### Expected result after fix

- `autopilot-state.yaml` and `config.yaml` are no longer enumerated by `discoverArtifacts`.
- The 7 "Missing required field: type" errors from these files disappear from migration output.
- The test above passes (red before the fix, green after).

---

## Verification: Re-run migration after all three fixes

After applying Fixes 1, 2, and 3, re-run the full migration against `ideate/.ideate/`:

```bash
cd ideate-server
npm run migrate -- migrate \
  --source /Users/dan/code/ideate/.ideate \
  --neo4j-uri bolt://localhost:7687 \
  --neo4j-user neo4j \
  --neo4j-password <password> \
  --org-id ideate \
  --codebase-id ideate
```

### Acceptance criteria for the verification run

| Metric | Baseline (pre-fix) | Target (post-fix) |
|---|---|---|
| Total errors | 714 | <30 |
| Parse errors (YAML malformed) | 84 | ~84 (unchanged — data cleanup required separately) |
| Validation errors | 630 | <10 |
| Nodes written | 1573 | >2100 |
| Edges written | 551 | >1100 |

**Error target explanation**: The remaining ~22 errors after these fixes will be YAML parse failures in early finding files (Category 2 in the diagnostic report — bad indentation in cycles 1-5 F-*.yaml files). These require data cleanup in the ideate repo (WI D-01), not server fixes. The target of <30 provides buffer for any additional minor parse issues.

**Node recovery**: Fix 1 recovers 598 nodes (the artifacts that previously failed nullable field validation). Adding interview expansion nodes, the expected post-fix node count is approximately 2100-2200.

**Edge recovery**: Most of the 826 missing edges (1377 transformed - 551 written = 826) were missing because their target nodes were not in Neo4j. Recovering 598 nodes will make most of those target nodes available, recovering the majority of missing edges.

### Document recovered counts

After the verification run completes, record the following in this section:

```
Post-fix run date: ___________
Nodes written:     ___________  (was 1573)
Edges written:     ___________  (was 551)
Total errors:      ___________  (was 714)
```

---

## File scope summary

| File | Change |
|---|---|
| `ideate-server/src/migration/parser.ts` | `BaseArtifactSchema`: change `cycle_created`/`cycle_modified` to `z.number().nullable().optional()`; add 5 new types to `KNOWN_TYPES` |
| `ideate-server/src/services/id-generator.ts` | `TYPE_TO_LABEL_MAP`: add 5 new Document-subtype entries |
| `ideate-server/src/migration/writer.ts` | `labelForType`: add 5 new type-to-label mappings |
| `ideate-server/src/migration/discovery.ts` | `SKIP_FILENAMES` constant + filter in `collectYamlFiles` |
| `ideate-server/tests/unit/discovery-parser.test.ts` | New test cases for Fixes 1, 2, and 3 |
