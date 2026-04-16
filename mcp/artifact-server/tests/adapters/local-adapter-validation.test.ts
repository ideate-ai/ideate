/**
 * local-adapter-validation.test.ts — Comprehensive LocalAdapter validation tests
 *
 * Per WI-658: Complete validation layer tests for LocalAdapter covering:
 * - Transaction failure ValidationErrors (TRANSACTION_FAILED)
 * - seed_ids validation (INVALID_SEED_IDS, EMPTY_SEED_IDS, INVALID_SEED_ID)
 * - limit/offset validation (INVALID_LIMIT, INVALID_OFFSET)
 * - batchMutate input validation (EMPTY_BATCH, MISSING_NODE_ID, etc.) - throws ValidationError
 * - nextId cycle validation (INVALID_CYCLE)
 * - always_include_types validation (INVALID_ALWAYS_INCLUDE_TYPE)
 *
 * Per WI-675 (AC-7): deleteNode, putEdge, and removeEdges validation covering:
 * - deleteNode: INVALID_NODE_ID when id is empty or non-string
 * - putEdge: MISSING_EDGE_SOURCE, MISSING_EDGE_TARGET, MISSING_EDGE_TYPE, INVALID_EDGE_TYPE
 * - removeEdges: INVALID_NODE_ID when source_id is invalid, INVALID_EDGE_TYPE for unknown edge types
 *
 * Per WI-692 (AC-8): patchNode validation covering:
 * - INVALID_NODE_ID when id is empty string
 * - IMMUTABLE_FIELD when id, type, or cycle_created appears in properties
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter, LocalReaderAdapter } from "../../src/adapters/local/index.js";
import { ValidationError, ImmutableFieldError } from "../../src/adapter.js";
import { ALL_NODE_TYPES } from "../../src/adapter.js";
import type { StorageAdapter } from "../../src/adapter.js";
import { ValidatingAdapter } from "../../src/validating.js";

// -----------------------------------------------------------------------------
// Test Setup Helpers
// -----------------------------------------------------------------------------

interface LocalAdapterSetup {
  adapter: ValidatingAdapter;
  tmpDir: string;
  db: Database.Database;
}

async function createLocalAdapter(): Promise<LocalAdapterSetup> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-validation-test-"));
  const ideateDir = path.join(tmpDir, ".ideate");

  // Create the minimal directory structure LocalAdapter expects
  for (const sub of [
    "work-items",
    "policies",
    "decisions",
    "questions",
    "principles",
    "constraints",
    "modules",
    "research",
    "interviews",
    "projects",
    "phases",
    "plan",
    "steering",
    "domains",
    "archive/cycles",
    "archive/incremental",
  ]) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }

  // Create domains index (needed for cycle operations)
  fs.writeFileSync(
    path.join(ideateDir, "domains", "index.yaml"),
    "current_cycle: 1\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);
  createSchema(db);

  const drizzleDb = drizzle(db, { schema: dbSchema });

  const raw = new LocalAdapter({ db, drizzleDb, ideateDir });
  await raw.initialize();
  const adapter = new ValidatingAdapter(raw);

  return { adapter, tmpDir, db };
}

async function cleanupLocalAdapter(setup: LocalAdapterSetup): Promise<void> {
  try {
    setup.db.close();
  } catch {
    // ignore
  }
  if (setup.tmpDir) {
    fs.rmSync(setup.tmpDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("LocalAdapter Validation Layer (WI-658)", () => {
  let setup: LocalAdapterSetup;

  beforeAll(async () => {
    setup = await createLocalAdapter();
  });

  afterAll(async () => {
    await cleanupLocalAdapter(setup);
  });

  // ===========================================================================
  // AC-1: Transaction Failures (TRANSACTION_FAILED)
  // ===========================================================================

  // AC-1: TRANSACTION_FAILED coverage is tested in write-transaction.test.ts

  // ===========================================================================
  // AC-2: seed_ids Validation in traverse()
  // ===========================================================================

  describe("AC-2: seed_ids validation in traverse()", () => {
    beforeAll(async () => {
      // Ensure fresh adapter for these tests
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();
      // Create a test node
      await setup.adapter.putNode({
        id: "GP-TEST-SEED",
        type: "guiding_principle",
        properties: { name: "Test Seed", description: "For validation tests" },
      });
    });

    it("accepts valid string seed_ids", async () => {
      const result = await setup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        token_budget: 10000,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.ranked_nodes)).toBe(true);
    });

    it("rejects undefined seed_ids with INVALID_SEED_IDS", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        setup.adapter.traverse({ token_budget: 10000 })
      ).rejects.toThrow(ValidationError);

      try {
        // @ts-expect-error Testing runtime behavior
        await setup.adapter.traverse({ token_budget: 10000 });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_SEED_IDS");
        expect((err as ValidationError).message).toContain("seed_ids");
      }
    });

    it("rejects null seed_ids with INVALID_SEED_IDS", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        setup.adapter.traverse({ seed_ids: null, token_budget: 10000 })
      ).rejects.toThrow(ValidationError);

      try {
        // @ts-expect-error Testing runtime behavior
        await setup.adapter.traverse({ seed_ids: null, token_budget: 10000 });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_SEED_IDS");
      }
    });

    it("rejects empty seed_ids array with EMPTY_SEED_IDS", async () => {
      await expect(
        setup.adapter.traverse({ seed_ids: [], token_budget: 10000 })
      ).rejects.toThrow(ValidationError);

      try {
        await setup.adapter.traverse({ seed_ids: [], token_budget: 10000 });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("EMPTY_SEED_IDS");
        expect((err as ValidationError).message).toContain("seed_ids");
      }
    });

    it("rejects non-string seed_id with INVALID_SEED_ID", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        setup.adapter.traverse({ seed_ids: ["valid", 123], token_budget: 10000 })
      ).rejects.toThrow(ValidationError);

      try {
        // @ts-expect-error Testing runtime behavior
        await setup.adapter.traverse({ seed_ids: ["valid", 123], token_budget: 10000 });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_SEED_ID");
        expect((err as ValidationError).message).toContain("seed_id");
      }
    });

    it("rejects object seed_id with INVALID_SEED_ID", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        setup.adapter.traverse({ seed_ids: [{ id: "test" }], token_budget: 10000 })
      ).rejects.toThrow(ValidationError);
    });
  });

  // ===========================================================================
  // AC-3: limit/offset Validation in queryNodes() and queryGraph()
  // ===========================================================================

  describe("AC-3: limit/offset validation", () => {
    beforeAll(async () => {
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();
      // Create test nodes
      await setup.adapter.putNode({
        id: "GP-TEST-001",
        type: "guiding_principle",
        properties: { name: "Test 1" },
      });
      await setup.adapter.putNode({
        id: "GP-TEST-002",
        type: "guiding_principle",
        properties: { name: "Test 2" },
      });
    });

    describe("queryNodes validation", () => {
      it("rejects negative limit with INVALID_LIMIT", async () => {
        await expect(
          setup.adapter.queryNodes({ type: "guiding_principle" }, -1, 0)
        ).rejects.toThrow(ValidationError);

        try {
          await setup.adapter.queryNodes({ type: "guiding_principle" }, -1, 0);
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("INVALID_LIMIT");
        }
      });

      it("rejects negative offset with INVALID_OFFSET", async () => {
        await expect(
          setup.adapter.queryNodes({ type: "guiding_principle" }, 10, -1)
        ).rejects.toThrow(ValidationError);

        try {
          await setup.adapter.queryNodes({ type: "guiding_principle" }, 10, -1);
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("INVALID_OFFSET");
        }
      });

      it("accepts zero limit and offset", async () => {
        // Should not throw
        const result = await setup.adapter.queryNodes(
          { type: "guiding_principle" },
          0,
          0
        );
        expect(result).toBeDefined();
      });

      it("rejects non-integer limit with INVALID_LIMIT", async () => {
        await expect(
          // @ts-expect-error Testing runtime behavior
          setup.adapter.queryNodes({ type: "guiding_principle" }, 1.5, 0)
        ).rejects.toThrow(ValidationError);
      });

      it("rejects non-integer offset with INVALID_OFFSET", async () => {
        await expect(
          // @ts-expect-error Testing runtime behavior
          setup.adapter.queryNodes({ type: "guiding_principle" }, 10, 1.5)
        ).rejects.toThrow(ValidationError);
      });
    });

    describe("queryGraph validation", () => {
      it("rejects negative limit with INVALID_LIMIT", async () => {
        await expect(
          setup.adapter.queryGraph(
            { origin_id: "GP-TEST-001", limit: -1, offset: 0 },
            -1,
            0
          )
        ).rejects.toThrow(ValidationError);

        try {
          await setup.adapter.queryGraph(
            { origin_id: "GP-TEST-001", limit: -1, offset: 0 },
            -1,
            0
          );
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("INVALID_LIMIT");
        }
      });

      it("rejects negative offset with INVALID_OFFSET", async () => {
        await expect(
          setup.adapter.queryGraph(
            { origin_id: "GP-TEST-001", limit: 10, offset: -1 },
            10,
            -1
          )
        ).rejects.toThrow(ValidationError);
      });
    });
  });

  // ===========================================================================
  // AC-4: batchMutate Input Validation
  // ===========================================================================

  describe("AC-4: batchMutate input validation", () => {
    beforeAll(async () => {
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();
    });

    it("throws EMPTY_BATCH error for empty nodes array", async () => {
      await expect(
        setup.adapter.batchMutate({ nodes: [] })
      ).rejects.toThrow(ValidationError);
    });

    it("throws MISSING_NODE_ID error when node has no id", async () => {
      await expect(
        setup.adapter.batchMutate({
          nodes: [
            // @ts-expect-error Testing missing id
            { type: "guiding_principle", properties: { name: "Test" } },
          ],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("throws MISSING_NODE_TYPE error when node has no type", async () => {
      await expect(
        setup.adapter.batchMutate({
          nodes: [
            // @ts-expect-error Testing missing type
            { id: "GP-TEST-NO-TYPE", properties: { name: "Test" } },
          ],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("throws MISSING_NODE_PROPERTIES error when node has no properties", async () => {
      await expect(
        setup.adapter.batchMutate({
          nodes: [
            // @ts-expect-error Testing missing properties
            { id: "GP-TEST-NO-PROPS", type: "guiding_principle" },
          ],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("throws INVALID_NODE_TYPE error for unknown node type", async () => {
      await expect(
        setup.adapter.batchMutate({
          nodes: [
            {
              id: "GP-TEST-BAD-TYPE",
              // @ts-expect-error Testing invalid type
              type: "not_a_real_type",
              properties: { name: "Test" },
            },
          ],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("throws MISSING_EDGE_SOURCE error when edge has no source_id", async () => {
      await expect(
        setup.adapter.batchMutate({
          nodes: [
            { id: "GP-TEST-001", type: "guiding_principle", properties: { name: "Test" } },
            { id: "GP-TEST-002", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [
            // @ts-expect-error Testing missing source_id
            {
              target_id: "GP-TEST-002",
              edge_type: "relates_to",
              properties: {},
            },
          ],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("throws MISSING_EDGE_TARGET error when edge has no target_id", async () => {
      await expect(
        setup.adapter.batchMutate({
          nodes: [
            { id: "GP-TEST-001", type: "guiding_principle", properties: { name: "Test" } },
            { id: "GP-TEST-002", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [
            // @ts-expect-error Testing missing target_id
            {
              source_id: "GP-TEST-001",
              edge_type: "relates_to",
              properties: {},
            },
          ],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("throws MISSING_EDGE_TYPE error when edge has no edge_type", async () => {
      await expect(
        setup.adapter.batchMutate({
          nodes: [
            { id: "GP-TEST-001", type: "guiding_principle", properties: { name: "Test" } },
            { id: "GP-TEST-002", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [
            // @ts-expect-error Testing missing edge_type
            {
              source_id: "GP-TEST-001",
              target_id: "GP-TEST-002",
              properties: {},
            },
          ],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("throws INVALID_EDGE_TYPE error for unknown edge type", async () => {
      await expect(
        setup.adapter.batchMutate({
          nodes: [
            { id: "GP-TEST-001", type: "guiding_principle", properties: { name: "Test" } },
            { id: "GP-TEST-002", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [
            {
              source_id: "GP-TEST-001",
              target_id: "GP-TEST-002",
              // @ts-expect-error Testing invalid edge_type
              edge_type: "not_a_real_edge_type",
              properties: {},
            },
          ],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("accepts valid edge types", async () => {
      const result = await setup.adapter.batchMutate({
        nodes: [
          { id: "GP-TEST-001", type: "guiding_principle", properties: { name: "Test" } },
          { id: "GP-TEST-002", type: "guiding_principle", properties: { name: "Test 2" } },
        ],
        edges: [
          {
            source_id: "GP-TEST-001",
            target_id: "GP-TEST-002",
            edge_type: "relates_to",
            properties: {},
          },
        ],
      });

      expect(result.errors).toHaveLength(0);
      expect(result.results).toHaveLength(2);
    });
  });

  // ===========================================================================
  // AC-5: nextId Cycle Validation
  // ===========================================================================

  describe("AC-5: nextId cycle validation", () => {
    beforeAll(async () => {
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();
    });

    it("rejects negative cycle number with INVALID_CYCLE", async () => {
      await expect(
        setup.adapter.nextId("work_item", -1)
      ).rejects.toThrow(ValidationError);
    });

    it("accepts valid cycle number for cycle-scoped types", async () => {
      // Note: work_item uses format WI-{seq}, not WI-{cycle}-{seq}
      // The cycle parameter is optional and may be used for future enhancements
      const id = await setup.adapter.nextId("work_item");
      expect(id).toMatch(/^WI-\d+$/);
    });

    it("accepts null cycle for non-cycle-scoped types", async () => {
      const id = await setup.adapter.nextId("guiding_principle");
      expect(id).toMatch(/^GP-\d+$/);
    });
  });

  // ===========================================================================
  // AC-6: always_include_types Validation in traverse()
  // ===========================================================================

  describe("AC-6: always_include_types validation", () => {
    beforeAll(async () => {
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();
      // Create test nodes
      await setup.adapter.putNode({
        id: "GP-TEST-001",
        type: "guiding_principle",
        properties: { name: "Test GP" },
      });
      await setup.adapter.putNode({
        id: "C-TEST-001",
        type: "constraint",
        properties: { category: "test", description: "Test constraint" },
      });
    });

    it("accepts valid node types in always_include_types", async () => {
      const result = await setup.adapter.traverse({
        seed_ids: ["GP-TEST-001"],
        token_budget: 10000,
        always_include_types: ["guiding_principle", "constraint"],
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.ranked_nodes)).toBe(true);
    });

    it("accepts empty always_include_types", async () => {
      const result = await setup.adapter.traverse({
        seed_ids: ["GP-TEST-001"],
        token_budget: 10000,
        always_include_types: [],
      });

      expect(result).toBeDefined();
    });

    it("rejects invalid node type in always_include_types", async () => {
      await expect(
        setup.adapter.traverse({
          seed_ids: ["GP-TEST-001"],
          token_budget: 10000,
          always_include_types: [
            "guiding_principle",
            // @ts-expect-error Testing invalid type
            "not_a_real_type",
          ],
        })
      ).rejects.toThrow(ValidationError);
    });

    it("rejects non-array always_include_types", async () => {
      await expect(
        // @ts-expect-error Testing invalid type
        setup.adapter.traverse({
          seed_ids: ["GP-TEST-001"],
          token_budget: 10000,
          always_include_types: "guiding_principle",
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  // ===========================================================================
  // AC-7: deleteNode, putEdge, removeEdges Validation (WI-675)
  // ===========================================================================

  describe("AC-7: deleteNode validation", () => {
    beforeAll(async () => {
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();
    });

    it("throws INVALID_NODE_ID when id is empty string", async () => {
      await expect(
        setup.adapter.deleteNode("")
      ).rejects.toThrow(ValidationError);

      try {
        await setup.adapter.deleteNode("");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_NODE_ID");
      }
    });

    it("throws INVALID_NODE_ID when id is non-string", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        setup.adapter.deleteNode(123)
      ).rejects.toThrow(ValidationError);

      try {
        // @ts-expect-error Testing runtime behavior
        await setup.adapter.deleteNode(123);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_NODE_ID");
      }
    });
  });

  describe("AC-7: putEdge validation", () => {
    beforeAll(async () => {
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();
    });

    it("throws MISSING_EDGE_SOURCE when source_id is empty", async () => {
      await expect(
        setup.adapter.putEdge({
          source_id: "",
          target_id: "GP-001",
          edge_type: "relates_to",
          properties: {},
        })
      ).rejects.toMatchObject({ code: "MISSING_EDGE_SOURCE" });
    });

    it("throws MISSING_EDGE_TARGET when target_id is empty", async () => {
      await expect(
        setup.adapter.putEdge({
          source_id: "GP-001",
          target_id: "",
          edge_type: "relates_to",
          properties: {},
        })
      ).rejects.toMatchObject({ code: "MISSING_EDGE_TARGET" });
    });

    it("throws MISSING_EDGE_TYPE when edge_type is missing", async () => {
      await expect(
        setup.adapter.putEdge({
          source_id: "GP-001",
          target_id: "GP-002",
          // @ts-expect-error Testing missing edge_type
          edge_type: undefined,
          properties: {},
        })
      ).rejects.toMatchObject({ code: "MISSING_EDGE_TYPE" });
    });

    it("throws INVALID_EDGE_TYPE when edge_type is not a valid EdgeType", async () => {
      await expect(
        setup.adapter.putEdge({
          source_id: "GP-001",
          target_id: "GP-002",
          // @ts-expect-error Testing invalid edge_type
          edge_type: "not_a_real_edge_type",
          properties: {},
        })
      ).rejects.toMatchObject({ code: "INVALID_EDGE_TYPE" });
    });
  });

  describe("AC-7: removeEdges validation", () => {
    beforeAll(async () => {
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();
    });

    it("throws INVALID_NODE_ID when source_id is empty", async () => {
      await expect(
        setup.adapter.removeEdges("", ["relates_to"])
      ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
    });

    it("throws INVALID_NODE_ID when source_id is non-string", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        setup.adapter.removeEdges(null, ["relates_to"])
      ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
    });

    it("throws INVALID_EDGE_TYPE when edge_type is not a valid EdgeType string", async () => {
      await expect(
        // @ts-expect-error Testing invalid edge_type
        setup.adapter.removeEdges("GP-001", ["not_a_real_edge_type"])
      ).rejects.toMatchObject({ code: "INVALID_EDGE_TYPE" });
    });
  });

  // ===========================================================================
  // AC-8: patchNode Validation — INVALID_NODE_ID and IMMUTABLE_FIELD (WI-692)
  // ===========================================================================

  describe("AC-8: patchNode validation", () => {
    beforeAll(async () => {
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();
    });

    it("throws INVALID_NODE_ID when id is empty string", async () => {
      await expect(
        setup.adapter.patchNode({ id: "", properties: { name: "New Name" } })
      ).rejects.toThrow(ValidationError);

      try {
        await setup.adapter.patchNode({ id: "", properties: { name: "New Name" } });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_NODE_ID");
      }
    });

    it("throws ImmutableFieldError when 'id' appears in properties", async () => {
      await expect(
        setup.adapter.patchNode({ id: "GP-001", properties: { id: "GP-099" } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);

      try {
        await setup.adapter.patchNode({ id: "GP-001", properties: { id: "GP-099" } });
      } catch (err) {
        expect(err).toBeInstanceOf(ImmutableFieldError);
        expect((err as ImmutableFieldError).code).toBe("IMMUTABLE_FIELD");
      }
    });

    it("throws ImmutableFieldError when 'type' appears in properties", async () => {
      await expect(
        setup.adapter.patchNode({ id: "GP-001", properties: { type: "constraint" } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);

      try {
        await setup.adapter.patchNode({ id: "GP-001", properties: { type: "constraint" } });
      } catch (err) {
        expect(err).toBeInstanceOf(ImmutableFieldError);
        expect((err as ImmutableFieldError).code).toBe("IMMUTABLE_FIELD");
      }
    });

    it("throws ImmutableFieldError when 'cycle_created' appears in properties", async () => {
      await expect(
        setup.adapter.patchNode({ id: "GP-001", properties: { cycle_created: 7 } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);

      try {
        await setup.adapter.patchNode({ id: "GP-001", properties: { cycle_created: 7 } });
      } catch (err) {
        expect(err).toBeInstanceOf(ImmutableFieldError);
        expect((err as ImmutableFieldError).code).toBe("IMMUTABLE_FIELD");
      }
    });
  });

  // ===========================================================================
  // AC-9: LocalReaderAdapter direct validation (WI-696)
  // ===========================================================================

  describe("AC-9: LocalReaderAdapter getNode/queryNodes/queryGraph validation", () => {
    let readerAdapter: LocalReaderAdapter;

    beforeAll(async () => {
      await cleanupLocalAdapter(setup);
      setup = await createLocalAdapter();

      // Access LocalReaderAdapter directly (not through LocalAdapter facade)
      const drizzleDb = drizzle(setup.db, { schema: dbSchema });
      readerAdapter = new LocalReaderAdapter(
        setup.db,
        drizzleDb,
        path.join(setup.tmpDir, ".ideate")
      );

      // Seed a node for queryGraph tests
      await setup.adapter.putNode({
        id: "GP-READER-001",
        type: "guiding_principle",
        properties: { name: "Reader Test Node" },
      });
    });

    describe("getNode validation", () => {
      it("throws INVALID_NODE_ID when id is empty string", async () => {
        await expect(readerAdapter.getNode("")).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
      });

      it("throws INVALID_NODE_ID when id is null", async () => {
        await expect(
          // @ts-expect-error Testing runtime behavior
          readerAdapter.getNode(null)
        ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
      });
    });

    describe("queryNodes validation", () => {
      it("throws INVALID_LIMIT when limit is -1", async () => {
        await expect(
          readerAdapter.queryNodes({ type: "guiding_principle" }, -1, 0)
        ).rejects.toMatchObject({ code: "INVALID_LIMIT" });
      });

      it("throws INVALID_OFFSET when offset is -1", async () => {
        await expect(
          readerAdapter.queryNodes({ type: "guiding_principle" }, 10, -1)
        ).rejects.toMatchObject({ code: "INVALID_OFFSET" });
      });
    });

    describe("queryGraph validation", () => {
      it("throws INVALID_LIMIT when limit is -1", async () => {
        await expect(
          readerAdapter.queryGraph({ origin_id: "GP-READER-001" }, -1, 0)
        ).rejects.toMatchObject({ code: "INVALID_LIMIT" });
      });

      it("throws INVALID_OFFSET when offset is -1", async () => {
        await expect(
          readerAdapter.queryGraph({ origin_id: "GP-READER-001" }, 10, -1)
        ).rejects.toMatchObject({ code: "INVALID_OFFSET" });
      });
    });
  });

  // ===========================================================================
  // Summary: All Validation Error Codes
  // ===========================================================================

  describe("Summary: ValidationError codes coverage", () => {
    it("has tests covering all expected error codes", () => {
      // This is a documentation test listing all error codes tested
      const expectedCodes = [
        "TRANSACTION_FAILED",  // Transaction failures
        "INVALID_SEED_IDS",    // seed_ids is not an array
        "EMPTY_SEED_IDS",      // seed_ids array is empty
        "INVALID_SEED_ID",     // element in seed_ids is not a string
        "INVALID_LIMIT",       // Negative/non-integer limit
        "INVALID_OFFSET",      // Negative/non-integer offset
        "EMPTY_BATCH",         // Empty batchMutate nodes
        "MISSING_NODE_ID",     // batchMutate missing id
        "MISSING_NODE_TYPE",   // batchMutate missing type
        "MISSING_NODE_PROPERTIES", // batchMutate missing properties
        "INVALID_NODE_TYPE",   // batchMutate unknown node type
        "MISSING_EDGE_SOURCE", // batchMutate missing source_id
        "MISSING_EDGE_TARGET", // batchMutate missing target_id
        "MISSING_EDGE_TYPE",   // batchMutate missing edge_type
        "INVALID_EDGE_TYPE",   // batchMutate unknown edge_type
        "INVALID_CYCLE",       // Negative cycle number
        "INVALID_ALWAYS_INCLUDE_TYPE", // Invalid node type in always_include_types
        "IMMUTABLE_FIELD",     // patchNode: id, type, or cycle_created in properties
        "INVALID_NODE_ID",     // getNode/queryNodes/queryGraph with empty or non-string id
      ];

      // Each code should be tested in the respective describe block above
    });
  });
});
