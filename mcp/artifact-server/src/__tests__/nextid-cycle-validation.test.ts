// adapters/nextid-cycle-validation.test.ts — Tests for cycle parameter validation in nextId()
//
// Addresses WI-645: Add input validation for cycle parameter in nextId
// Validates that LocalAdapter and RemoteAdapter reject invalid cycle values.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { LocalWriterAdapter } from "../../src/adapters/local/writer.js";
import { ValidationError } from "../../src/adapter.js";
import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "../../src/db.js";

describe("WI-645: nextId cycle parameter validation", () => {
  let adapter: LocalAdapter;
  let testDir: string;
  let db: Database.Database;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = path.join(process.cwd(), "tmp", `test-nextid-validation-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, ".ideate"), { recursive: true });

    // Initialize SQLite database
    const dbPath = path.join(testDir, ".ideate", "index.db");
    db = new Database(dbPath);

    // Create tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT,
        cycle_created INTEGER,
        cycle_modified INTEGER,
        content_hash TEXT NOT NULL,
        token_count INTEGER,
        file_path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        edge_type TEXT NOT NULL,
        properties TEXT,
        PRIMARY KEY (source_id, target_id, edge_type)
      );

      CREATE TABLE IF NOT EXISTS node_locations (
        node_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        node_type TEXT NOT NULL,
        last_modified INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_items (
        node_id TEXT PRIMARY KEY,
        title TEXT,
        complexity TEXT,
        scope TEXT,
        criteria TEXT,
        module TEXT,
        domain TEXT,
        phase TEXT,
        notes TEXT,
        work_item_type TEXT,
        resolution TEXT
      );

      CREATE TABLE IF NOT EXISTS findings (
        node_id TEXT PRIMARY KEY,
        severity TEXT,
        work_item TEXT,
        file_refs TEXT,
        verdict TEXT,
        cycle INTEGER,
        reviewer TEXT,
        description TEXT,
        suggestion TEXT,
        addressed_by TEXT,
        title TEXT
      );

      CREATE TABLE IF NOT EXISTS journal_entries (
        node_id TEXT PRIMARY KEY,
        phase TEXT,
        title TEXT
      );

      CREATE TABLE IF NOT EXISTS domain_policies (
        node_id TEXT PRIMARY KEY,
        domain TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS domain_decisions (
        node_id TEXT PRIMARY KEY,
        domain TEXT,
        cycle INTEGER,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS domain_questions (
        node_id TEXT PRIMARY KEY,
        domain TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS guiding_principles (
        node_id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS constraints (
        node_id TEXT PRIMARY KEY,
        category TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS proxy_human_decisions (
        node_id TEXT PRIMARY KEY,
        trigger TEXT,
        decision TEXT,
        status TEXT
      );

      CREATE TABLE IF NOT EXISTS projects (
        node_id TEXT PRIMARY KEY,
        name TEXT,
        intent TEXT
      );

      CREATE TABLE IF NOT EXISTS phases (
        node_id TEXT PRIMARY KEY,
        name TEXT,
        phase_type TEXT,
        intent TEXT
      );

      CREATE TABLE IF NOT EXISTS document_artifacts (
        node_id TEXT PRIMARY KEY,
        title TEXT
      );

      CREATE TABLE IF NOT EXISTS module_specs (
        node_id TEXT PRIMARY KEY,
        name TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS research_findings (
        node_id TEXT PRIMARY KEY,
        topic TEXT,
        summary TEXT
      );

      CREATE TABLE IF NOT EXISTS interview_questions (
        node_id TEXT PRIMARY KEY,
        interview_id TEXT,
        question TEXT
      );
    `);

    // Create Drizzle instance
    const drizzleDb = drizzle(db, { schema });

    // Create LocalAdapter instance
    adapter = new LocalAdapter({
      db,
      drizzleDb,
      ideateDir: path.join(testDir, ".ideate"),
    });

    await adapter.initialize();
  });

  afterAll(async () => {
    if (adapter) {
      await adapter.shutdown();
    }
    if (db) {
      db.close();
    }
    // Clean up test directory
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("AC1: Cycle parameter validated as non-negative integer", () => {
    it("accepts cycle=0 (valid non-negative integer)", async () => {
      const id = await adapter.nextId("finding", 0);
      expect(id).toMatch(/^F-\d{3}-\d{3}$/);
    });

    it("accepts cycle=1 (valid positive integer)", async () => {
      const id = await adapter.nextId("finding", 1);
      expect(id).toMatch(/^F-\d{3}-\d{3}$/);
    });

    it("accepts cycle=999 (valid large integer)", async () => {
      const id = await adapter.nextId("finding", 999);
      expect(id).toMatch(/^F-\d{3}-\d{3}$/);
    });
  });

  describe("AC2: Validation rejects negative values with clear error", () => {
    it("rejects cycle=-1 with ValidationError", async () => {
      await expect(adapter.nextId("finding", -1)).rejects.toThrow(ValidationError);
    });

    it("rejects cycle=-100 with clear error message", async () => {
      await expect(adapter.nextId("finding", -100)).rejects.toThrow(/non-negative/);
    });

    it("error includes field name and value", async () => {
      try {
        await adapter.nextId("finding", -5);
        expect.fail("Should have thrown ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_CYCLE");
        expect((err as ValidationError).details?.value).toBe(-5);
      }
    });
  });

  describe("AC3: Validation rejects non-integer values", () => {
    it("rejects cycle=1.5 (float)", async () => {
      await expect(adapter.nextId("finding", 1.5)).rejects.toThrow(ValidationError);
    });

    it("rejects cycle=3.14159 (float)", async () => {
      await expect(adapter.nextId("finding", 3.14159)).rejects.toThrow(/integer/);
    });

    it("rejects cycle=NaN", async () => {
      await expect(adapter.nextId("finding", NaN)).rejects.toThrow(ValidationError);
    });

    it("rejects cycle=Infinity", async () => {
      await expect(adapter.nextId("finding", Infinity)).rejects.toThrow(ValidationError);
    });

    it("rejects cycle=-Infinity", async () => {
      await expect(adapter.nextId("finding", -Infinity)).rejects.toThrow(ValidationError);
    });
  });

  describe("AC4: SQL injection risk eliminated via validation", () => {
    it("rejects cycle as string (prevents injection)", async () => {
      // @ts-expect-error - Testing runtime behavior with invalid type
      await expect(adapter.nextId("finding", "1; DROP TABLE nodes; --")).rejects.toThrow(ValidationError);
    });

    it("rejects cycle as object", async () => {
      // @ts-expect-error - Testing runtime behavior with invalid type
      await expect(adapter.nextId("finding", { toString: () => "1" })).rejects.toThrow(ValidationError);
    });

    it("rejects cycle as array", async () => {
      // @ts-expect-error - Testing runtime behavior with invalid type
      await expect(adapter.nextId("finding", [1, 2, 3])).rejects.toThrow(ValidationError);
    });
  });

  describe("Cycle parameter is optional", () => {
    it("allows undefined cycle for non-cycle-scoped types", async () => {
      const id = await adapter.nextId("work_item");
      expect(id).toMatch(/^WI-\d{3}$/);
    });

    it("allows undefined cycle for guiding_principle", async () => {
      const id = await adapter.nextId("guiding_principle");
      expect(id).toMatch(/^GP-\d{2}$/);
    });
  });

  describe("Validation works for all cycle-scoped types", () => {
    it("validates cycle for journal_entry", async () => {
      await expect(adapter.nextId("journal_entry", -1)).rejects.toThrow(ValidationError);
      await expect(adapter.nextId("journal_entry", 1.5)).rejects.toThrow(ValidationError);
    });

    it("validates cycle for finding", async () => {
      await expect(adapter.nextId("finding", -1)).rejects.toThrow(ValidationError);
      await expect(adapter.nextId("finding", 1.5)).rejects.toThrow(ValidationError);
    });

    it("validates cycle for proxy_human_decision", async () => {
      await expect(adapter.nextId("proxy_human_decision", -1)).rejects.toThrow(ValidationError);
      await expect(adapter.nextId("proxy_human_decision", 1.5)).rejects.toThrow(ValidationError);
    });
  });

  describe("INVALID_NODE_TYPE: unsupported types in LocalWriterAdapter.nextId", () => {
    // LocalWriterAdapter.nextId only handles journal_entry, work_item, and finding.
    // Any other type throws ValidationError with code INVALID_NODE_TYPE.
    // (LocalAdapter routes other types to the reader; this tests the writer directly.)
    let writer: LocalWriterAdapter;

    beforeAll(() => {
      writer = new LocalWriterAdapter({
        db,
        drizzleDb: drizzle(db, { schema }),
        ideateDir: path.join(testDir, ".ideate"),
      });
    });

    it("throws INVALID_NODE_TYPE for unsupported node type", async () => {
      await expect(
        writer.nextId("domain_policy" as import("../../src/adapter.js").NodeType)
      ).rejects.toMatchObject({
        code: "INVALID_NODE_TYPE",
      });
    });

    it("INVALID_NODE_TYPE error is a ValidationError", async () => {
      await expect(
        writer.nextId("guiding_principle" as import("../../src/adapter.js").NodeType)
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
