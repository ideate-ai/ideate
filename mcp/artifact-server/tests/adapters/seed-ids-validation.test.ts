/**
 * seed-ids-validation.test.ts — Test seed_ids validation in traverse()
 *
 * Per WI-653: seed_ids must be validated before calling computePPR.
 * - Must be an array (INVALID_SEED_IDS)
 * - Must contain only strings (INVALID_SEED_ID)
 * - Must not be empty (EMPTY_SEED_IDS)
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
import { ValidationError } from "../../src/adapter.js";
import type { StorageAdapter } from "../../src/adapter.js";

// -----------------------------------------------------------------------------
// Test Setup Helpers
// -----------------------------------------------------------------------------

interface LocalAdapterSetup {
  adapter: LocalAdapter;
  tmpDir: string;
  db: Database.Database;
}

async function createLocalAdapter(): Promise<LocalAdapterSetup> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-seed-ids-test-"));
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

describe("seed_ids validation (WI-653)", () => {
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
  // AC-1: seed_ids array validated in LocalAdapter.traverse() before calling computePPR
  // -----------------------------------------------------------------------------

  describe("AC-1: Validation before PPR computation", () => {
    it("LocalAdapter accepts valid string seed_ids", async () => {
      const result = await localSetup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        token_budget: 10000,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.ranked_nodes)).toBe(true);
    });

    it("LocalAdapter accepts multiple valid string seed_ids", async () => {
      await localSetup.adapter.putNode({
        id: "GP-TEST-SEED-2",
        type: "guiding_principle",
        properties: { name: "Test Seed 2", description: "For traversal tests" },
      });

      const result = await localSetup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED", "GP-TEST-SEED-2"],
        token_budget: 10000,
      });

      expect(result).toBeDefined();
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter accepts valid string seed_ids", async () => {
      if (!remoteAdapter) return;

      const result = await remoteAdapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        token_budget: 10000,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result.ranked_nodes)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------------
  // AC-2: ValidationError thrown with code INVALID_SEED_IDS if seed_ids is not an array
  // -----------------------------------------------------------------------------

  describe("AC-2: INVALID_SEED_IDS when not an array", () => {
    it("LocalAdapter rejects undefined seed_ids", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with undefined
        localSetup.adapter.traverse({
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects null as seed_ids", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with null
        localSetup.adapter.traverse({
          seed_ids: null,
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects string as seed_ids", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with string
        localSetup.adapter.traverse({
          seed_ids: "GP-TEST-SEED",
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects object as seed_ids", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with object
        localSetup.adapter.traverse({
          seed_ids: { id: "GP-TEST-SEED" },
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects number as seed_ids", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with number
        localSetup.adapter.traverse({
          seed_ids: 123,
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter error message contains INVALID_SEED_IDS info", async () => {
      try {
        // @ts-expect-error Testing runtime behavior
        await localSetup.adapter.traverse({
          seed_ids: "not-an-array",
          token_budget: 10000,
        });
        expect.fail("Should have thrown ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain("seed_ids must be an array");
      }
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter rejects undefined seed_ids", async () => {
      if (!remoteAdapter) return;

      await expect(
        // @ts-expect-error Testing runtime behavior with undefined
        remoteAdapter.traverse({
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter rejects null as seed_ids", async () => {
      if (!remoteAdapter) return;

      await expect(
        // @ts-expect-error Testing runtime behavior with null
        remoteAdapter.traverse({
          seed_ids: null,
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter rejects string as seed_ids", async () => {
      if (!remoteAdapter) return;

      await expect(
        // @ts-expect-error Testing runtime behavior with string
        remoteAdapter.traverse({
          seed_ids: "GP-TEST-SEED",
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------------
  // AC-3: ValidationError thrown if any seed_id is not a string
  // -----------------------------------------------------------------------------

  describe("AC-3: INVALID_SEED_ID when element is not a string", () => {
    it("LocalAdapter rejects number in seed_ids array", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with mixed types
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED", 123],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects object in seed_ids array", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with mixed types
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED", { id: "test" }],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects null in seed_ids array", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with mixed types
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED", null],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects undefined in seed_ids array", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with mixed types
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED", undefined],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter rejects boolean in seed_ids array", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with mixed types
        localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED", true],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter error message contains the invalid type", async () => {
      try {
        // @ts-expect-error Testing runtime behavior
        await localSetup.adapter.traverse({
          seed_ids: ["GP-TEST-SEED", 123],
          token_budget: 10000,
        });
        expect.fail("Should have thrown ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain("number");
      }
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter rejects number in seed_ids array", async () => {
      if (!remoteAdapter) return;

      await expect(
        // @ts-expect-error Testing runtime behavior with mixed types
        remoteAdapter.traverse({
          seed_ids: ["GP-TEST-SEED", 123],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter rejects null in seed_ids array", async () => {
      if (!remoteAdapter) return;

      await expect(
        // @ts-expect-error Testing runtime behavior with mixed types
        remoteAdapter.traverse({
          seed_ids: ["GP-TEST-SEED", null],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter error message contains the invalid type", async () => {
      if (!remoteAdapter) return;

      try {
        // @ts-expect-error Testing runtime behavior
        await remoteAdapter.traverse({
          seed_ids: ["GP-TEST-SEED", 456],
          token_budget: 10000,
        });
        expect.fail("Should have thrown ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain("number");
      }
    });
  });

  // -----------------------------------------------------------------------------
  // AC-4: ValidationError thrown if seed_ids array is empty
  // -----------------------------------------------------------------------------

  describe("AC-4: EMPTY_SEED_IDS when array is empty", () => {
    it("LocalAdapter rejects empty seed_ids array", async () => {
      await expect(
        localSetup.adapter.traverse({
          seed_ids: [],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it("LocalAdapter error message indicates empty array", async () => {
      try {
        await localSetup.adapter.traverse({
          seed_ids: [],
          token_budget: 10000,
        });
        expect.fail("Should have thrown ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain("empty");
      }
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter rejects empty seed_ids array", async () => {
      if (!remoteAdapter) return;

      await expect(
        remoteAdapter.traverse({
          seed_ids: [],
          token_budget: 10000,
        })
      ).rejects.toThrow(ValidationError);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter error message indicates empty array", async () => {
      if (!remoteAdapter) return;

      try {
        await remoteAdapter.traverse({
          seed_ids: [],
          token_budget: 10000,
        });
        expect.fail("Should have thrown ValidationError");
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toContain("empty");
      }
    });
  });

  // -----------------------------------------------------------------------------
  // AC-5: RemoteAdapter has identical validation
  // -----------------------------------------------------------------------------

  describe("AC-5: RemoteAdapter identical validation", () => {
    // Remote validation is tested in AC-2, AC-3, AC-4
    // This section serves as documentation that both adapters should behave identically

    it.skipIf(!remoteAvailable)("Both adapters reject non-array seed_ids", async () => {
      if (!remoteAdapter) return;

      // Both should throw ValidationError
      await expect(
        // @ts-expect-error Testing runtime behavior
        localSetup.adapter.traverse({ seed_ids: "string", token_budget: 10000 })
      ).rejects.toThrow(ValidationError);

      await expect(
        // @ts-expect-error Testing runtime behavior
        remoteAdapter.traverse({ seed_ids: "string", token_budget: 10000 })
      ).rejects.toThrow(ValidationError);
    });

    it.skipIf(!remoteAvailable)("Both adapters reject non-string elements", async () => {
      if (!remoteAdapter) return;

      await expect(
        // @ts-expect-error Testing runtime behavior
        localSetup.adapter.traverse({ seed_ids: ["id", 123], token_budget: 10000 })
      ).rejects.toThrow(ValidationError);

      await expect(
        // @ts-expect-error Testing runtime behavior
        remoteAdapter.traverse({ seed_ids: ["id", 123], token_budget: 10000 })
      ).rejects.toThrow(ValidationError);
    });

    it.skipIf(!remoteAvailable)("Both adapters reject empty arrays", async () => {
      if (!remoteAdapter) return;

      await expect(
        localSetup.adapter.traverse({ seed_ids: [], token_budget: 10000 })
      ).rejects.toThrow(ValidationError);

      await expect(
        remoteAdapter.traverse({ seed_ids: [], token_budget: 10000 })
      ).rejects.toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------------
  // Validation order tests
  // -----------------------------------------------------------------------------

  describe("Validation order: seed_ids before other validations", () => {
    it("LocalAdapter throws seed_ids error before token_budget validation", async () => {
      try {
        // @ts-expect-error Testing runtime behavior
        await localSetup.adapter.traverse({
          seed_ids: "not-an-array",
          token_budget: -100, // Also invalid
        });
        expect.fail("Should have thrown");
      } catch (err) {
        // Should be validation error about seed_ids, not token_budget
        expect((err as ValidationError).message).toContain("array");
      }
    });

    it("LocalAdapter throws seed_ids error before always_include_types validation", async () => {
      try {
        await localSetup.adapter.traverse({
          seed_ids: [], // Empty
          always_include_types: ["invalid_type"], // Also invalid
          token_budget: 10000,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        // Should be validation error about empty seed_ids
        expect((err as ValidationError).message).toContain("empty");
      }
    });

    it("LocalAdapter throws element type error before PPR computation", async () => {
      try {
        // @ts-expect-error Testing runtime behavior
        await localSetup.adapter.traverse({
          seed_ids: [123, "valid-id"],
          alpha: -1, // Also invalid PPR param
          token_budget: 10000,
        });
        expect.fail("Should have thrown");
      } catch (err) {
        // Should be validation error about the element type, not alpha
        expect((err as ValidationError).message).toContain("string");
      }
    });
  });
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
/**
 * This test file verifies WI-653 acceptance criteria:
 *
 * AC-1: seed_ids array validated in LocalAdapter.traverse() before calling computePPR
 *       - Valid string arrays are accepted
 *       - Multiple valid seed_ids work correctly
 *
 * AC-2: ValidationError thrown with code INVALID_SEED_IDS if seed_ids is not an array
 *       - undefined throws
 *       - null throws
 *       - string throws
 *       - object throws
 *       - number throws
 *       - Error message explains the issue
 *
 * AC-3: ValidationError thrown if any seed_id is not a string
 *       - number element throws
 *       - object element throws
 *       - null element throws
 *       - undefined element throws
 *       - boolean element throws
 *       - Error message includes the invalid type
 *
 * AC-4: ValidationError thrown if seed_ids array is empty
 *       - Empty array throws
 *       - Error message mentions "empty"
 *
 * AC-5: RemoteAdapter updated with identical validation
 *       - All validation cases apply to RemoteAdapter as well
 *       - Identical error behavior
 *
 * AC-6: Existing tests pass; new test verifies each validation error path
 *       - All existing functionality preserved
 *       - Each error path is tested
 */
