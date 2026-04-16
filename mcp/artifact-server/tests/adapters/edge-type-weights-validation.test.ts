/**
 * edge-type-weights-validation.test.ts — Integration tests for edge_type_weights validation
 *
 * Per WI-780 / P-82: Adapter-integrated modules require integration test file
 * in tests/adapters/. Validates edge_type_weights through ValidatingAdapter
 * wrapping a real LocalAdapter (not a mock).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { ValidationError, ALL_EDGE_TYPES } from "../../src/adapter.js";
import type { StorageAdapter } from "../../src/adapter.js";
import { ValidatingAdapter } from "../../src/validating.js";

// ---------------------------------------------------------------------------
// Test Setup
// ---------------------------------------------------------------------------

interface LocalAdapterSetup {
  adapter: StorageAdapter;
  tmpDir: string;
  db: Database.Database;
}

async function createLocalAdapter(): Promise<LocalAdapterSetup> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-edge-weights-test-"));
  const ideateDir = path.join(tmpDir, ".ideate");

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

  fs.writeFileSync(
    path.join(ideateDir, "domains", "index.yaml"),
    "current_cycle: 1\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);
  createSchema(db);

  const drizzleDb = drizzle(db, { schema: dbSchema });

  const rawAdapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  await rawAdapter.initialize();
  const adapter = new ValidatingAdapter(rawAdapter);

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("edge_type_weights validation (WI-780 / P-82)", () => {
  let setup: LocalAdapterSetup;

  // Use a live EdgeType from the constant — per P-75, query the live system
  const VALID_EDGE_TYPE = ALL_EDGE_TYPES[0];

  beforeAll(async () => {
    setup = await createLocalAdapter();

    // Create a seed node for traversal
    await setup.adapter.putNode({
      id: "GP-TEST-SEED",
      type: "guiding_principle",
      properties: { name: "Test Seed", description: "For edge_type_weights tests" },
    });
  });

  afterAll(async () => {
    await cleanupLocalAdapter(setup);
  });

  // ---------------------------------------------------------------------------
  // Valid edge_type_weights accepted
  // ---------------------------------------------------------------------------

  it("accepts valid edge_type_weights with a real EdgeType key", async () => {
    const result = await setup.adapter.traverse({
      seed_ids: ["GP-TEST-SEED"],
      edge_type_weights: { [VALID_EDGE_TYPE]: 0.5 },
      token_budget: 10000,
    });

    expect(result).toBeDefined();
    expect(Array.isArray(result.ranked_nodes)).toBe(true);
  });

  it("accepts empty edge_type_weights object", async () => {
    const result = await setup.adapter.traverse({
      seed_ids: ["GP-TEST-SEED"],
      edge_type_weights: {},
      token_budget: 10000,
    });

    expect(result).toBeDefined();
  });

  it("accepts undefined edge_type_weights", async () => {
    const result = await setup.adapter.traverse({
      seed_ids: ["GP-TEST-SEED"],
      token_budget: 10000,
    });

    expect(result).toBeDefined();
  });

  it("accepts edge_type_weights with zero value", async () => {
    const result = await setup.adapter.traverse({
      seed_ids: ["GP-TEST-SEED"],
      edge_type_weights: { [VALID_EDGE_TYPE]: 0 },
      token_budget: 10000,
    });

    expect(result).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Invalid key rejected with INVALID_EDGE_TYPE
  // ---------------------------------------------------------------------------

  it("rejects invalid key with INVALID_EDGE_TYPE before PPR runs", async () => {
    try {
      await setup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        edge_type_weights: { not_a_real_edge: 1.0 },
        token_budget: 10000,
      });
      expect.fail("Should have thrown ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_EDGE_TYPE");
      expect((err as ValidationError).message).toContain("not_a_real_edge");
    }
  });

  it("rejects mixed valid and invalid keys", async () => {
    await expect(
      setup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        edge_type_weights: { [VALID_EDGE_TYPE]: 0.5, bogus_type: 1.0 },
        token_budget: 10000,
      })
    ).rejects.toThrow(ValidationError);
  });

  // ---------------------------------------------------------------------------
  // Invalid value rejected with INVALID_EDGE_WEIGHT
  // ---------------------------------------------------------------------------

  it("rejects negative value with INVALID_EDGE_WEIGHT", async () => {
    try {
      await setup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        edge_type_weights: { [VALID_EDGE_TYPE]: -1 },
        token_budget: 10000,
      });
      expect.fail("Should have thrown ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_EDGE_WEIGHT");
    }
  });

  it("rejects NaN value with INVALID_EDGE_WEIGHT", async () => {
    await expect(
      setup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        edge_type_weights: { [VALID_EDGE_TYPE]: NaN },
        token_budget: 10000,
      })
    ).rejects.toThrow(ValidationError);
  });

  it("rejects Infinity value with INVALID_EDGE_WEIGHT", async () => {
    await expect(
      setup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        edge_type_weights: { [VALID_EDGE_TYPE]: Infinity },
        token_budget: 10000,
      })
    ).rejects.toThrow(ValidationError);
  });

  // ---------------------------------------------------------------------------
  // Non-object rejected with INVALID_EDGE_WEIGHTS
  // ---------------------------------------------------------------------------

  it("rejects non-object edge_type_weights with INVALID_EDGE_WEIGHTS", async () => {
    try {
      await setup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        edge_type_weights: "bad" as any,
        token_budget: 10000,
      });
      expect.fail("Should have thrown ValidationError");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe("INVALID_EDGE_WEIGHTS");
    }
  });

  it("rejects array edge_type_weights with INVALID_EDGE_WEIGHTS", async () => {
    await expect(
      setup.adapter.traverse({
        seed_ids: ["GP-TEST-SEED"],
        edge_type_weights: [] as any,
        token_budget: 10000,
      })
    ).rejects.toThrow(ValidationError);
  });
});
