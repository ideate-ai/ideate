import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createSchema, checkSchemaVersion, CURRENT_SCHEMA_VERSION } from "../schema.js";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
// Extension tables — 12 tables, each with FK to nodes(id)
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
  ];

  it("creates all 13 extension tables", () => {
    const db = freshDb();
    const tables = tableNames(db);
    for (const name of extensionTables) {
      expect(tables, `expected extension table '${name}' to exist`).toContain(name);
    }
    expect(extensionTables.length).toBe(13);
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
// Schema version — CURRENT_SCHEMA_VERSION is 1
// ---------------------------------------------------------------------------

describe("createSchema — schema version", () => {
  it("CURRENT_SCHEMA_VERSION is 1", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  it("sets user_version = 1 after createSchema", () => {
    const db = freshDb();
    const version = db.pragma("user_version", { simple: true }) as number;
    expect(version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Index existence
// ---------------------------------------------------------------------------

describe("createSchema — indexes", () => {
  it("creates idx_nodes_type on nodes", () => {
    const db = freshDb();
    const indexes = indexNames(db, "nodes");
    expect(indexes).toContain("idx_nodes_type");
  });

  it("creates idx_nodes_file_path on nodes", () => {
    const db = freshDb();
    const indexes = indexNames(db, "nodes");
    expect(indexes).toContain("idx_nodes_file_path");
  });

  it("creates idx_edges_source on edges", () => {
    const db = freshDb();
    const indexes = indexNames(db, "edges");
    expect(indexes).toContain("idx_edges_source");
  });

  it("creates idx_edges_target on edges", () => {
    const db = freshDb();
    const indexes = indexNames(db, "edges");
    expect(indexes).toContain("idx_edges_target");
  });

  it("creates idx_file_refs_path on node_file_refs", () => {
    const db = freshDb();
    const indexes = indexNames(db, "node_file_refs");
    expect(indexes).toContain("idx_file_refs_path");
  });

  it("creates idx_work_items_domain on work_items", () => {
    const db = freshDb();
    const indexes = indexNames(db, "work_items");
    expect(indexes).toContain("idx_work_items_domain");
  });

  it("creates idx_findings_work_item on findings", () => {
    const db = freshDb();
    const indexes = indexNames(db, "findings");
    expect(indexes).toContain("idx_findings_work_item");
  });

  it("creates idx_domain_policies_domain on domain_policies", () => {
    const db = freshDb();
    const indexes = indexNames(db, "domain_policies");
    expect(indexes).toContain("idx_domain_policies_domain");
  });

  it("creates idx_domain_questions_domain on domain_questions", () => {
    const db = freshDb();
    const indexes = indexNames(db, "domain_questions");
    expect(indexes).toContain("idx_domain_questions_domain");
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
        db.pragma("user_version = 5"); // stale — current is 1
        db.close();
      }

      const db = new Database(dbPath);
      const result = checkSchemaVersion(db, dbPath);

      expect(result).toBe(false);
      expect(existsSync(dbPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when user_version matches CURRENT_SCHEMA_VERSION (1)", () => {
    const db = new Database(":memory:");
    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`); // 1
    const result = checkSchemaVersion(db, "/nonexistent/path/not/used.db");
    expect(result).toBe(true);
    db.close();
  });
});
