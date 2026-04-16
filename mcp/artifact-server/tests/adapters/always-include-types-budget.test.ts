/**
 * always-include-types-budget.test.ts — WI-787 regression tests
 *
 * Verifies that `always_include_types` artifacts respect `token_budget`.
 *
 * Bug history (2026-04-13): `ideate_assemble_context` with default args
 * returned 226,481 characters, blowing past the MCP tool result limit.
 * Root cause: LocalContextAdapter.traverse unconditionally included every
 * node of each always_include_type without checking the budget.
 *
 * WI-787 Option 1 resolution:
 *   - Always-include types are still pulled in preference order, but the
 *     loop stops adding a node once its token count would exceed the budget.
 *   - Seeds remain force-included (explicit user request).
 *   - TraversalResult.budget_exhausted and truncated_types surface the
 *     overflow so callers can detect incomplete context.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import type { StorageAdapter } from "../../src/adapter.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

interface TestSetup {
  adapter: StorageAdapter;
  tmpDir: string;
  db: Database.Database;
}

async function createTestSetup(): Promise<TestSetup> {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ideate-budget-test-")
  );
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
  const adapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  await adapter.initialize();

  return { adapter, tmpDir, db };
}

async function cleanupTestSetup(setup: TestSetup): Promise<void> {
  try {
    await (setup.adapter as LocalAdapter).shutdown();
  } catch {
    /* ignore */
  }
  try {
    setup.db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(setup.tmpDir, { recursive: true, force: true });
}

/**
 * Seed a guiding_principle with approximately `targetKb` KB of YAML body.
 * The helper inflates the `description` field to push the file size and
 * reported token_count past the target, so budget-boundary tests can hit
 * the overflow reliably.
 */
async function seedGuidingPrinciple(
  adapter: StorageAdapter,
  id: string,
  targetKb: number
): Promise<void> {
  // Each 'x' is one byte; 1KB ~= 1024 chars. token_count roughly chars/4.
  const description = "x".repeat(targetKb * 1024);
  await adapter.putNode({
    id,
    type: "guiding_principle",
    properties: {
      name: `Principle ${id}`,
      description,
    },
  });
}

async function seedConstraint(
  adapter: StorageAdapter,
  id: string,
  targetKb: number
): Promise<void> {
  const description = "y".repeat(targetKb * 1024);
  await adapter.putNode({
    id,
    type: "constraint",
    properties: {
      category: "data",
      description,
    },
  });
}

// ---------------------------------------------------------------------------
// Tests — LocalAdapter
// ---------------------------------------------------------------------------

describe("LocalAdapter — always_include_types respects token_budget (WI-787)", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await createTestSetup();
  });

  afterEach(async () => {
    await cleanupTestSetup(setup);
  });

  it("stops adding always-include artifacts once budget would be exceeded", async () => {
    // Seed 50 guiding_principles + 50 constraints at ~1KB each = ~100KB ~25k
    // tokens if all included. Budget is 5000 tokens, so fewer than 100 nodes
    // must make it into the result.
    for (let i = 1; i <= 50; i++) {
      const pid = `GP-${String(i).padStart(3, "0")}`;
      const cid = `C-${String(i).padStart(3, "0")}`;
      await seedGuidingPrinciple(setup.adapter, pid, 1);
      await seedConstraint(setup.adapter, cid, 1);
    }

    // Seed one extra node to use as the seed_id (PPR requires a seed).
    // The seed is force-included and its tokens do not count against the
    // budget cap; assertions below check non-seed cumulative tokens.
    await seedGuidingPrinciple(setup.adapter, "GP-SEED", 1);

    const result = await setup.adapter.traverse({
      seed_ids: ["GP-SEED"],
      token_budget: 5000,
      always_include_types: ["guiding_principle", "constraint"],
    });

    // Non-seed tokens must respect the budget.
    const seedTokens = result.ranked_nodes
      .filter((rn) => rn.node.id === "GP-SEED")
      .reduce((sum, rn) => sum + (rn.node.token_count ?? 0), 0);
    const nonSeedTokens = result.total_tokens - seedTokens;
    expect(nonSeedTokens).toBeLessThanOrEqual(5000);
    // Without budget enforcement, this would include ~101 nodes.
    expect(result.ranked_nodes.length).toBeLessThan(100);
  });

  it("signals overflow via budget_exhausted and truncated_types", async () => {
    for (let i = 1; i <= 50; i++) {
      await seedGuidingPrinciple(
        setup.adapter,
        `GP-${String(i).padStart(3, "0")}`,
        1
      );
      await seedConstraint(
        setup.adapter,
        `C-${String(i).padStart(3, "0")}`,
        1
      );
    }
    await seedGuidingPrinciple(setup.adapter, "GP-SEED", 1);

    const result = await setup.adapter.traverse({
      seed_ids: ["GP-SEED"],
      token_budget: 5000,
      always_include_types: ["guiding_principle", "constraint"],
    });

    expect(result.budget_exhausted).toBe(true);
    expect(result.truncated_types).toBeDefined();
    expect(result.truncated_types!.length).toBeGreaterThan(0);
    // Both types are oversupplied relative to the budget, so at least one
    // should show up as truncated.
    const truncatedSet = new Set(result.truncated_types);
    const hasEither =
      truncatedSet.has("guiding_principle") || truncatedSet.has("constraint");
    expect(hasEither).toBe(true);
  });

  it("does not signal budget_exhausted when budget is ample", async () => {
    // Only 3 small always-include nodes; budget is large.
    await seedGuidingPrinciple(setup.adapter, "GP-001", 1);
    await seedConstraint(setup.adapter, "C-001", 1);
    await seedGuidingPrinciple(setup.adapter, "GP-SEED", 1);

    const result = await setup.adapter.traverse({
      seed_ids: ["GP-SEED"],
      token_budget: 100000,
      always_include_types: ["guiding_principle", "constraint"],
    });

    expect(result.budget_exhausted).toBeUndefined();
    expect(result.truncated_types).toBeUndefined();
  });

  it("force-includes seeds even when the seed itself exceeds budget", async () => {
    // Seed is 10KB (~2500 tokens); budget is 1000.
    await seedGuidingPrinciple(setup.adapter, "GP-SEED", 10);

    const result = await setup.adapter.traverse({
      seed_ids: ["GP-SEED"],
      token_budget: 1000,
      always_include_types: ["guiding_principle"],
    });

    // Seed is force-included, so total_tokens may exceed the budget.
    const seedInResult = result.ranked_nodes.some(
      (rn) => rn.node.id === "GP-SEED"
    );
    expect(seedInResult).toBe(true);
  });

  it("AC-1: non-seed cumulative usedTokens at end of always-include loop never exceeds token_budget", async () => {
    // Many always-include artifacts; seed is small.
    await seedGuidingPrinciple(setup.adapter, "GP-SEED", 1);
    for (let i = 1; i <= 20; i++) {
      await seedGuidingPrinciple(
        setup.adapter,
        `GP-${String(i).padStart(3, "0")}`,
        1
      );
    }

    const result = await setup.adapter.traverse({
      seed_ids: ["GP-SEED"],
      token_budget: 5000,
      always_include_types: ["guiding_principle"],
    });

    // Seed is force-included; everything else must stay within budget.
    const seedTokens = result.ranked_nodes
      .filter((rn) => rn.node.id === "GP-SEED")
      .reduce((sum, rn) => sum + (rn.node.token_count ?? 0), 0);
    const nonSeedTokens = result.total_tokens - seedTokens;
    expect(nonSeedTokens).toBeLessThanOrEqual(5000);
  });

  it("AC-2b: TraversalResult.budget_exhausted is boolean true/undefined, truncated_types is array of NodeType strings", async () => {
    for (let i = 1; i <= 10; i++) {
      await seedGuidingPrinciple(
        setup.adapter,
        `GP-${String(i).padStart(3, "0")}`,
        1
      );
    }
    await seedGuidingPrinciple(setup.adapter, "GP-SEED", 1);

    const overflow = await setup.adapter.traverse({
      seed_ids: ["GP-SEED"],
      token_budget: 500,
      always_include_types: ["guiding_principle"],
    });
    expect(typeof overflow.budget_exhausted).toBe("boolean");
    expect(overflow.budget_exhausted).toBe(true);
    expect(Array.isArray(overflow.truncated_types)).toBe(true);
    for (const t of overflow.truncated_types ?? []) {
      expect(typeof t).toBe("string");
    }

    const fits = await setup.adapter.traverse({
      seed_ids: ["GP-SEED"],
      token_budget: 100000,
      always_include_types: ["guiding_principle"],
    });
    expect(fits.budget_exhausted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Default-budget boundary test (AC-4)
// ---------------------------------------------------------------------------

describe("LocalAdapter — default budget boundary (WI-787 AC-4)", () => {
  let setup: TestSetup;

  beforeEach(async () => {
    setup = await createTestSetup();
  });

  afterEach(async () => {
    await cleanupTestSetup(setup);
  });

  it("16 GPs + 16 constraints + architecture under default budget stays under 60000 tokens", async () => {
    // Mirror the user-reported workspace shape.
    for (let i = 1; i <= 16; i++) {
      await seedGuidingPrinciple(
        setup.adapter,
        `GP-${String(i).padStart(2, "0")}`,
        7
      );
      await seedConstraint(
        setup.adapter,
        `C-${String(i).padStart(2, "0")}`,
        7
      );
    }
    // Architecture document — include as a seed so we actually have one.
    await setup.adapter.putNode({
      id: "architecture",
      type: "architecture",
      properties: { title: "Arch", content: "arch body" },
    });

    const result = await setup.adapter.traverse({
      seed_ids: ["architecture"],
      // token_budget intentionally omitted to test default (50000)
      always_include_types: [
        "architecture",
        "guiding_principle",
        "constraint",
      ],
    });

    // Default budget is 50k; AC-4 allows 20% margin for boundary artifacts.
    expect(result.total_tokens).toBeLessThanOrEqual(60000);
  });
});
