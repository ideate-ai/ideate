import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSchema, checkSchemaVersion, CURRENT_SCHEMA_VERSION, EDGE_TYPES, EDGE_TYPE_REGISTRY } from "../schema.js";
import { indexFiles } from "../indexer.js";
import * as dbSchema from "../db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  createSchema(db);
  return db;
}

function tableNames(db: Database.Database): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare(`PRAGMA table_info('${table}')`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare(`PRAGMA index_list('${table}')`)
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

// ---------------------------------------------------------------------------
// nodes table — 8 columns
// ---------------------------------------------------------------------------

describe("createSchema — nodes table", () => {
  it("nodes table exists", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).toContain("nodes");
  });

  it("nodes table has exactly 8 columns: id, type, cycle_created, cycle_modified, content_hash, token_count, file_path, status", () => {
    const db = freshDb();
    const cols = columnNames(db, "nodes");
    const expected = [
      "id",
      "type",
      "cycle_created",
      "cycle_modified",
      "content_hash",
      "token_count",
      "file_path",
      "status",
    ];
    for (const col of expected) {
      expect(cols, `expected nodes to have column '${col}'`).toContain(col);
    }
    expect(cols.length).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Extension tables — 15 tables, each with FK to nodes(id)
// ---------------------------------------------------------------------------

describe("createSchema — extension tables", () => {
  const extensionTables = [
    "work_items",
    "findings",
    "domain_policies",
    "domain_decisions",
    "domain_questions",
    "guiding_principles",
    "constraints",
    "module_specs",
    "research_findings",
    "journal_entries",
    "metrics_events",
    "document_artifacts",
    "interview_questions",
    "projects",
    "phases",
  ];

  it("creates all 15 extension tables", () => {
    const db = freshDb();
    const tables = tableNames(db);
    for (const name of extensionTables) {
      expect(tables, `expected extension table '${name}' to exist`).toContain(name);
    }
    expect(extensionTables.length).toBe(15);
  });

  it("does not create an interview_responses table", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).not.toContain("interview_responses");
  });
});

// ---------------------------------------------------------------------------
// ON DELETE CASCADE — nodes → extension tables
// ---------------------------------------------------------------------------

describe("createSchema — ON DELETE CASCADE (nodes → extension)", () => {
  it("deleting a node cascades to work_items extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    // Insert node + work_item extension
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('WI-001', 'work_item', 'abc', '/tmp/wi-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO work_items (id, title) VALUES ('WI-001', 'Test Work Item')`
    ).run();

    // Verify it exists
    const before = db.prepare(`SELECT id FROM work_items WHERE id = 'WI-001'`).get();
    expect(before).toBeDefined();

    // Delete from nodes
    db.prepare(`DELETE FROM nodes WHERE id = 'WI-001'`).run();

    // Extension row should be gone
    const after = db.prepare(`SELECT id FROM work_items WHERE id = 'WI-001'`).get();
    expect(after).toBeUndefined();
  });

  it("deleting a node cascades to findings extension row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('FIND-001', 'finding', 'hash1', '/tmp/find.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO findings (id, severity, work_item, verdict, cycle, reviewer) VALUES ('FIND-001', 'minor', 'WI-001', 'pass', 1, 'reviewer')`
    ).run();

    db.prepare(`DELETE FROM nodes WHERE id = 'FIND-001'`).run();
    const after = db.prepare(`SELECT id FROM findings WHERE id = 'FIND-001'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ON DELETE CASCADE — nodes → edges
// ---------------------------------------------------------------------------

describe("createSchema — ON DELETE CASCADE (nodes → edges)", () => {
  it("deleting the source node cascades and removes the edge row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    // Insert two nodes
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('A', 'work_item', 'ha', '/tmp/a.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('B', 'work_item', 'hb', '/tmp/b.yaml')`
    ).run();
    // Insert edge
    db.prepare(
      `INSERT INTO edges (source_id, target_id, edge_type) VALUES ('A', 'B', 'depends_on')`
    ).run();

    // Verify edge exists
    const before = db.prepare(`SELECT id FROM edges WHERE source_id='A'`).get();
    expect(before).toBeDefined();

    // Delete source node
    db.prepare(`DELETE FROM nodes WHERE id = 'A'`).run();

    // Edge should be gone
    const after = db.prepare(`SELECT id FROM edges WHERE source_id='A'`).get();
    expect(after).toBeUndefined();
  });

  it("deleting the target node cascades and removes the edge row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('SRC', 'work_item', 'h1', '/tmp/s.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('TGT', 'work_item', 'h2', '/tmp/t.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO edges (source_id, target_id, edge_type) VALUES ('SRC', 'TGT', 'depends_on')`
    ).run();

    db.prepare(`DELETE FROM nodes WHERE id = 'TGT'`).run();
    const after = db.prepare(`SELECT id FROM edges WHERE source_id='SRC'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ON DELETE CASCADE — nodes → node_file_refs
// ---------------------------------------------------------------------------

describe("createSchema — ON DELETE CASCADE (nodes → node_file_refs)", () => {
  it("deleting a node cascades to its file_refs rows", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('WI-002', 'work_item', 'abc2', '/tmp/wi-002.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO node_file_refs (node_id, file_path) VALUES ('WI-002', 'src/foo.ts')`
    ).run();

    db.prepare(`DELETE FROM nodes WHERE id = 'WI-002'`).run();
    const after = db
      .prepare(`SELECT node_id FROM node_file_refs WHERE node_id = 'WI-002'`)
      .get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// edges table — no source_type or target_type columns
// ---------------------------------------------------------------------------

describe("createSchema — edges table columns", () => {
  it("edges table does NOT have a source_type column", () => {
    const db = freshDb();
    const cols = columnNames(db, "edges");
    expect(cols).not.toContain("source_type");
  });

  it("edges table does NOT have a target_type column", () => {
    const db = freshDb();
    const cols = columnNames(db, "edges");
    expect(cols).not.toContain("target_type");
  });

  it("edges table has: id, source_id, target_id, edge_type, props", () => {
    const db = freshDb();
    const cols = columnNames(db, "edges");
    for (const col of ["id", "source_id", "target_id", "edge_type", "props"]) {
      expect(cols).toContain(col);
    }
  });

  it("enforces UNIQUE(source_id, target_id, edge_type) constraint (insert with FK OFF)", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, ?)
    `);
    insert.run("A", "B", "depends_on");
    expect(() => {
      insert.run("A", "B", "depends_on");
    }).toThrow();
    db.pragma("foreign_keys = ON");
  });

  it("INSERT OR IGNORE on duplicate edge leaves only 1 row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT OR IGNORE INTO edges (source_id, target_id, edge_type)
      VALUES (?, ?, ?)
    `);
    insert.run("A", "B", "depends_on");
    insert.run("A", "B", "depends_on");
    const count = (
      db
        .prepare(`SELECT COUNT(*) as cnt FROM edges WHERE source_id='A' AND target_id='B' AND edge_type='depends_on'`)
        .get() as { cnt: number }
    ).cnt;
    expect(count).toBe(1);
    db.pragma("foreign_keys = ON");
  });

  it("edges.id is auto-increment", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    db.prepare(`
      INSERT INTO edges (source_id, target_id, edge_type)
      VALUES ('X', 'Y', 'depends_on')
    `).run();
    const row = db
      .prepare(`SELECT id FROM edges WHERE source_id='X'`)
      .get() as { id: number } | undefined;
    expect(row).toBeDefined();
    expect(typeof row!.id).toBe("number");
    expect(row!.id).toBeGreaterThan(0);
    db.pragma("foreign_keys = ON");
  });
});

// ---------------------------------------------------------------------------
// node_file_refs — PRIMARY KEY (node_id, file_path), no node_type column
// ---------------------------------------------------------------------------

describe("createSchema — node_file_refs table", () => {
  it("does NOT have a node_type column", () => {
    const db = freshDb();
    const cols = columnNames(db, "node_file_refs");
    expect(cols).not.toContain("node_type");
  });

  it("enforces PRIMARY KEY (node_id, file_path) — duplicate throws (insert with FK OFF)", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO node_file_refs (node_id, file_path)
      VALUES (?, ?)
    `);
    insert.run("WI-001", "src/foo.ts");
    expect(() => {
      insert.run("WI-001", "src/foo.ts");
    }).toThrow();
    db.pragma("foreign_keys = ON");
  });

  it("allows same node_id with different file_path", () => {
    const db = freshDb();
    db.pragma("foreign_keys = OFF");
    const insert = db.prepare(`
      INSERT INTO node_file_refs (node_id, file_path)
      VALUES (?, ?)
    `);
    insert.run("WI-001", "src/foo.ts");
    expect(() => {
      insert.run("WI-001", "src/bar.ts");
    }).not.toThrow();
    db.pragma("foreign_keys = ON");
  });
});

// ---------------------------------------------------------------------------
// Schema version — CURRENT_SCHEMA_VERSION is 4
// ---------------------------------------------------------------------------

describe("createSchema — schema version", () => {
  it("CURRENT_SCHEMA_VERSION is 4", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(4);
  });

  it("sets user_version = 4 after createSchema", () => {
    const db = freshDb();
    const version = db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Index existence
// ---------------------------------------------------------------------------

describe("createSchema — indexes", () => {
  // Shared DB instance — createSchema is deterministic, index checks are read-only
  const db = freshDb();

  it("creates idx_nodes_type on nodes", () => {
    expect(indexNames(db, "nodes")).toContain("idx_nodes_type");
  });

  it("creates idx_nodes_file_path on nodes", () => {
    expect(indexNames(db, "nodes")).toContain("idx_nodes_file_path");
  });

  it("creates idx_edges_source on edges", () => {
    expect(indexNames(db, "edges")).toContain("idx_edges_source");
  });

  it("creates idx_edges_target on edges", () => {
    expect(indexNames(db, "edges")).toContain("idx_edges_target");
  });

  it("creates idx_file_refs_path on node_file_refs", () => {
    expect(indexNames(db, "node_file_refs")).toContain("idx_file_refs_path");
  });

  it("creates idx_work_items_domain on work_items", () => {
    expect(indexNames(db, "work_items")).toContain("idx_work_items_domain");
  });

  it("creates idx_findings_work_item on findings", () => {
    expect(indexNames(db, "findings")).toContain("idx_findings_work_item");
  });

  it("creates idx_domain_policies_domain on domain_policies", () => {
    expect(indexNames(db, "domain_policies")).toContain("idx_domain_policies_domain");
  });

  it("creates idx_domain_questions_domain on domain_questions", () => {
    expect(indexNames(db, "domain_questions")).toContain("idx_domain_questions_domain");
  });
});

// ---------------------------------------------------------------------------
// findings table columns
// ---------------------------------------------------------------------------

describe("createSchema — findings table columns", () => {
  it("has an addressed_by column", () => {
    const db = freshDb();
    const columns = columnNames(db, "findings");
    expect(columns).toContain("addressed_by");
  });
});

// ---------------------------------------------------------------------------
// domain_policies table columns
// ---------------------------------------------------------------------------

describe("createSchema — domain_policies table columns", () => {
  it("has an amended_by column", () => {
    const db = freshDb();
    const columns = columnNames(db, "domain_policies");
    expect(columns).toContain("amended_by");
  });
});

// ---------------------------------------------------------------------------
// domain_questions table columns
// ---------------------------------------------------------------------------

describe("createSchema — domain_questions table columns", () => {
  it("has a nullable addressed_by column", () => {
    const db = freshDb();
    const rows = db
      .prepare(`PRAGMA table_info(domain_questions)`)
      .all() as Array<{ name: string; notnull: number }>;
    const col = rows.find((r) => r.name === "addressed_by");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// document_artifacts table columns
// ---------------------------------------------------------------------------

describe("createSchema — document_artifacts table columns", () => {
  it("has nullable title, cycle, and content columns", () => {
    const db = freshDb();
    const rows = db
      .prepare(`PRAGMA table_info(document_artifacts)`)
      .all() as Array<{ name: string; notnull: number }>;
    const colNames = rows.map((r) => r.name);
    expect(colNames).toContain("title");
    expect(colNames).toContain("cycle");
    expect(colNames).toContain("content");
    const title = rows.find((r) => r.name === "title");
    expect(title!.notnull).toBe(0);
    const cycle = rows.find((r) => r.name === "cycle");
    expect(cycle!.notnull).toBe(0);
    const content = rows.find((r) => r.name === "content");
    expect(content!.notnull).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// interview_questions table
// ---------------------------------------------------------------------------

describe("createSchema — interview_questions table", () => {
  it("interview_questions table exists", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).toContain("interview_questions");
  });

  it("has expected columns: id, interview_id, question, answer, domain, seq", () => {
    const db = freshDb();
    const cols = columnNames(db, "interview_questions");
    for (const col of ["id", "interview_id", "question", "answer", "domain", "seq"]) {
      expect(cols, `expected interview_questions to have column '${col}'`).toContain(col);
    }
  });

  it("domain column is nullable", () => {
    const db = freshDb();
    const rows = db
      .prepare(`PRAGMA table_info(interview_questions)`)
      .all() as Array<{ name: string; notnull: number }>;
    const col = rows.find((r) => r.name === "domain");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it("creates idx_interview_questions_interview index", () => {
    const db = freshDb();
    const indexes = indexNames(db, "interview_questions");
    expect(indexes).toContain("idx_interview_questions_interview");
  });

  it("ON DELETE CASCADE: deleting a node cascades to interview_questions row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");

    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('INT-001', 'interview', 'hash-int', '/tmp/int-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('IQ-001-001', 'interview_question', 'hash-iq', '/tmp/int-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO interview_questions (id, interview_id, question, answer, seq) VALUES ('IQ-001-001', 'INT-001', 'What?', 'This.', 1)`
    ).run();

    const before = db.prepare(`SELECT id FROM interview_questions WHERE id = 'IQ-001-001'`).get();
    expect(before).toBeDefined();

    db.prepare(`DELETE FROM nodes WHERE id = 'IQ-001-001'`).run();

    const after = db.prepare(`SELECT id FROM interview_questions WHERE id = 'IQ-001-001'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("createSchema — idempotency", () => {
  it("can be called twice on the same DB without error", () => {
    const db = new Database(":memory:");
    expect(() => {
      createSchema(db);
      createSchema(db);
    }).not.toThrow();
  });

  it("same tables present after second call", () => {
    const db = new Database(":memory:");
    createSchema(db);
    createSchema(db);
    const tables = tableNames(db);
    expect(tables).toContain("nodes");
    expect(tables).toContain("work_items");
    expect(tables).toContain("edges");
    expect(tables).toContain("node_file_refs");
  });
});

// ---------------------------------------------------------------------------
// checkSchemaVersion
// ---------------------------------------------------------------------------

describe("checkSchemaVersion", () => {
  it("returns true for a fresh database with user_version = 0", () => {
    const db = new Database(":memory:");
    // SQLite sets user_version = 0 by default on a new file — treated as "fresh DB, compatible"
    const result = checkSchemaVersion(db, "/nonexistent/path/that/does/not/exist.db");
    expect(result).toBe(true);
    db.close();
  });

  it("returns false and deletes the database file when user_version is stale", () => {
    const dir = mkdtempSync(join(tmpdir(), "ideate-schema-test-"));
    const dbPath = join(dir, "test.db");

    try {
      {
        const db = new Database(dbPath);
        db.pragma("user_version = 5"); // stale — current is 2
        db.close();
      }

      // Open the handle; track whether the test still owns it so the finally
      // block can close it safely if checkSchemaVersion does not (e.g. if the
      // implementation is later changed to not close internally on this path).
      const db = new Database(dbPath);
      let handleClosed = false;
      try {
        const result = checkSchemaVersion(db, dbPath);
        expect(result).toBe(false);
        expect(existsSync(dbPath)).toBe(false);
      } finally {
        if (!handleClosed) {
          try { db.close(); } catch { /* already closed by checkSchemaVersion */ }
          handleClosed = true;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when user_version matches CURRENT_SCHEMA_VERSION (3)", () => {
    const db = new Database(":memory:");
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`); // 3
    const result = checkSchemaVersion(db, "/nonexistent/path/not/used.db");
    expect(result).toBe(true);
    db.close();
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPES — governed_by and informed_by
// ---------------------------------------------------------------------------

describe("EDGE_TYPES — governed_by and informed_by", () => {
  it("EDGE_TYPES includes governed_by", () => {
    expect(EDGE_TYPES).toContain("governed_by");
  });

  it("EDGE_TYPES includes informed_by", () => {
    expect(EDGE_TYPES).toContain("informed_by");
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPE_REGISTRY — governed_by and informed_by entries
// ---------------------------------------------------------------------------

describe("EDGE_TYPE_REGISTRY — governed_by entry", () => {
  it("governed_by entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("governed_by");
  });

  it("governed_by has correct source_types", () => {
    expect(EDGE_TYPE_REGISTRY.governed_by.source_types).toEqual(["work_item", "module_spec", "constraint"]);
  });

  it("governed_by has correct target_types", () => {
    expect(EDGE_TYPE_REGISTRY.governed_by.target_types).toEqual(["guiding_principle", "domain_policy", "constraint"]);
  });

  it("governed_by has yaml_field set", () => {
    expect(EDGE_TYPE_REGISTRY.governed_by.yaml_field).toBe("governed_by");
  });
});

describe("EDGE_TYPE_REGISTRY — informed_by entry", () => {
  it("informed_by entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("informed_by");
  });

  it("informed_by has correct source_types", () => {
    expect(EDGE_TYPE_REGISTRY.informed_by.source_types).toEqual(["work_item", "module_spec", "guiding_principle"]);
  });

  it("informed_by has correct target_types", () => {
    expect(EDGE_TYPE_REGISTRY.informed_by.target_types).toEqual(["research_finding", "domain_decision", "domain_question"]);
  });

  it("informed_by has yaml_field set", () => {
    expect(EDGE_TYPE_REGISTRY.informed_by.yaml_field).toBe("informed_by");
  });
});

// ---------------------------------------------------------------------------
// projects table
// ---------------------------------------------------------------------------

describe("createSchema — projects table", () => {
  it("projects table exists", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).toContain("projects");
  });

  it("has expected columns: id, name, description, intent, scope_boundary, success_criteria, appetite, steering, horizon, status", () => {
    const db = freshDb();
    const cols = columnNames(db, "projects");
    for (const col of ["id", "name", "description", "intent", "scope_boundary", "success_criteria", "appetite", "steering", "horizon", "status"]) {
      expect(cols, `expected projects to have column '${col}'`).toContain(col);
    }
  });

  it("ON DELETE CASCADE: deleting a node cascades to projects row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('PRJ-001', 'project', 'hash-prj', '/tmp/prj-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO projects (id, intent, status) VALUES ('PRJ-001', 'Build something', 'active')`
    ).run();
    const before = db.prepare(`SELECT id FROM projects WHERE id = 'PRJ-001'`).get();
    expect(before).toBeDefined();
    db.prepare(`DELETE FROM nodes WHERE id = 'PRJ-001'`).run();
    const after = db.prepare(`SELECT id FROM projects WHERE id = 'PRJ-001'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// phases table
// ---------------------------------------------------------------------------

describe("createSchema — phases table", () => {
  it("phases table exists", () => {
    const db = freshDb();
    const tables = tableNames(db);
    expect(tables).toContain("phases");
  });

  it("has expected columns: id, name, description, project, phase_type, intent, steering, status, work_items", () => {
    const db = freshDb();
    const cols = columnNames(db, "phases");
    for (const col of ["id", "name", "description", "project", "phase_type", "intent", "steering", "status", "work_items"]) {
      expect(cols, `expected phases to have column '${col}'`).toContain(col);
    }
  });

  it("creates idx_phases_project index on phases", () => {
    const db = freshDb();
    const indexes = indexNames(db, "phases");
    expect(indexes).toContain("idx_phases_project");
  });

  it("ON DELETE CASCADE: deleting a node cascades to phases row", () => {
    const db = freshDb();
    db.pragma("foreign_keys = ON");
    db.prepare(
      `INSERT INTO nodes (id, type, content_hash, file_path) VALUES ('PH-001', 'phase', 'hash-ph', '/tmp/ph-001.yaml')`
    ).run();
    db.prepare(
      `INSERT INTO phases (id, project, phase_type, intent, status) VALUES ('PH-001', 'PRJ-001', 'execute', 'Build it', 'active')`
    ).run();
    const before = db.prepare(`SELECT id FROM phases WHERE id = 'PH-001'`).get();
    expect(before).toBeDefined();
    db.prepare(`DELETE FROM nodes WHERE id = 'PH-001'`).run();
    const after = db.prepare(`SELECT id FROM phases WHERE id = 'PH-001'`).get();
    expect(after).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPES — belongs_to_project and belongs_to_phase
// ---------------------------------------------------------------------------

describe("EDGE_TYPES — belongs_to_project and belongs_to_phase", () => {
  it("EDGE_TYPES includes belongs_to_project", () => {
    expect(EDGE_TYPES).toContain("belongs_to_project");
  });

  it("EDGE_TYPES includes belongs_to_phase", () => {
    expect(EDGE_TYPES).toContain("belongs_to_phase");
  });
});

// ---------------------------------------------------------------------------
// EDGE_TYPE_REGISTRY — belongs_to_project and belongs_to_phase entries
// ---------------------------------------------------------------------------

describe("EDGE_TYPE_REGISTRY — belongs_to_project entry", () => {
  it("belongs_to_project entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("belongs_to_project");
  });

  it("belongs_to_project has correct source_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_project.source_types).toEqual(["phase"]);
  });

  it("belongs_to_project has correct target_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_project.target_types).toEqual(["project"]);
  });

  it("belongs_to_project has yaml_field = 'project'", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_project.yaml_field).toBe("project");
  });
});

describe("EDGE_TYPE_REGISTRY — belongs_to_phase entry", () => {
  it("belongs_to_phase entry exists in EDGE_TYPE_REGISTRY", () => {
    expect(EDGE_TYPE_REGISTRY).toHaveProperty("belongs_to_phase");
  });

  it("belongs_to_phase has correct source_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_phase.source_types).toEqual(["work_item"]);
  });

  it("belongs_to_phase has correct target_types", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_phase.target_types).toEqual(["phase"]);
  });

  it("belongs_to_phase has yaml_field = 'phase'", () => {
    expect(EDGE_TYPE_REGISTRY.belongs_to_phase.yaml_field).toBe("phase");
  });
});

// ---------------------------------------------------------------------------
// document_artifacts.cycle populated by indexer for cycle_summary YAML
// ---------------------------------------------------------------------------

describe("indexer — document_artifacts.cycle populated from YAML", () => {
  it("indexing a cycle_summary YAML with top-level cycle:3 sets document_artifacts.cycle = 3", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ideate-da-cycle-test-"));
    try {
      // Set up a minimal .ideate/ directory with a cycles/003/ subdir
      const cycleDir = join(tmpDir, "cycles", "003");
      mkdirSync(cycleDir, { recursive: true });

      // Write a cycle_summary YAML with a top-level cycle field
      const yamlPath = join(cycleDir, "SA-TEST-001.yaml");
      writeFileSync(
        yamlPath,
        [
          "id: SA-TEST-001",
          "type: cycle_summary",
          "cycle: 3",
          "title: Test Spec Adherence",
          "reviewer: spec-reviewer",
          "verdict: Pass",
          "content: |",
          "  ## Verdict: Pass",
        ].join("\n") + "\n",
        "utf8"
      );

      // Set up in-memory DB + drizzle
      const db = new Database(":memory:");
      createSchema(db);
      const drizzleDb = drizzle(db, { schema: dbSchema });

      // Run incremental indexer on the single file
      indexFiles(db, drizzleDb, [yamlPath]);

      // Query document_artifacts for SA-TEST-001
      const row = db
        .prepare("SELECT cycle FROM document_artifacts WHERE id = 'SA-TEST-001'")
        .get() as { cycle: number | null } | undefined;

      expect(row, "SA-TEST-001 should be present in document_artifacts").toBeDefined();
      expect(row!.cycle, "document_artifacts.cycle should equal 3").toBe(3);

      db.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
