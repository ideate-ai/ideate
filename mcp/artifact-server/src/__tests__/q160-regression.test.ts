/**
 * q160-regression.test.ts — Regression tests for Q-160: cycle-slot-collision.
 *
 * Q-160 scenario: autopilot's internal cycle counter (1, 2, 3...) collides with
 * workspace cycle-directory slots that already contain legacy archived findings.
 * When autopilot picks cycle_number=1, getConvergenceData(1) sees legacy
 * cycles/001/findings/*.yaml files — with cycle: 1 and addressed_by absent —
 * and counts them as open, inflating condition_a.
 *
 * Fix (option c, recorded in the domain decision for Q-160): autopilot resolves
 * cycle_number = max(domain.current_cycle, cycles_completed) + 1 at the start
 * of each loop iteration.  This test suite verifies:
 *
 *   1. The collision IS real — getConvergenceData(1) counts legacy findings in
 *      cycles/001/findings/ as open.  This is the pre-fix failure mode.
 *
 *   2. The fix IS effective — getConvergenceData(N) for N = the skill's
 *      resolved cycle number returns zero findings, because N is above
 *      any existing workspace slot.
 *
 * See: WI-885, Q-160, skills/autopilot/SKILL.md (Resolve Cycle Number section).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../schema.js";
import * as dbSchema from "../db.js";
import { LocalAdapter } from "../adapters/local/index.js";
import { LocalReaderAdapter } from "../adapters/local/reader.js";

let tmpDir: string;
let ideateDir: string;
let db: Database.Database;
let drizzleDb: ReturnType<typeof drizzle<typeof dbSchema>>;
let adapter: LocalAdapter;
let reader: LocalReaderAdapter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-q160-test-"));
  ideateDir = path.join(tmpDir, ".ideate");

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
    "cycles",
  ]) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }

  fs.writeFileSync(
    path.join(ideateDir, "domains", "index.yaml"),
    "current_cycle: 27\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  db = new Database(dbPath);
  createSchema(db);

  drizzleDb = drizzle(db, { schema: dbSchema });
  adapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  reader = new LocalReaderAdapter(db, drizzleDb, ideateDir);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedLegacyFindings(cycle: number, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    const id = `F-LEG-${String(cycle).padStart(3, "0")}-${i}`;
    await adapter.putNode({
      id,
      type: "finding",
      cycle,
      properties: {
        severity: "significant",
        work_item: "WI-LEGACY",
        verdict: "needs-fix",
        reviewer: "legacy-reviewer",
        cycle,
        description: `Legacy finding ${id} from a prior workspace era`,
      },
    });
  }
}

/**
 * Mirrors the cycle-number resolution logic from skills/autopilot/SKILL.md.
 *
 * Step 1-3: resolved = max(current_cycle, cycles_completed) + 1
 * Step 4 guard (optional): if previousCycleNumber is provided and the result
 * would be <= previousCycleNumber, increment until strictly greater.
 * This prevents a stale current_cycle from yielding the same slot across
 * two consecutive autopilot loop iterations.
 */
function resolveCycleNumber(
  currentCycle: number,
  cyclesCompleted: number,
  previousCycleNumber?: number
): number {
  let resolved = Math.max(currentCycle, cyclesCompleted) + 1;
  if (previousCycleNumber !== undefined) {
    while (resolved <= previousCycleNumber) {
      resolved += 1;
    }
  }
  return resolved;
}

describe("Q-160 regression — cycle-slot-collision is preventable via option (c)", () => {
  it("demonstrates the pre-fix failure mode: getConvergenceData(1) counts legacy findings", async () => {
    await seedLegacyFindings(1, 11);

    const result = await reader.getConvergenceData(1);
    expect(result.findings_by_severity["significant"]).toBe(11);
  });

  it("resolveCycleNumber(current_cycle=27, cycles_completed=0) yields 28 — the first collision-free slot", () => {
    const resolved = resolveCycleNumber(27, 0);
    expect(resolved).toBe(28);
    expect(resolved).toBeGreaterThan(27);
  });

  it("resolveCycleNumber(current_cycle=27, cycles_completed=5) yields 28 — current_cycle dominates when higher", () => {
    const resolved = resolveCycleNumber(27, 5);
    expect(resolved).toBe(28);
  });

  it("resolveCycleNumber(current_cycle=3, cycles_completed=27) yields 28 — cycles_completed dominates when higher", () => {
    const resolved = resolveCycleNumber(3, 27);
    expect(resolved).toBe(28);
  });

  it("fix is effective: resolved cycle slot contains no findings even when legacy slots are populated", async () => {
    await seedLegacyFindings(1, 11);
    await seedLegacyFindings(2, 2);
    await seedLegacyFindings(3, 1);

    const resolved = resolveCycleNumber(27, 0);

    const result = await reader.getConvergenceData(resolved);
    expect(result.findings_by_severity["significant"] ?? 0).toBe(0);
  });

  it("fix is effective: new findings authored under the resolved cycle are counted and legacy slots are not", async () => {
    await seedLegacyFindings(1, 5);

    const resolved = resolveCycleNumber(27, 0);

    await adapter.putNode({
      id: `F-${resolved}-001`,
      type: "finding",
      cycle: resolved,
      properties: {
        severity: "significant",
        work_item: "WI-NEW",
        verdict: "needs-fix",
        reviewer: "new-reviewer",
        cycle: resolved,
        description: "New-era finding",
      },
    });

    const resolvedSlot = await reader.getConvergenceData(resolved);
    expect(resolvedSlot.findings_by_severity["significant"]).toBe(1);

    const legacySlot = await reader.getConvergenceData(1);
    expect(legacySlot.findings_by_severity["significant"]).toBe(5);
  });

  it("monotonic advance: resolved cycle strictly increases when cycles_completed dominates and increments", () => {
    // Use inputs where cycles_completed dominates (> current_cycle) so that
    // each increment exercises strict monotonicity rather than the fixed
    // current_cycle floor.
    const c1 = resolveCycleNumber(3, 0);  // max(3,0)+1 = 4
    const c2 = resolveCycleNumber(3, 4);  // max(3,4)+1 = 5
    const c3 = resolveCycleNumber(3, 5);  // max(3,5)+1 = 6
    expect(c1).toBe(4);
    expect(c2).toBeGreaterThan(c1);
    expect(c3).toBeGreaterThan(c2);
  });

  it("step-4 guard: second iteration returns strictly higher slot when current_cycle has not advanced", () => {
    // Simulates a review-phase interruption: autopilot runs twice with the
    // same current_cycle=27 and cycles_completed=0. Without the step-4 guard
    // both calls would return 28, causing slot collision on the second run.
    const firstIteration = resolveCycleNumber(27, 0);
    expect(firstIteration).toBe(28);

    // Second call: current_cycle unchanged, pass previous result as guard
    const secondIteration = resolveCycleNumber(27, 0, firstIteration);
    expect(secondIteration).toBeGreaterThan(firstIteration);
    expect(secondIteration).toBe(29);
  });
});
