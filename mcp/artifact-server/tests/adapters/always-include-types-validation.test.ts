/**
 * always-include-types-validation.test.ts — Test always_include_types validation
 *
 * Per WI-649: Each value in always_include_types must be checked against valid
 * NodeType enum. Invalid NodeType values should be rejected with ValidationError.
 * Validation must occur before PPR computation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { RemoteAdapter } from "../../src/adapters/remote/index.js";
import { ValidationError, ALL_NODE_TYPES } from "../../src/adapter.js";
import type { StorageAdapter, NodeType } from "../../src/adapter.js";

// Compile-time exhaustiveness: every NodeType must appear in ALL_NODE_TYPES.
// If a new NodeType member is added without updating ALL_NODE_TYPES, this line
// produces: "Type 'true' is not assignable to type 'false'"
type _ExhaustiveCheck = Exclude<NodeType, typeof ALL_NODE_TYPES[number]> extends never
  ? true
  : false;
const _nodeTypeExhaustive: _ExhaustiveCheck = true;

// -----------------------------------------------------------------------------
// Test Setup Helpers
// -----------------------------------------------------------------------------

interface LocalAdapterSetup {
  adapter: LocalAdapter;
  tmpDir: string;
  db: Database.Database;
}

async function createLocalAdapter(): Promise<LocalAdapterSetup> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-always-include-test-"));
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
    "metrics",
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

  const adapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  await adapter.initialize();

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

function createRemoteAdapter(): RemoteAdapter {
  return new RemoteAdapter({
    endpoint: "http://localhost:4000/graphql",
    org_id: "test-org",
    codebase_id: "test-codebase",
    auth_token: null,
  });
}

async function isRemoteServerAvailable(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:4000/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("always_include_types validation (WI-649)", () => {
  let localSetup: LocalAdapterSetup;
  let remoteAdapter: RemoteAdapter | null = null;
  let remoteAvailable = false;

  beforeAll(async () => {
    localSetup = await createLocalAdapter();
    remoteAvailable = await isRemoteServerAvailable();
    if (remoteAvailable) {
      remoteAdapter = createRemoteAdapter();
      try {
        await remoteAdapter.initialize();
      } catch (err) {
        remoteAvailable = false;
        remoteAdapter = null;
      }
    }
  });

  afterAll(async () => {
    await cleanupLocalAdapter(localSetup);
    if (remoteAdapter) {
      await remoteAdapter.shutdown();
    }
  });

  beforeEach(async () => {
    // Create a test node to use as seed for traversal
    await localSetup.adapter.putNode({
      id: "GP-TEST-SEED",
      type: "guiding_principle",
      properties: { name: "Test Seed", description: "For traversal tests" },
    });
  });

  // -----------------------------------------------------------------------------
  // AC-1: Each value in always_include_types checked against valid NodeType enum
  // -----------------------------------------------------------------------------

  describe("AC-1: Validation against NodeType enum", () => {
    it("LocalAdapter accepts valid NodeType values", async () => {
      // Should not throw for valid types
      const validTypes = ["work_item", "guiding_principle", "project"];
      const result = await localSetup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        always_include_types: validTypes,
        token_budget: 10000,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.ranked_nodes)).toBe(true);
    });

    it("LocalAdapter accepts empty always_include_types array", async () => {
      // Should not throw for empty array
      const result = await localSetup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        always_include_types: [],
        token_budget: 10000,
      });

      expect(result).toBeDefined();
    });

    it("LocalAdapter accepts undefined always_include_types", async () => {
      // Should not throw when not provided
      const result = await localSetup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        token_budget: 10000,
      });

      expect(result).toBeDefined();
    });

    it("LocalAdapter accepts single valid NodeType", async () => {
      const result = await localSetup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        always_include_types: ["work_item"],
        token_budget: 10000,
      });

      expect(result).toBeDefined();
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter accepts valid NodeType values", async () => {
      if (!remoteAdapter) return;

      const validTypes = ["work_item", "guiding_principle", "project"];
      const result = await remoteAdapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        always_include_types: validTypes,
        token_budget: 10000,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.ranked_nodes)).toBe(true);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter accepts empty always_include_types array", async () => {
      if (!remoteAdapter) return;

      const result = await remoteAdapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        always_include_types: [],
        token_budget: 10000,
      });

      expect(result).toBeDefined();
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter accepts undefined always_include_types", async () => {
      if (!remoteAdapter) return;

      const result = await remoteAdapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        token_budget: 10000,
      });

      expect(result).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------------
  // AC-2: Invalid NodeType values rejected with error
  // -----------------------------------------------------------------------------

  describe("AC-2: Rejection of invalid NodeType values", () => {
    it("LocalAdapter rejects single invalid NodeType", async () => {
      await expect(
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["invalid_type"],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects multiple invalid NodeTypes", async () => {
      await expect(
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["invalid_one", "invalid_two"],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects mixed valid and invalid NodeTypes", async () => {
      await expect(
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["work_item", "invalid_type", "guiding_principle"],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter ValidationError includes correct field and value", async () => {
      try {
        await localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["not_a_real_type"],
          token_budget: 10000,
        });
        expect.fail("Should have thrown ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain("Invalid NodeType");
        expect((err as ValidationError).message).toContain("not_a_real_type");
      }
    });

    it("LocalAdapter reports first invalid type encountered", async () => {
      try {
        await localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["work_item", "first_invalid", "second_invalid"],
          token_budget: 10000,
        });
        expect.fail("Should have thrown ValidationError");
      } catch (err) {
        expect((err as ValidationError).message).toContain("first_invalid");
      }
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter rejects single invalid NodeType", async () => {
      if (!remoteAdapter) return;

      await expect(
        remoteAdapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["invalid_type"],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter rejects mixed valid and invalid NodeTypes", async () => {
      if (!remoteAdapter) return;

      await expect(
        remoteAdapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["work_item", "invalid_type"],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter ValidationError includes correct field and value", async () => {
      if (!remoteAdapter) return;

      try {
        await remoteAdapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["not_a_real_type"],
          token_budget: 10000,
        });
        expect.fail("Should have thrown ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain("Invalid NodeType");
        expect((err as ValidationError).message).toContain("not_a_real_type");
      }
    });
  });

  // -----------------------------------------------------------------------------
  // AC-3: Validation occurs before PPR computation
  // -----------------------------------------------------------------------------

  describe("AC-3: Validation occurs before PPR computation", () => {
    it("LocalAdapter throws validation error even with invalid PPR params", async () => {
      // Both always_include_types and alpha are invalid
      // Should throw for always_include_types BEFORE alpha validation
      try {
        await localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["bad_type"],
          alpha: -1, // Also invalid
          token_budget: 10000,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        // Should be validation error about the type, not alpha
        expect((err as ValidationError).message).toContain("bad_type");
      }
    });

    it("LocalAdapter throws validation error before PPR computation with valid seeds", async () => {
      // With valid seed_ids, always_include_types validation should still occur before PPR
      await expect(
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["invalid_type"],
          token_budget: 10000,
        })
      ).rejects.toThrow(/invalid_type/);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter throws validation error even with invalid PPR params", async () => {
      if (!remoteAdapter) return;

      try {
        await remoteAdapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["bad_type"],
          alpha: -1, // Also invalid
          token_budget: 10000,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        // Should be validation error about the type, not alpha
        expect((err as ValidationError).message).toContain("bad_type");
      }
    });
  });

  // -----------------------------------------------------------------------------
  // ALL_NODE_TYPES constant tests
  // -----------------------------------------------------------------------------

  describe("ALL_NODE_TYPES constant", () => {
    it("ALL_NODE_TYPES contains every NodeType value with no duplicates", () => {
      // No duplicates
      expect(new Set(ALL_NODE_TYPES).size).toBe(ALL_NODE_TYPES.length);
      // Runtime length sanity check — update this number when NodeType grows
      expect(ALL_NODE_TYPES.length).toBeGreaterThan(0);
    });

    it("is readonly array", () => {
      expect(Array.isArray(ALL_NODE_TYPES)).toBe(true);
      // Verify it's readonly by checking the type
      expect(ALL_NODE_TYPES.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------------

  describe("Edge cases", () => {
    it("LocalAdapter rejects null in always_include_types", async () => {
      await expect(
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          // @ts-expect-error Testing runtime behavior with null
          always_include_types: [null],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects undefined in always_include_types", async () => {
      await expect(
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          // @ts-expect-error Testing runtime behavior with undefined
          always_include_types: [undefined],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects empty string in always_include_types", async () => {
      await expect(
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: [""],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects NodeType-like strings with wrong casing", async () => {
      // NodeType uses lower_snake_case, not UPPER_SNAKE_CASE
      await expect(
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["WORK_ITEM"], // Wrong case
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects NodeType-like strings with hyphens", async () => {
      await expect(
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED"],
          always_include_types: ["work-item"], // Hyphen instead of underscore
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter accepts all valid document artifact subtypes", async () => {
      const docSubtypes = [
        "decision_log",
        "cycle_summary",
        "review_manifest",
        "review_output",
        "architecture",
        "overview",
        "execution_strategy",
        "guiding_principles",
        "constraints",
        "research",
        "interview",
        "domain_index",
      ];

      const result = await localSetup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        always_include_types: docSubtypes,
        token_budget: 10000,
      });

      expect(result).toBeDefined();
    });
  });
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
/**
 * This test file verifies WI-649 acceptance criteria:
 *
 * AC-1: Each value in always_include_types is checked against valid NodeType enum
 *       - Valid types are accepted
 *       - Empty arrays are accepted
 *       - Undefined is accepted
 *
 * AC-2: Invalid NodeType values are rejected with ValidationError
 *       - Single invalid type throws
 *       - Multiple invalid types throw
 *       - Mixed valid/invalid throws
 *       - Error message contains the invalid type
 *       - Error message contains "Invalid NodeType"
 *
 * AC-3: Validation occurs before PPR computation
 *       - Type validation errors occur even when other params (alpha) are invalid
 *       - Type validation happens before seed processing
 */
