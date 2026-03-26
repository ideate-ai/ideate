import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The migration script exports pure functions; import using the .ts extension
// which vitest/tsx resolves correctly in test mode.
import {
  toYaml,
  parseYamlFlowArray,
  buildArtifact,
  parsePrinciples,
  parseWorkItemsYaml,
  runMigration,
  migrateJournal,
  migrateArchiveCycles,
  migratePlanArtifacts,
  migrateSteeringArtifacts,
  migrateInterviews,
  parseInterviewEntries,
  extractSection,
} from "../../../../scripts/migrate-to-v3.js";
import type { MigrationContext } from "../../../../scripts/migrate-to-v3.js";

// ---------------------------------------------------------------------------
// toYaml
// ---------------------------------------------------------------------------

describe("toYaml", () => {
  it("emits flow mapping syntax for multi-key objects in arrays", () => {
    const result = toYaml({ scope: [{ path: "src/foo.ts", op: "modify" }] });
    expect(result).toContain("- {path: src/foo.ts, op: modify}");
  });

  it("emits block scalar for multi-line strings", () => {
    const result = toYaml({ notes: "line one\nline two" });
    expect(result).toContain("notes: |");
    expect(result).toContain("  line one");
  });

  it("emits sequence for array of scalars", () => {
    const result = toYaml({ depends: ["WI-001", "WI-002"] });
    expect(result).toContain("  - WI-001");
    expect(result).toContain("  - WI-002");
  });

  it("emits null for null values", () => {
    const result = toYaml({ field: null });
    expect(result).toContain("field: null");
  });

  it("emits bare number for numeric values", () => {
    const result = toYaml({ count: 42 });
    expect(result).toContain("count: 42");
  });

  it("emits empty array for empty arrays", () => {
    const result = toYaml({ items: [] });
    expect(result).toContain("items: []");
  });

  it("quotes strings that contain colons", () => {
    const result = toYaml({ label: "key: value" });
    expect(result).toContain('"key: value"');
  });

  it("quotes array items with leading whitespace", () => {
    // " indented" has a leading space — must be quoted to produce valid YAML
    const result = toYaml({ items: [" indented"] });
    expect(result).toContain('- " indented"');
  });

  it("quotes array items that are YAML boolean keywords", () => {
    const result = toYaml({ items: ["true"] });
    expect(result).toContain('- "true"');
  });

  it("quotes array items starting with a YAML indicator character", () => {
    const result = toYaml({ items: ["{key: val}"] });
    expect(result).toContain('- "{key: val}"');
  });

  it("quotes array items starting with a digit", () => {
    const result = toYaml({ items: ["123abc"] });
    expect(result).toContain('- "123abc"');
  });

  it("quotes array items containing a tab character", () => {
    const result = toYaml({ items: ["col1\tcol2"] });
    expect(result).toMatch(/- "col1\tcol2"/);
  });
});

// ---------------------------------------------------------------------------
// extractSection
// ---------------------------------------------------------------------------

describe("extractSection", () => {
  it("returns the body of a named section", () => {
    const md = "# Doc\n\n## SectionA\n\nContent here\n\n## SectionB\nOther content";
    expect(extractSection(md, "SectionA")).toBe("Content here");
  });

  it("returns null when section is not present", () => {
    const md = "# Doc\n\n## SectionA\n\nContent here";
    expect(extractSection(md, "Missing")).toBeNull();
  });

  it("returns empty string for section with no body", () => {
    const md = "# Doc\n\n## SectionA\n\n## SectionB\nContent here";
    expect(extractSection(md, "SectionA")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// parseYamlFlowArray
// ---------------------------------------------------------------------------

describe("parseYamlFlowArray", () => {
  it("parses unquoted values", () => {
    expect(parseYamlFlowArray("[foo, bar]")).toEqual(["foo", "bar"]);
  });

  it("parses single-quoted values", () => {
    expect(parseYamlFlowArray("['foo', 'bar']")).toEqual(["foo", "bar"]);
  });

  it("handles empty array", () => {
    expect(parseYamlFlowArray("[]")).toEqual([]);
  });

  it("handles mixed quoting", () => {
    expect(parseYamlFlowArray("[foo, 'bar']")).toEqual(["foo", "bar"]);
  });

  it("handles whitespace around values", () => {
    expect(parseYamlFlowArray("[ foo , bar ]")).toEqual(["foo", "bar"]);
  });
});

// ---------------------------------------------------------------------------
// buildArtifact
// ---------------------------------------------------------------------------

describe("buildArtifact", () => {
  const baseObj = {
    id: "GP-01",
    type: "guiding_principle",
    name: "Test",
    status: "active",
    cycle_created: 1,
    cycle_modified: null,
    file_path: ".ideate/principles/GP-01.yaml",
    content_hash: "",
    token_count: 0,
    description: "Test principle.",
  };

  it("content_hash is deterministic for same input", () => {
    const r1 = buildArtifact(baseObj);
    const r2 = buildArtifact(baseObj);
    expect(r1.content_hash).toBe(r2.content_hash);
    expect(typeof r1.content_hash).toBe("string");
    expect((r1.content_hash as string).length).toBe(64); // SHA-256 hex
  });

  it("token_count is present and non-negative", () => {
    const result = buildArtifact(baseObj);
    expect(typeof result.token_count).toBe("number");
    expect(result.token_count as number).toBeGreaterThanOrEqual(0);
  });

  it("token_count equals floor(canonicalLength / 4)", () => {
    const result = buildArtifact(baseObj);
    // The canonical is the JSON of sorted keys (excluding content_hash/token_count)
    const forHash = { ...baseObj };
    delete (forHash as Record<string, unknown>)["content_hash"];
    delete (forHash as Record<string, unknown>)["token_count"];
    const canonical = JSON.stringify(
      Object.fromEntries(Object.entries(forHash).sort(([a], [b]) => a.localeCompare(b)))
    );
    const expectedTokens = Math.floor(canonical.length / 4);
    expect(result.token_count).toBe(expectedTokens);
  });

  it("content_hash changes when content changes", () => {
    const modified = { ...baseObj, description: "Different description." };
    const r1 = buildArtifact(baseObj);
    const r2 = buildArtifact(modified);
    expect(r1.content_hash).not.toBe(r2.content_hash);
  });

  it("ignores initial content_hash and token_count values when computing hash", () => {
    const withDifferentInitial = { ...baseObj, content_hash: "xyz", token_count: 999 };
    const r1 = buildArtifact(baseObj);
    const r2 = buildArtifact(withDifferentInitial);
    expect(r1.content_hash).toBe(r2.content_hash);
  });

  it("returns an object (not a string)", () => {
    const result = buildArtifact(baseObj);
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parsePrinciples
// ---------------------------------------------------------------------------

describe("parsePrinciples", () => {
  it("parses a single principle section", () => {
    const content = "## 1. Spec Sufficiency\n\nSpecs must be self-contained.\n";
    const results = parsePrinciples(content);
    expect(results).toHaveLength(1);
    const p = results[0];
    expect(p.id).toBe("GP-01");
    expect(p.name).toBe("Spec Sufficiency");
    expect(p.type).toBe("guiding_principle");
    expect(p.status).toBe("active");
  });

  it("parses multiple principle sections", () => {
    const content = [
      "## 1. First Principle",
      "",
      "First description.",
      "",
      "## 2. Second Principle",
      "",
      "Second description.",
    ].join("\n");
    const results = parsePrinciples(content);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("GP-01");
    expect(results[1].id).toBe("GP-02");
    expect(results[0].name).toBe("First Principle");
    expect(results[1].name).toBe("Second Principle");
  });

  it("returns empty array when no sections found", () => {
    const content = "# Guiding Principles\n\nNo sections here.\n";
    expect(parsePrinciples(content)).toEqual([]);
  });

  it("marks deprecated principles correctly", () => {
    const content = "## 1. Old Rule\n\n_Deprecated_ This is no longer relevant.\n";
    const results = parsePrinciples(content);
    expect(results[0].status).toBe("deprecated");
  });

  it("marks amended principles correctly", () => {
    const content = "## 1. Modified Rule\n\n_Amended_ New form.\n";
    const results = parsePrinciples(content);
    expect(results[0].status).toBe("amended");
  });

  it("includes description text (non-blockquote lines)", () => {
    const content = "## 1. Test Principle\n\nThe main description text.\n";
    const results = parsePrinciples(content);
    expect(results[0].description).toBe("The main description text.");
  });

  it("includes file_path in the expected format", () => {
    const content = "## 1. Test\n\nDescription.\n";
    const results = parsePrinciples(content);
    expect(results[0].file_path).toBe(".ideate/principles/GP-01.yaml");
  });
});

// ---------------------------------------------------------------------------
// parseWorkItemsYaml
// ---------------------------------------------------------------------------

describe("parseWorkItemsYaml", () => {
  const minimalYaml = [
    `items:`,
    `  "001":`,
    `    title: Build the Thing`,
    `    complexity: medium`,
    `    status: done`,
    `    depends: ["002"]`,
    `    blocks: []`,
    `    scope:`,
    `      - {path: src/foo.ts, op: create}`,
    `    criteria:`,
    `      - 'The file exists'`,
  ].join("\n");

  it("parses item id correctly", () => {
    const result = parseWorkItemsYaml(minimalYaml);
    expect(Object.keys(result)).toContain("001");
  });

  it("parses title", () => {
    const result = parseWorkItemsYaml(minimalYaml);
    expect(result["001"].title).toBe("Build the Thing");
  });

  it("parses complexity", () => {
    const result = parseWorkItemsYaml(minimalYaml);
    expect(result["001"].complexity).toBe("medium");
  });

  it("parses depends as array", () => {
    const result = parseWorkItemsYaml(minimalYaml);
    expect(result["001"].depends).toEqual(["002"]);
  });

  it("parses blocks as empty array", () => {
    const result = parseWorkItemsYaml(minimalYaml);
    expect(result["001"].blocks).toEqual([]);
  });

  it("parses criteria as array of strings", () => {
    const result = parseWorkItemsYaml(minimalYaml);
    expect(result["001"].criteria).toEqual(["The file exists"]);
  });

  it("parses scope as array of path/op objects", () => {
    const result = parseWorkItemsYaml(minimalYaml);
    expect(result["001"].scope).toEqual([{ path: "src/foo.ts", op: "create" }]);
  });

  it("returns empty object for yaml with no items", () => {
    expect(parseWorkItemsYaml("items: {}\n")).toEqual({});
  });

  it("parses multiple items", () => {
    const twoItems = [
      `items:`,
      `  "001":`,
      `    title: First`,
      `    depends: []`,
      `    blocks: []`,
      `  "002":`,
      `    title: Second`,
      `    depends: ["001"]`,
      `    blocks: []`,
    ].join("\n");
    const result = parseWorkItemsYaml(twoItems);
    expect(Object.keys(result)).toHaveLength(2);
    expect(result["001"].title).toBe("First");
    expect(result["002"].title).toBe("Second");
    expect(result["002"].depends).toEqual(["001"]);
  });
});

// ---------------------------------------------------------------------------
// runMigration dry-run integration test
// ---------------------------------------------------------------------------

describe("dry-run mode", () => {
  let tmpSrc: string;
  let tmpTarget: string;

  beforeEach(() => {
    tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-src-"));
    tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-tgt-"));
  });

  afterEach(() => {
    fs.rmSync(tmpSrc, { recursive: true, force: true });
    fs.rmSync(tmpTarget, { recursive: true, force: true });
  });

  it("writes no files to target when --dry-run is true", () => {
    // Write minimal required files
    fs.mkdirSync(path.join(tmpSrc, "steering"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "steering", "guiding-principles.md"),
      "## 1. Test Principle\n\nDescription.\n"
    );
    fs.mkdirSync(path.join(tmpSrc, "plan"), { recursive: true });
    fs.writeFileSync(path.join(tmpSrc, "plan", "work-items.yaml"), "items: {}\n");
    fs.writeFileSync(path.join(tmpSrc, "journal.md"), "# Journal\n");

    runMigration(tmpSrc, tmpTarget, { dryRun: true, force: false });

    // The .ideate/ directory should NOT have been created
    const ideateDir = path.join(tmpTarget, ".ideate");
    expect(fs.existsSync(ideateDir)).toBe(false);
  });

  it("creates .ideate/ when not in dry-run mode", () => {
    fs.mkdirSync(path.join(tmpSrc, "steering"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "steering", "guiding-principles.md"),
      "## 1. Test Principle\n\nDescription.\n"
    );
    fs.mkdirSync(path.join(tmpSrc, "plan"), { recursive: true });
    fs.writeFileSync(path.join(tmpSrc, "plan", "work-items.yaml"), "items: {}\n");
    fs.writeFileSync(path.join(tmpSrc, "journal.md"), "# Journal\n");

    runMigration(tmpSrc, tmpTarget, { dryRun: false, force: false });

    const ideateDir = path.join(tmpTarget, ".ideate");
    expect(fs.existsSync(ideateDir)).toBe(true);
    expect(fs.existsSync(path.join(ideateDir, "config.json"))).toBe(true);
    expect(fs.existsSync(path.join(ideateDir, "principles", "GP-01.yaml"))).toBe(true);
  });

  it("throws when source directory does not exist", () => {
    expect(() =>
      runMigration("/nonexistent/path", tmpTarget, { dryRun: true, force: false })
    ).toThrow(/does not exist/);
  });

  it("throws when target .ideate/ already exists and force is false", () => {
    fs.mkdirSync(path.join(tmpSrc, "steering"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "steering", "guiding-principles.md"),
      "## 1. Test\n\nDesc.\n"
    );
    fs.mkdirSync(path.join(tmpSrc, "plan"), { recursive: true });
    fs.writeFileSync(path.join(tmpSrc, "plan", "work-items.yaml"), "items: {}\n");
    fs.writeFileSync(path.join(tmpSrc, "journal.md"), "# Journal\n");

    // Run once to create .ideate/
    runMigration(tmpSrc, tmpTarget, { dryRun: false, force: false });

    // Run again without force — should throw
    expect(() =>
      runMigration(tmpSrc, tmpTarget, { dryRun: false, force: false })
    ).toThrow(/already exists/);
  });
});

// ---------------------------------------------------------------------------
// migrateJournal
// ---------------------------------------------------------------------------

describe("migrateJournal", () => {
  let tmpSrc: string;
  let tmpTarget: string;

  beforeEach(() => {
    tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), "journal-src-"));
    tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), "journal-tgt-"));
  });

  afterEach(() => {
    fs.rmSync(tmpSrc, { recursive: true, force: true });
    fs.rmSync(tmpTarget, { recursive: true, force: true });
  });

  it("converts 2 journal entries to YAML files", () => {
    const journalContent = [
      "## [refine] 2026-01-01 — Cycle 1 refinement",
      "Some content.",
      "",
      "## [execute] 2026-01-02 — Work item 001: first item",
      "Status: complete",
    ].join("\n");

    fs.writeFileSync(path.join(tmpSrc, "journal.md"), journalContent, "utf8");

    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    fs.mkdirSync(ideateDir, { recursive: true });
    migrateJournal(ctx);

    // At least 1 cycles directory created
    const cyclesDir = path.join(ideateDir, "cycles");
    expect(fs.existsSync(cyclesDir)).toBe(true);
    const cycleDirs = fs.readdirSync(cyclesDir);
    expect(cycleDirs.length).toBeGreaterThanOrEqual(1);

    // At least 2 YAML files created under all cycles/*/journal/ directories
    let yamlCount = 0;
    for (const cycleDir of cycleDirs) {
      const journalDir = path.join(cyclesDir, cycleDir, "journal");
      if (fs.existsSync(journalDir)) {
        const files = fs.readdirSync(journalDir).filter((f) => f.endsWith(".yaml"));
        yamlCount += files.length;
      }
    }
    expect(yamlCount).toBeGreaterThanOrEqual(2);

    // Each yaml file contains type: journal_entry
    for (const cycleDir of cycleDirs) {
      const journalDir = path.join(cyclesDir, cycleDir, "journal");
      if (fs.existsSync(journalDir)) {
        const files = fs.readdirSync(journalDir).filter((f) => f.endsWith(".yaml"));
        for (const file of files) {
          const content = fs.readFileSync(path.join(journalDir, file), "utf8");
          expect(content).toContain("type: journal_entry");
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// migrateArchiveCycles
// ---------------------------------------------------------------------------

describe("migrateArchiveCycles", () => {
  let tmpSrc: string;
  let tmpTarget: string;

  beforeEach(() => {
    tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), "archive-src-"));
    tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), "archive-tgt-"));
  });

  afterEach(() => {
    fs.rmSync(tmpSrc, { recursive: true, force: true });
    fs.rmSync(tmpTarget, { recursive: true, force: true });
  });

  it("converts a finding heading to a YAML finding object", () => {
    const codeQualityContent = [
      "## Critical Findings",
      "### C1: Some critical issue",
      "- **File**: path/to/file.ts",
      "- **Issue**: Description of the issue",
      "- **Suggested fix**: Fix it",
    ].join("\n");

    const cycle001Dir = path.join(tmpSrc, "archive", "cycles", "001");
    fs.mkdirSync(cycle001Dir, { recursive: true });
    fs.writeFileSync(path.join(cycle001Dir, "code-quality.md"), codeQualityContent, "utf8");

    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    fs.mkdirSync(ideateDir, { recursive: true });
    migrateArchiveCycles(ctx);

    // findings/ directory should exist under cycles/001/
    const findingsDir = path.join(ideateDir, "cycles", "001", "findings");
    expect(fs.existsSync(findingsDir)).toBe(true);

    const findingFiles = fs.readdirSync(findingsDir).filter((f) => f.endsWith(".yaml"));
    expect(findingFiles.length).toBeGreaterThanOrEqual(1);

    // The yaml file should have severity: critical, type: finding, addressed_by: null
    const content = fs.readFileSync(path.join(findingsDir, findingFiles[0]), "utf8");
    expect(content).toContain("severity: critical");
    expect(content).toContain("type: finding");
    expect(content).toContain("addressed_by: null");
  });

  it("extracts verdict from '## Verdict: Pass' line", () => {
    const codeQualityContent = [
      "## Verdict: Pass",
      "",
      "## Critical Findings",
      "### C1: Some critical issue",
      "- **Issue**: Description of the issue",
    ].join("\n");

    const cycle017Dir = path.join(tmpSrc, "archive", "cycles", "017");
    fs.mkdirSync(cycle017Dir, { recursive: true });
    fs.writeFileSync(path.join(cycle017Dir, "code-quality.md"), codeQualityContent, "utf8");

    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    fs.mkdirSync(ideateDir, { recursive: true });
    migrateArchiveCycles(ctx);

    const findingsDir = path.join(ideateDir, "cycles", "017", "findings");
    expect(fs.existsSync(findingsDir)).toBe(true);

    const findingFiles = fs.readdirSync(findingsDir).filter((f) => f.endsWith(".yaml"));
    expect(findingFiles.length).toBeGreaterThanOrEqual(1);

    const content = fs.readFileSync(path.join(findingsDir, findingFiles[0]), "utf8");
    expect(content).toContain("verdict: Pass");
  });

  it("derives work_item as 'cycle-NNN' from the cycle directory number", () => {
    const codeQualityContent = [
      "## Verdict: Pass",
      "",
      "## Critical Findings",
      "### C1: Some critical issue",
      "- **Issue**: Description of the issue",
    ].join("\n");

    const cycle017Dir = path.join(tmpSrc, "archive", "cycles", "017");
    fs.mkdirSync(cycle017Dir, { recursive: true });
    fs.writeFileSync(path.join(cycle017Dir, "code-quality.md"), codeQualityContent, "utf8");

    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    fs.mkdirSync(ideateDir, { recursive: true });
    migrateArchiveCycles(ctx);

    const findingsDir = path.join(ideateDir, "cycles", "017", "findings");
    const findingFiles = fs.readdirSync(findingsDir).filter((f) => f.endsWith(".yaml"));
    expect(findingFiles.length).toBeGreaterThanOrEqual(1);

    const content = fs.readFileSync(path.join(findingsDir, findingFiles[0]), "utf8");
    expect(content).toContain("work_item: cycle-017");
  });

  it("migrates decision-log.md to DL-001.yaml with type: decision_log", () => {
    const decisionLogContent = "# Decision Log\n## D1: Some decision\n\nWe decided to do X.";

    const cycle001Dir = path.join(tmpSrc, "archive", "cycles", "001");
    fs.mkdirSync(cycle001Dir, { recursive: true });
    fs.writeFileSync(path.join(cycle001Dir, "decision-log.md"), decisionLogContent, "utf8");

    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    fs.mkdirSync(ideateDir, { recursive: true });
    migrateArchiveCycles(ctx);

    const outPath = path.join(ideateDir, "cycles", "001", "DL-001.yaml");
    expect(fs.existsSync(outPath)).toBe(true);

    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("type: decision_log");
    expect(content).toContain("cycle: 1");
    expect(content).toContain("id: DL-001");
  });

  it("migrates summary.md to CS-001.yaml with type: cycle_summary", () => {
    const summaryContent = "# Summary\n## Overview\nAll good.";

    const cycle001Dir = path.join(tmpSrc, "archive", "cycles", "001");
    fs.mkdirSync(cycle001Dir, { recursive: true });
    fs.writeFileSync(path.join(cycle001Dir, "summary.md"), summaryContent, "utf8");

    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    fs.mkdirSync(ideateDir, { recursive: true });
    migrateArchiveCycles(ctx);

    const outPath = path.join(ideateDir, "cycles", "001", "CS-001.yaml");
    expect(fs.existsSync(outPath)).toBe(true);

    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("type: cycle_summary");
    expect(content).toContain("cycle: 1");
    expect(content).toContain("id: CS-001");
  });

  it("migrates review-manifest.md to RM-001.yaml with type: review_manifest", () => {
    const manifestContent = "# Review Manifest\n## Work Items\n- WI-154: Pass";

    const cycle001Dir = path.join(tmpSrc, "archive", "cycles", "001");
    fs.mkdirSync(cycle001Dir, { recursive: true });
    fs.writeFileSync(path.join(cycle001Dir, "review-manifest.md"), manifestContent, "utf8");

    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    fs.mkdirSync(ideateDir, { recursive: true });
    migrateArchiveCycles(ctx);

    const outPath = path.join(ideateDir, "cycles", "001", "RM-001.yaml");
    expect(fs.existsSync(outPath)).toBe(true);

    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("type: review_manifest");
    expect(content).toContain("cycle: 1");
    expect(content).toContain("id: RM-001");
  });

  it("migrates incremental review files to findings with FI- prefix and correct work_item", () => {
    const incrementalContent = [
      "## Verdict: Pass",
      "",
      "## Critical Findings",
      "### C1: Some finding",
      "- **File**: src/foo.ts",
      "- **Issue**: Something is wrong",
    ].join("\n");

    const cycle001Dir = path.join(tmpSrc, "archive", "cycles", "001");
    const incrementalDir = path.join(cycle001Dir, "incremental");
    fs.mkdirSync(incrementalDir, { recursive: true });
    fs.writeFileSync(
      path.join(incrementalDir, "154-integrate-drizzle.md"),
      incrementalContent,
      "utf8"
    );

    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    fs.mkdirSync(ideateDir, { recursive: true });
    migrateArchiveCycles(ctx);

    const findingsDir = path.join(ideateDir, "cycles", "001", "findings");
    expect(fs.existsSync(findingsDir)).toBe(true);

    const findingFiles = fs.readdirSync(findingsDir).filter((f) => f.startsWith("FI-"));
    expect(findingFiles.length).toBeGreaterThanOrEqual(1);

    const content = fs.readFileSync(path.join(findingsDir, findingFiles[0]), "utf8");
    expect(content).toContain("type: finding");
    expect(content).toContain("work_item: WI-154");
    expect(content).toContain("reviewer: code-reviewer");
    expect(content).toContain("id: FI-001-001");
    expect(content).toContain("verdict: Pass");
  });

  it("produces both capstone (F-) and incremental (FI-) findings in the same cycle", () => {
    const cycle001Dir = path.join(tmpSrc, "archive", "cycles", "001");
    const incrementalDir = path.join(cycle001Dir, "incremental");
    fs.mkdirSync(incrementalDir, { recursive: true });
    fs.writeFileSync(
      path.join(cycle001Dir, "code-quality.md"),
      "## Verdict: Pass\n\n## Critical Findings\n### C1: Capstone finding\n- Issue: something",
      "utf8"
    );
    fs.writeFileSync(
      path.join(incrementalDir, "160-some-item.md"),
      "## Verdict: Fail\n\n## Significant Findings\n### S1: Incremental finding\n- Issue: another thing",
      "utf8"
    );
    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = { errors: [], created: [], sourceDir: tmpSrc, ideateDir, dryRun: false, force: false };
    fs.mkdirSync(ideateDir, { recursive: true });
    migrateArchiveCycles(ctx);
    const findingsDir = path.join(ideateDir, "cycles", "001", "findings");
    const allFiles = fs.readdirSync(findingsDir);
    expect(allFiles.some((f) => f.startsWith("F-001-"))).toBe(true);
    expect(allFiles.some((f) => f.startsWith("FI-001-"))).toBe(true);
  });

  it("sets work_item to null for incremental filenames without a numeric prefix", () => {
    const cycle001Dir = path.join(tmpSrc, "archive", "cycles", "001");
    const incrementalDir = path.join(cycle001Dir, "incremental");
    fs.mkdirSync(incrementalDir, { recursive: true });
    fs.writeFileSync(
      path.join(incrementalDir, "cycle-017-review.md"),
      "## Verdict: Pass\n\n## Critical Findings\n### C1: Some finding\n- Issue: something",
      "utf8"
    );
    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = { errors: [], created: [], sourceDir: tmpSrc, ideateDir, dryRun: false, force: false };
    fs.mkdirSync(ideateDir, { recursive: true });
    migrateArchiveCycles(ctx);
    const findingsDir = path.join(ideateDir, "cycles", "001", "findings");
    const files = fs.readdirSync(findingsDir).filter((f) => f.startsWith("FI-"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    const content = fs.readFileSync(path.join(findingsDir, files[0]), "utf8");
    expect(content).toContain("work_item: null");
  });

  it("does not write decision-log, summary, review-manifest, or incremental files in dry-run mode", () => {
    const cycle001Dir = path.join(tmpSrc, "archive", "cycles", "001");
    const incrementalDir = path.join(cycle001Dir, "incremental");
    fs.mkdirSync(incrementalDir, { recursive: true });
    fs.writeFileSync(path.join(cycle001Dir, "decision-log.md"), "# Decision Log\n## D1: A decision", "utf8");
    fs.writeFileSync(path.join(cycle001Dir, "summary.md"), "# Summary\nAll good.", "utf8");
    fs.writeFileSync(path.join(cycle001Dir, "review-manifest.md"), "# Manifest\n- WI-154: Pass", "utf8");
    fs.writeFileSync(
      path.join(incrementalDir, "154-integrate-drizzle.md"),
      "## Critical Findings\n### C1: Some finding\n- Issue: something",
      "utf8"
    );

    const ideateDir = path.join(tmpTarget, ".ideate");
    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: true,
      force: false,
    };

    // Don't create ideateDir — dry-run should not need it
    migrateArchiveCycles(ctx);

    // None of these files should exist
    expect(fs.existsSync(path.join(ideateDir, "cycles", "001", "DL-001.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(ideateDir, "cycles", "001", "CS-001.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(ideateDir, "cycles", "001", "RM-001.yaml"))).toBe(false);
    const findingsDir = path.join(ideateDir, "cycles", "001", "findings");
    expect(fs.existsSync(findingsDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// migratePlanArtifacts
// ---------------------------------------------------------------------------

describe("migratePlanArtifacts", () => {
  let tmpSrc: string;
  let tmpTarget: string;

  beforeEach(() => {
    tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), "plan-src-"));
    tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), "plan-tgt-"));
  });

  afterEach(() => {
    fs.rmSync(tmpSrc, { recursive: true, force: true });
    fs.rmSync(tmpTarget, { recursive: true, force: true });
  });

  it("migrates plan/overview.md to .ideate/plan/overview.yaml with type: overview", () => {
    fs.mkdirSync(path.join(tmpSrc, "plan"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "plan", "overview.md"),
      "# Project Overview\n\nThis is the overview.\n"
    );

    const ideateDir = path.join(tmpTarget, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    migratePlanArtifacts(ctx, tmpSrc);

    const outPath = path.join(ideateDir, "plan", "overview.yaml");
    expect(fs.existsSync(outPath)).toBe(true);

    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("type: overview");
    expect(content).toContain("id: overview");
    expect(content).toContain("title: Project Overview");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");
  });

  it("skips plan/overview.md silently when missing", () => {
    // plan/ dir exists but overview.md does not
    fs.mkdirSync(path.join(tmpSrc, "plan"), { recursive: true });

    const ideateDir = path.join(tmpTarget, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    migratePlanArtifacts(ctx, tmpSrc);

    const outPath = path.join(ideateDir, "plan", "overview.yaml");
    expect(fs.existsSync(outPath)).toBe(false);
    // no errors logged
    expect(ctx.errors).toHaveLength(0);
  });

  it("migrates plan/modules/*.md extracting structured fields", () => {
    fs.mkdirSync(path.join(tmpSrc, "plan", "modules"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "plan", "modules", "auth.md"),
      [
        "# Module: Auth",
        "",
        "## Scope",
        "Handles authentication and sessions.",
        "",
        "## Provides",
        "- Token validation",
        "- Session lookup",
        "",
        "## Requires",
        "- Database connection",
        "",
        "## Boundary Rules",
        "- Must not store plaintext credentials",
      ].join("\n")
    );

    const ideateDir = path.join(tmpTarget, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    migratePlanArtifacts(ctx, tmpSrc);

    const outPath = path.join(ideateDir, "plan", "modules", "auth.yaml");
    expect(fs.existsSync(outPath)).toBe(true);

    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("type: module_spec");
    expect(content).toContain("id: module_spec-auth");
    expect(content).toContain("name: Auth");
    expect(content).toContain("scope: Handles authentication and sessions.");
    expect(content).toContain("Token validation");
    expect(content).toContain("Database connection");
    expect(content).toContain("Must not store plaintext credentials");
    expect(content).not.toContain("title:");
    expect(content).not.toContain("\ncontent:");
  });

  it("module spec with missing sections produces empty defaults", () => {
    fs.mkdirSync(path.join(tmpSrc, "plan", "modules"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "plan", "modules", "minimal.md"),
      "# Minimal Module\n\nJust a description.\n"
    );

    const ideateDir = path.join(tmpTarget, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    migratePlanArtifacts(ctx, tmpSrc);

    const content = fs.readFileSync(
      path.join(ideateDir, "plan", "modules", "minimal.yaml"),
      "utf8"
    );
    expect(content).toContain("name: Minimal Module");
    expect(content).toContain('scope: ""');
    expect(content).toContain("provides: []");
    expect(content).toContain("requires: []");
    expect(content).toContain("boundary_rules: []");
  });

  it("does not write files in dry-run mode", () => {
    fs.mkdirSync(path.join(tmpSrc, "plan"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "plan", "overview.md"),
      "# Overview\n\nContent.\n"
    );

    const ideateDir = path.join(tmpTarget, ".ideate");

    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: true,
      force: false,
    };

    migratePlanArtifacts(ctx, tmpSrc);

    expect(fs.existsSync(path.join(ideateDir, "plan", "overview.yaml"))).toBe(false);
    expect(ctx.created).toContain("plan/overview.yaml");
  });
});

// ---------------------------------------------------------------------------
// migrateSteeringArtifacts
// ---------------------------------------------------------------------------

describe("migrateSteeringArtifacts", () => {
  let tmpSrc: string;
  let tmpTarget: string;

  beforeEach(() => {
    tmpSrc = fs.mkdtempSync(path.join(os.tmpdir(), "steering-src-"));
    tmpTarget = fs.mkdtempSync(path.join(os.tmpdir(), "steering-tgt-"));
  });

  afterEach(() => {
    fs.rmSync(tmpSrc, { recursive: true, force: true });
    fs.rmSync(tmpTarget, { recursive: true, force: true });
  });

  it("migrates steering/constraints.md to .ideate/steering/constraints.yaml with type: constraints", () => {
    fs.mkdirSync(path.join(tmpSrc, "steering"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "steering", "constraints.md"),
      "# Constraints\n\nThese are the constraints.\n"
    );

    const ideateDir = path.join(tmpTarget, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    migrateSteeringArtifacts(ctx, tmpSrc);

    const outPath = path.join(ideateDir, "steering", "constraints.yaml");
    expect(fs.existsSync(outPath)).toBe(true);

    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("type: constraints");
    expect(content).toContain("id: constraints");
    expect(content).toContain("title: Constraints");
    expect(content).toContain("content_hash:");
    expect(content).toContain("token_count:");
  });

  it("skips steering/constraints.md silently when missing", () => {
    fs.mkdirSync(path.join(tmpSrc, "steering"), { recursive: true });
    // Do not create constraints.md

    const ideateDir = path.join(tmpTarget, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    migrateSteeringArtifacts(ctx, tmpSrc);

    const outPath = path.join(ideateDir, "steering", "constraints.yaml");
    expect(fs.existsSync(outPath)).toBe(false);
    expect(ctx.errors).toHaveLength(0);
  });

  it("migrates steering/research/*.md with type: research", () => {
    fs.mkdirSync(path.join(tmpSrc, "steering", "research"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "steering", "research", "typescript-options.md"),
      "# TypeScript Options\n\nResearch content here.\n"
    );

    const ideateDir = path.join(tmpTarget, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: false,
      force: false,
    };

    migrateSteeringArtifacts(ctx, tmpSrc);

    const outPath = path.join(ideateDir, "steering", "research", "typescript-options.yaml");
    expect(fs.existsSync(outPath)).toBe(true);

    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("type: research");
    expect(content).toContain("id: research-typescript-options");
  });

  it("does not write files in dry-run mode", () => {
    fs.mkdirSync(path.join(tmpSrc, "steering"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpSrc, "steering", "constraints.md"),
      "# Constraints\n\nContent.\n"
    );
    fs.writeFileSync(
      path.join(tmpSrc, "steering", "guiding-principles.md"),
      "# Guiding Principles\n\nContent.\n"
    );

    const ideateDir = path.join(tmpTarget, ".ideate");

    const ctx: MigrationContext = {
      errors: [],
      created: [],
      sourceDir: tmpSrc,
      ideateDir,
      dryRun: true,
      force: false,
    };

    migrateSteeringArtifacts(ctx, tmpSrc);

    expect(fs.existsSync(path.join(ideateDir, "steering", "constraints.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(ideateDir, "steering", "guiding-principles.yaml"))).toBe(false);
    expect(ctx.created).toContain("steering/constraints.yaml");
    expect(ctx.created).toContain("steering/guiding-principles.yaml");
  });
});

// ---------------------------------------------------------------------------
// migrateInterviews
// ---------------------------------------------------------------------------

function makeDirs(): { srcDir: string; tgtDir: string; ctx: MigrationContext } {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "interviews-src-"));
  const tgtDir = fs.mkdtempSync(path.join(os.tmpdir(), "interviews-tgt-"));
  const ideateDir = path.join(tgtDir, ".ideate");
  fs.mkdirSync(ideateDir, { recursive: true });
  const ctx: MigrationContext = {
    errors: [],
    created: [],
    sourceDir: srcDir,
    ideateDir,
    dryRun: false,
    force: false,
  };
  return { srcDir, tgtDir, ctx };
}

describe("migrateInterviews", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates steering/interviews/**/*.md files (non-_full)", () => {
    const { srcDir, tgtDir, ctx } = makeDirs();
    cleanupDirs.push(srcDir, tgtDir);
    // Create fixture: steering/interviews/refine-001/_general.md
    const interviewsDir = path.join(srcDir, "steering", "interviews", "refine-001");
    fs.mkdirSync(interviewsDir, { recursive: true });
    fs.writeFileSync(path.join(interviewsDir, "_general.md"), "# Refine 001 Interview\n\nContent here.", "utf8");
    migrateInterviews(ctx, srcDir);
    // Should create .ideate/interviews/refine-001/_general.yaml
    const outPath = path.join(ctx.ideateDir, "interviews", "refine-001", "_general.yaml");
    expect(fs.existsSync(outPath)).toBe(true);
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("type: interview");
    expect(content).toContain("id: interviews/refine-001/_general");
    expect(content).toContain("cycle: 1");
  });

  it("skips _full.md files (compiled transcripts)", () => {
    const { srcDir, tgtDir, ctx } = makeDirs();
    cleanupDirs.push(srcDir, tgtDir);
    const interviewsDir = path.join(srcDir, "steering", "interviews", "refine-001");
    fs.mkdirSync(interviewsDir, { recursive: true });
    fs.writeFileSync(path.join(interviewsDir, "_full.md"), "# Full transcript\n\nContent.", "utf8");
    migrateInterviews(ctx, srcDir);
    const outPath = path.join(ctx.ideateDir, "interviews", "refine-001", "_full.yaml");
    expect(fs.existsSync(outPath)).toBe(false);
    expect(ctx.created).toHaveLength(0);
  });

  it("does not write files in dry-run mode", () => {
    const { srcDir, tgtDir, ctx: rawCtx } = makeDirs();
    cleanupDirs.push(srcDir, tgtDir);
    const ctx = { ...rawCtx, dryRun: true };
    const interviewsDir = path.join(srcDir, "steering", "interviews", "refine-001");
    fs.mkdirSync(interviewsDir, { recursive: true });
    fs.writeFileSync(path.join(interviewsDir, "_general.md"), "Content.", "utf8");
    migrateInterviews(ctx, srcDir);
    expect(ctx.created).toHaveLength(1);
    // No file should exist on disk
    const outPath = path.join(ctx.ideateDir, "interviews", "refine-001", "_general.yaml");
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("returns without error when no interview files exist", () => {
    const { srcDir, tgtDir, ctx } = makeDirs();
    cleanupDirs.push(srcDir, tgtDir);
    expect(() => migrateInterviews(ctx, srcDir)).not.toThrow();
    expect(ctx.created).toHaveLength(0);
  });

  it("migrates legacy steering/interview.md", () => {
    const { srcDir, tgtDir, ctx } = makeDirs();
    cleanupDirs.push(srcDir, tgtDir);
    const steeringDir = path.join(srcDir, "steering");
    fs.mkdirSync(steeringDir, { recursive: true });
    fs.writeFileSync(path.join(steeringDir, "interview.md"), "# Planning Interview\n\nLegacy content.", "utf8");
    migrateInterviews(ctx, srcDir);
    const outPath = path.join(ctx.ideateDir, "interviews", "legacy.yaml");
    expect(fs.existsSync(outPath)).toBe(true);
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("type: interview");
    expect(content).toContain("id: interviews/legacy");
  });

  it("produces entries array in YAML output for files with Q/A blocks", () => {
    const { srcDir, tgtDir, ctx } = makeDirs();
    cleanupDirs.push(srcDir, tgtDir);
    const interviewsDir = path.join(srcDir, "steering", "interviews", "refine-022");
    fs.mkdirSync(interviewsDir, { recursive: true });
    const qaContent = [
      "**Q: What is the scope?**",
      "A: Tackle all phases.",
      "",
      "**Q: Schema approach?**",
      "A: Class table inheritance.",
    ].join("\n");
    fs.writeFileSync(path.join(interviewsDir, "_general.md"), qaContent, "utf8");
    migrateInterviews(ctx, srcDir);
    const outPath = path.join(ctx.ideateDir, "interviews", "refine-022", "_general.yaml");
    expect(fs.existsSync(outPath)).toBe(true);
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("entries:");
    expect(content).toContain("IQ-022-001");
    expect(content).toContain("IQ-022-002");
  });
});

// ---------------------------------------------------------------------------
// parseInterviewEntries
// ---------------------------------------------------------------------------

describe("parseInterviewEntries", () => {
  it("returns empty array for content with no Q/A blocks", () => {
    const entries = parseInterviewEntries("# Some markdown\n\nNo questions here.", "001");
    expect(entries).toHaveLength(0);
  });

  it("parses a single Q/A block", () => {
    const content = "**Q: What is the scope?**\nA: Tackle all phases.";
    const entries = parseInterviewEntries(content, "022");
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("IQ-022-001");
    expect(entries[0].question).toBe("What is the scope?");
    expect(entries[0].answer).toBe("Tackle all phases.");
    expect(entries[0].domain).toBeNull();
    expect(entries[0].seq).toBe(1);
  });

  it("parses multiple Q/A blocks with sequential IDs", () => {
    const content = [
      "**Q: First question?**",
      "A: First answer.",
      "",
      "**Q: Second question?**",
      "A: Second answer.",
    ].join("\n");
    const entries = parseInterviewEntries(content, "018");
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe("IQ-018-001");
    expect(entries[0].seq).toBe(1);
    expect(entries[1].id).toBe("IQ-018-002");
    expect(entries[1].seq).toBe(2);
  });

  it("uses the provided idPrefix in generated IDs", () => {
    const content = "**Q: Question?**\nA: Answer.";
    const entries = parseInterviewEntries(content, "legacy");
    expect(entries[0].id).toBe("IQ-legacy-001");
  });

  it("sets domain to null for all entries (migration doesn't infer domain)", () => {
    const content = "**Q: Domain question?**\nA: Some answer.";
    const entries = parseInterviewEntries(content, "001");
    expect(entries[0].domain).toBeNull();
  });
});
