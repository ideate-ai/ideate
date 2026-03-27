import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { createSchema } from "../schema.js";
import { rebuildIndex, detectCycles, indexFiles, removeFiles, MAX_DEPENDENCY_NODES, MAX_DEPENDENCY_EDGES } from "../indexer.js";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-indexer-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a fresh in-memory DB with schema applied */
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  createSchema(db);
  return db;
}

/**
 * Set up a minimal .ideate/ directory structure under baseDir.
 * Returns the path to the .ideate/ directory.
 */
function makeIdeateDir(baseDir: string): string {
  const ideateDir = path.join(baseDir, ".ideate");
  const subdirs = [
    "work-items",
    "principles",
    "constraints",
    "policies",
    "decisions",
    "questions",
    "modules",
    "research",
    "interviews",
    "cycles",
  ];
  for (const sub of subdirs) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }
  return ideateDir;
}

/** Write a YAML file under the given directory */
function writeYaml(dir: string, filename: string, content: string): string {
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

/** Minimal work item YAML */
function minimalWorkItem(overrides: Record<string, unknown> = {}): string {
  const defaults: Record<string, unknown> = {
    id: "WI-001",
    type: "work_item",
    title: "Test work item",
    status: "pending",
    complexity: "small",
    cycle_created: 1,
    cycle_modified: null,
    depends: [],
    blocks: [],
    criteria: [],
    scope: [],
    content_hash: "",
    token_count: 0,
    file_path: "",
  };
  const merged = { ...defaults, ...overrides };
  // Hand-roll YAML for predictable output (avoids circular dep on yaml lib in tests)
  const lines: string[] = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v === null) {
      lines.push(`${k}: null`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${k}: []`);
      } else {
        lines.push(`${k}:`);
        for (const item of v) {
          if (typeof item === "object" && item !== null) {
            // Use block mapping syntax for objects in arrays:
            //   - key1: val1
            //     key2: val2
            const entries = Object.entries(item as Record<string, unknown>);
            const [firstKey, firstVal] = entries[0];
            lines.push(`  - ${firstKey}: ${firstVal}`);
            for (const [ik, iv] of entries.slice(1)) {
              lines.push(`    ${ik}: ${iv}`);
            }
          } else {
            lines.push(`  - ${item}`);
          }
        }
      }
    } else if (typeof v === "string") {
      lines.push(`${k}: "${v}"`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// rebuildIndex tests
// ---------------------------------------------------------------------------

describe("rebuildIndex — empty directory", () => {
  it("returns zero stats for empty .ideate/ dir", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const stats = rebuildIndex(db, drizzle(db),ideateDir);
    expect(stats.files_scanned).toBe(0);
    expect(stats.files_updated).toBe(0);
    expect(stats.files_deleted).toBe(0);
    expect(stats.edges_created).toBe(0);
    expect(stats.cycles_detected).toEqual([]);
  });
});

describe("rebuildIndex — work item YAML → table populated", () => {
  it("inserts a work item row with correct title", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem({ id: "WI-001", title: "Test work item" })
    );

    rebuildIndex(db, drizzle(db),ideateDir);

    const row = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-001'")
      .get() as { id: string; title: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.title).toBe("Test work item");
  });
});

describe("rebuildIndex — depends edge extracted", () => {
  it("creates a depends_on edge from WI-002 to WI-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    writeYaml(wiDir, "WI-001.yaml", minimalWorkItem({ id: "WI-001" }));
    writeYaml(
      wiDir,
      "WI-002.yaml",
      minimalWorkItem({ id: "WI-002", title: "Second item", depends: ["WI-001"] })
    );

    rebuildIndex(db, drizzle(db),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-002' AND target_id = 'WI-001' AND edge_type = 'depends_on'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.source_id).toBe("WI-002");
    expect(edge!.target_id).toBe("WI-001");
    expect(edge!.edge_type).toBe("depends_on");
  });
});

describe("rebuildIndex — incremental skip for unchanged file", () => {
  it("returns files_updated: 0 on second call with same content", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem()
    );

    rebuildIndex(db, drizzle(db),ideateDir);
    const stats2 = rebuildIndex(db, drizzle(db),ideateDir);

    expect(stats2.files_updated).toBe(0);
  });
});

describe("rebuildIndex — incremental update for changed file", () => {
  it("updates the row and returns files_updated: 1 after content change", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiPath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem({ title: "Original title" })
    );

    rebuildIndex(db, drizzle(db),ideateDir);

    // Overwrite with new content
    fs.writeFileSync(wiPath, minimalWorkItem({ title: "Updated title" }), "utf8");

    const stats2 = rebuildIndex(db, drizzle(db),ideateDir);

    expect(stats2.files_updated).toBe(1);

    const row = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-001'")
      .get() as { title: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.title).toBe("Updated title");
  });
});

describe("rebuildIndex — stale row deletion", () => {
  it("removes the row when the YAML file is deleted", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiPath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem()
    );

    rebuildIndex(db, drizzle(db),ideateDir);

    // Confirm it was inserted
    const before = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-001'")
      .get();
    expect(before).toBeDefined();

    // Delete the file and rebuild
    fs.unlinkSync(wiPath);
    rebuildIndex(db, drizzle(db),ideateDir);

    const after = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-001'")
      .get();
    expect(after).toBeUndefined();
  });
});

describe("rebuildIndex — node_file_refs from scope", () => {
  it("inserts a node_file_refs row for each scope entry path", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-001.yaml",
      minimalWorkItem({
        scope: [{ path: "src/foo.ts", op: "modify" }],
      })
    );

    rebuildIndex(db, drizzle(db),ideateDir);

    const ref = db
      .prepare(
        `SELECT * FROM node_file_refs WHERE node_id = 'WI-001' AND file_path = 'src/foo.ts'`
      )
      .get() as { node_id: string; file_path: string } | undefined;
    expect(ref).toBeDefined();
    expect(ref!.node_id).toBe("WI-001");
    expect(ref!.file_path).toBe("src/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — files_failed for malformed YAML
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// rebuildIndex — edge extraction tests per auto-extracted edge type
// ---------------------------------------------------------------------------

describe("rebuildIndex — blocks edge extracted", () => {
  it("creates a blocks edge from WI-002 to WI-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    writeYaml(wiDir, "WI-001.yaml", minimalWorkItem({ id: "WI-001" }));
    writeYaml(
      wiDir,
      "WI-002.yaml",
      minimalWorkItem({ id: "WI-002", title: "Blocker item", blocks: ["WI-001"] })
    );

    rebuildIndex(db, drizzle(db),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-002' AND target_id = 'WI-001' AND edge_type = 'blocks'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("blocks");
  });
});

describe("rebuildIndex — belongs_to_module edge extracted", () => {
  it("creates a belongs_to_module edge from WI-001 to MOD-core", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    writeYaml(
      wiDir,
      "WI-001.yaml",
      minimalWorkItem({ id: "WI-001", module: "MOD-core" })
    );

    rebuildIndex(db, drizzle(db),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-001' AND target_id = 'MOD-core' AND edge_type = 'belongs_to_module'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("belongs_to_module");
  });
});

describe("rebuildIndex — belongs_to_domain edge extracted", () => {
  it("creates a belongs_to_domain edge from WI-001 to workflow", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const wiDir = path.join(ideateDir, "work-items");

    writeYaml(
      wiDir,
      "WI-001.yaml",
      minimalWorkItem({ id: "WI-001", domain: "workflow" })
    );

    rebuildIndex(db, drizzle(db),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'WI-001' AND target_id = 'workflow' AND edge_type = 'belongs_to_domain'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("belongs_to_domain");
  });
});

describe("rebuildIndex — derived_from edge extracted", () => {
  it("creates a derived_from edge from DP-001 to GP-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const policiesDir = path.join(ideateDir, "policies");

    const yaml = [
      `id: "DP-001"`,
      `type: "domain_policy"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `derived_from:`,
      `  - "GP-001"`,
      `established: "2026-01-01"`,
      `amended: null`,
      `amended_by: null`,
      `description: "Test policy"`,
    ].join("\n") + "\n";

    writeYaml(policiesDir, "DP-001.yaml", yaml);

    rebuildIndex(db, drizzle(db),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'DP-001' AND target_id = 'GP-001' AND edge_type = 'derived_from'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("derived_from");
  });
});

describe("rebuildIndex — relates_to edge extracted", () => {
  it("creates a relates_to edge from FIND-001 to WI-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const archiveDir = path.join(ideateDir, "cycles");

    const yaml = [
      `id: "FIND-001"`,
      `type: "finding"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "open"`,
      `severity: "minor"`,
      `work_item: "WI-001"`,
      `file_refs: []`,
      `verdict: "fail"`,
      `cycle: 1`,
      `reviewer: "test-reviewer"`,
      `addressed_by: null`,
    ].join("\n") + "\n";

    writeYaml(archiveDir, "FIND-001.yaml", yaml);

    rebuildIndex(db, drizzle(db),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'FIND-001' AND target_id = 'WI-001' AND edge_type = 'relates_to'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("relates_to");
  });
});

describe("rebuildIndex — supersedes edge extracted", () => {
  it("creates a supersedes edge from DD-002 to DD-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const decisionsDir = path.join(ideateDir, "decisions");

    const yaml = [
      `id: "DD-002"`,
      `type: "domain_decision"`,
      `cycle_created: 2`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `domain: "workflow"`,
      `cycle: 2`,
      `supersedes: "DD-001"`,
      `description: "Updated decision"`,
      `rationale: "Because reasons"`,
    ].join("\n") + "\n";

    writeYaml(decisionsDir, "DD-002.yaml", yaml);

    rebuildIndex(db, drizzle(db),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'DD-002' AND target_id = 'DD-001' AND edge_type = 'supersedes'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("supersedes");
  });
});

describe("rebuildIndex — addressed_by edge extracted", () => {
  it("creates an addressed_by edge from FIND-002 to WI-001", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const archiveDir = path.join(ideateDir, "cycles");

    const yaml = [
      `id: "FIND-002"`,
      `type: "finding"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "resolved"`,
      `severity: "significant"`,
      `work_item: "WI-001"`,
      `file_refs: []`,
      `verdict: "fail"`,
      `cycle: 1`,
      `reviewer: "test-reviewer"`,
      `addressed_by: "WI-001"`,
    ].join("\n") + "\n";

    writeYaml(archiveDir, "FIND-002.yaml", yaml);

    rebuildIndex(db, drizzle(db),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'FIND-002' AND target_id = 'WI-001' AND edge_type = 'addressed_by'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("addressed_by");
  });
});

describe("rebuildIndex — amended_by edge extracted", () => {
  it("creates an amended_by edge from DP-001 to DP-002", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const policiesDir = path.join(ideateDir, "policies");

    const yaml = [
      `id: "DP-001"`,
      `type: "domain_policy"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "amended"`,
      `domain: "workflow"`,
      `derived_from: []`,
      `established: "2026-01-01"`,
      `amended: "2026-02-01"`,
      `amended_by: "DP-002"`,
      `description: "Original policy"`,
    ].join("\n") + "\n";

    writeYaml(policiesDir, "DP-001.yaml", yaml);

    rebuildIndex(db, drizzle(db),ideateDir);

    const edge = db
      .prepare(
        `SELECT * FROM edges WHERE source_id = 'DP-001' AND target_id = 'DP-002' AND edge_type = 'amended_by'`
      )
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.edge_type).toBe("amended_by");
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — interview entries create interview_question nodes
// ---------------------------------------------------------------------------

describe("rebuildIndex — interview entries create interview_question nodes", () => {
  it("creates one interview_question node per entry and references edges", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const interviewsDir = path.join(ideateDir, "interviews");
    fs.mkdirSync(interviewsDir, { recursive: true });

    const yaml = [
      `id: "INT-022"`,
      `type: "interview"`,
      `cycle_created: 22`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `title: "Refine 022"`,
      `cycle: 22`,
      `content: null`,
      `entries:`,
      `  - id: IQ-022-001`,
      `    question: "What is the scope?"`,
      `    answer: "Tackle all phases."`,
      `    domain: null`,
      `    seq: 1`,
      `  - id: IQ-022-002`,
      `    question: "Schema approach?"`,
      `    answer: "Class table inheritance."`,
      `    domain: artifact-structure`,
      `    seq: 2`,
    ].join("\n") + "\n";

    writeYaml(interviewsDir, "INT-022.yaml", yaml);

    const stats = rebuildIndex(db, drizzle(db), ideateDir);

    // Parent interview node should be indexed
    const interviewNode = db
      .prepare(`SELECT * FROM nodes WHERE id = 'INT-022' AND type = 'interview'`)
      .get() as { id: string; type: string } | undefined;
    expect(interviewNode).toBeDefined();

    // Both interview_question nodes should exist
    const q1 = db
      .prepare(`SELECT * FROM interview_questions WHERE id = 'IQ-022-001'`)
      .get() as { id: string; interview_id: string; question: string; seq: number } | undefined;
    expect(q1).toBeDefined();
    expect(q1!.interview_id).toBe("INT-022");
    expect(q1!.question).toBe("What is the scope?");
    expect(q1!.seq).toBe(1);

    const q2 = db
      .prepare(`SELECT * FROM interview_questions WHERE id = 'IQ-022-002'`)
      .get() as { id: string; interview_id: string; domain: string | null; seq: number } | undefined;
    expect(q2).toBeDefined();
    expect(q2!.interview_id).toBe("INT-022");
    expect(q2!.domain).toBe("artifact-structure");
    expect(q2!.seq).toBe(2);

    // Both question nodes should have references edges pointing to parent interview
    const edge1 = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'IQ-022-001' AND target_id = 'INT-022' AND edge_type = 'references'`)
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge1).toBeDefined();

    const edge2 = db
      .prepare(`SELECT * FROM edges WHERE source_id = 'IQ-022-002' AND target_id = 'INT-022' AND edge_type = 'references'`)
      .get() as { source_id: string; target_id: string; edge_type: string } | undefined;
    expect(edge2).toBeDefined();

    // No parse errors
    expect(stats.parse_errors.filter((e) => e.includes("INT-022"))).toHaveLength(0);
  });

  it("interview without entries array still indexes as interview with no question nodes", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const interviewsDir = path.join(ideateDir, "interviews");
    fs.mkdirSync(interviewsDir, { recursive: true });

    const yaml = [
      `id: "INT-001"`,
      `type: "interview"`,
      `cycle_created: 1`,
      `cycle_modified: null`,
      `content_hash: ""`,
      `token_count: 0`,
      `file_path: ""`,
      `status: "active"`,
      `title: "Legacy interview"`,
      `cycle: 1`,
      `content: "Some raw content"`,
    ].join("\n") + "\n";

    writeYaml(interviewsDir, "INT-001.yaml", yaml);

    const stats = rebuildIndex(db, drizzle(db), ideateDir);

    const interviewNode = db
      .prepare(`SELECT * FROM nodes WHERE id = 'INT-001'`)
      .get() as { id: string } | undefined;
    expect(interviewNode).toBeDefined();

    const questionCount = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM interview_questions WHERE interview_id = 'INT-001'`)
        .get() as { cnt: number }
    ).cnt;
    expect(questionCount).toBe(0);

    expect(stats.parse_errors.filter((e) => e.includes("INT-001"))).toHaveLength(0);
  });
});

describe("rebuildIndex — malformed YAML file", () => {
  it("reports files_failed and parse_errors for invalid YAML", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    writeYaml(ideateDir, "bad.yaml", "{ invalid yaml: [unclosed");

    const stats = rebuildIndex(db, drizzle(db),ideateDir);

    expect(stats.files_failed).toBeGreaterThanOrEqual(1);
    expect(stats.parse_errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// detectCycles tests
// ---------------------------------------------------------------------------

describe("detectCycles — no cycles", () => {
  it("returns [] on empty DB", () => {
    const db = freshDb();
    expect(detectCycles(drizzle(db))).toEqual([]);
  });

  it("returns [] for a simple A→B→C DAG", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    insert.run("A", "B");
    insert.run("B", "C");
    db.pragma("foreign_keys = ON");
    expect(detectCycles(drizzle(db))).toEqual([]);
  });
});

describe("detectCycles — simple 2-node cycle", () => {
  it("detects A→B, B→A cycle and returns both nodes", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    insert.run("A", "B");
    insert.run("B", "A");
    db.pragma("foreign_keys = ON");

    const cycles = detectCycles(drizzle(db));
    expect(cycles.length).toBeGreaterThan(0);

    const allNodes = cycles.flat();
    expect(allNodes).toContain("A");
    expect(allNodes).toContain("B");
  });
});

describe("detectCycles — 3-node cycle", () => {
  it("detects A→B, B→C, C→A cycle and returns all three nodes", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    insert.run("A", "B");
    insert.run("B", "C");
    insert.run("C", "A");
    db.pragma("foreign_keys = ON");

    const cycles = detectCycles(drizzle(db));
    expect(cycles.length).toBeGreaterThan(0);

    const allNodes = cycles.flat();
    expect(allNodes).toContain("A");
    expect(allNodes).toContain("B");
    expect(allNodes).toContain("C");
  });
});

// ---------------------------------------------------------------------------
// rebuildIndex — document_artifacts type registration
// ---------------------------------------------------------------------------

describe("rebuildIndex — document artifact types map to document_artifacts table", () => {
  const documentTypes = [
    "decision_log",
    "cycle_summary",
    "review_manifest",
    "architecture",
    "overview",
    "execution_strategy",
    "guiding_principles",
    "constraints",
    "research",
    "interview",
  ];

  for (const docType of documentTypes) {
    it(`indexes type '${docType}' into document_artifacts without parse error`, () => {
      const db = freshDb();
      const ideateDir = makeIdeateDir(tmpDir);

      const yaml = [
        `id: "DOC-${docType}"`,
        `type: "${docType}"`,
        `cycle_created: 1`,
        `cycle_modified: null`,
        `content_hash: ""`,
        `token_count: 0`,
        `file_path: ""`,
        `status: "active"`,
        `title: "Test ${docType}"`,
        `cycle: 1`,
        `content: "Some content"`,
      ].join("\n") + "\n";

      writeYaml(ideateDir, `${docType}.yaml`, yaml);

      const stats = rebuildIndex(db, drizzle(db), ideateDir);

      expect(stats.parse_errors.filter((e) => e.includes(`unknown type '${docType}'`))).toHaveLength(0);

      const row = db
        .prepare(`SELECT * FROM document_artifacts WHERE id = 'DOC-${docType}'`)
        .get() as { id: string; title: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.title).toBe(`Test ${docType}`);
    });
  }
});

describe("detectCycles — traversal limits", () => {
  it("throws when edge count exceeds MAX_DEPENDENCY_EDGES", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    for (let i = 0; i <= MAX_DEPENDENCY_EDGES; i++) {
      insert.run(`A${i}`, `B${i}`);
    }
    db.pragma("foreign_keys = ON");
    expect(() => detectCycles(drizzle(db))).toThrow(/edge count .* exceeds limit/);
  });

  it("throws when node count exceeds MAX_DEPENDENCY_NODES", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, 'depends_on')
    `);
    // Each pair gives 2 unique nodes; floor(MAX/2)+1 pairs → MAX+2 unique nodes
    const edgeCount = Math.floor(MAX_DEPENDENCY_NODES / 2) + 1;
    for (let i = 0; i < edgeCount; i++) {
      insert.run(`SRC${i}`, `TGT${i}`);
    }
    db.pragma("foreign_keys = ON");
    expect(() => detectCycles(drizzle(db))).toThrow(/node count .* exceeds limit/);
  });
});

// ---------------------------------------------------------------------------
// indexFiles tests
// ---------------------------------------------------------------------------

describe("indexFiles — single file add", () => {
  it("indexes a valid work_item YAML into the DB", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const filePath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-100.yaml",
      minimalWorkItem({ id: "WI-100", title: "Indexed via indexFiles" })
    );

    const result = indexFiles(db, drizzle(db), [filePath]);

    expect(result.updated).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    const row = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-100'")
      .get() as { id: string; title: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.title).toBe("Indexed via indexFiles");

    const node = db
      .prepare("SELECT * FROM nodes WHERE id = 'WI-100'")
      .get() as { id: string; type: string } | undefined;
    expect(node).toBeDefined();
    expect(node!.type).toBe("work_item");
  });
});

describe("indexFiles — unchanged file skipped", () => {
  it("returns updated: 0 when the same file is indexed twice", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const filePath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-101.yaml",
      minimalWorkItem({ id: "WI-101", title: "Unchanged test" })
    );

    // First index
    const first = indexFiles(db, drizzle(db), [filePath]);
    expect(first.updated).toBe(1);

    // Second index with same content
    const second = indexFiles(db, drizzle(db), [filePath]);
    expect(second.updated).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.errors).toHaveLength(0);
  });
});

describe("indexFiles — parse error", () => {
  it("reports failed: 1 and populates errors for invalid YAML", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const filePath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-BAD.yaml",
      "{ invalid yaml: [unclosed"
    );

    const result = indexFiles(db, drizzle(db), [filePath]);

    expect(result.updated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]).toContain("WI-BAD.yaml");
  });
});

describe("indexFiles — non-YAML file path", () => {
  it("returns updated: 0 and no errors for a non-existent .json path", () => {
    const db = freshDb();
    // Pass a path to a .json file that does not exist on disk.
    // indexSingleFile catches the read error and returns a silent no-op.
    const fakePath = path.join(tmpDir, ".ideate", "config.json");

    const result = indexFiles(db, drizzle(db), [fakePath]);

    expect(result.updated).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// removeFiles tests
// ---------------------------------------------------------------------------

describe("removeFiles — cascade removal", () => {
  it("removes the node and its extension row when the file is deleted", () => {
    const db = freshDb();
    const ideateDir = makeIdeateDir(tmpDir);
    const filePath = writeYaml(
      path.join(ideateDir, "work-items"),
      "WI-200.yaml",
      minimalWorkItem({ id: "WI-200", title: "To be removed" })
    );

    // Index the file first
    const indexResult = indexFiles(db, drizzle(db), [filePath]);
    expect(indexResult.updated).toBe(1);

    // Confirm both node and extension row exist
    const nodeBefore = db
      .prepare("SELECT * FROM nodes WHERE id = 'WI-200'")
      .get();
    expect(nodeBefore).toBeDefined();

    const extBefore = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-200'")
      .get();
    expect(extBefore).toBeDefined();

    // Remove via removeFiles
    const removeResult = removeFiles(db, drizzle(db), [filePath]);
    expect(removeResult.removed).toBe(1);

    // Verify the node is gone
    const nodeAfter = db
      .prepare("SELECT * FROM nodes WHERE id = 'WI-200'")
      .get();
    expect(nodeAfter).toBeUndefined();

    // Verify the extension row is gone (CASCADE)
    const extAfter = db
      .prepare("SELECT * FROM work_items WHERE id = 'WI-200'")
      .get();
    expect(extAfter).toBeUndefined();
  });
});
