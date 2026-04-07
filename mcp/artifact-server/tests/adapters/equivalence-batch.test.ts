/**
 * equivalence-batch.test.ts — Batch, lifecycle, and sequence operation
 * equivalence tests.
 *
 * Validates that LocalAdapter and RemoteAdapter return identical results for:
 *   - batchMutate with 3+ nodes and 2+ edges
 *   - batchMutate validation errors (DAG cycle)
 *   - nextId for each NodeType given identical starting state
 *   - archiveCycle (both succeed, counts match)
 *   - appendJournalEntry + getNode round-trip
 *   - initialize() and shutdown() lifecycle
 *
 * NOTE: Mutation tests run in their own suite (separate DualAdapters) to
 * avoid polluting fixture state for read-only tests in other files.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createDualAdapters,
  isTestServerAvailable,
  assertNodesEquivalent,
  type DualAdapters,
} from "./equivalence-helpers.js";
import type { Edge, NodeType } from "../../src/adapter.js";

// ---------------------------------------------------------------------------
// Server availability guard
// ---------------------------------------------------------------------------

const serverAvailable = isTestServerAvailable();
const suite = serverAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// AC1 + AC2: batchMutate — 3 nodes, 2 edges, and DAG cycle validation
// ---------------------------------------------------------------------------

suite("Equivalence — batchMutate operations", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  // -------------------------------------------------------------------------
  // AC1: batchMutate with 3+ nodes and 2+ edges produces equivalent results
  // -------------------------------------------------------------------------

  describe("batchMutate — 3 nodes and 2 edges", () => {
    it("creates 3 nodes and 2 edges; both adapters return equivalent results arrays", async () => {
      const nodes = [
        {
          id: "WI-EQ-BATCH-001",
          type: "work_item" as NodeType,
          properties: {
            title: "Batch test work item 1",
            status: "pending",
            complexity: "small",
            work_item_type: "feature",
            domain: "test-domain",
          },
        },
        {
          id: "WI-EQ-BATCH-002",
          type: "work_item" as NodeType,
          properties: {
            title: "Batch test work item 2",
            status: "pending",
            complexity: "small",
            work_item_type: "feature",
            domain: "test-domain",
          },
        },
        {
          id: "WI-EQ-BATCH-003",
          type: "work_item" as NodeType,
          properties: {
            title: "Batch test work item 3",
            status: "pending",
            complexity: "medium",
            work_item_type: "chore",
            domain: "test-domain",
          },
        },
      ];

      const edges: Edge[] = [
        {
          source_id: "WI-EQ-BATCH-002",
          target_id: "WI-EQ-BATCH-001",
          edge_type: "depends_on",
          properties: {},
        },
        {
          source_id: "WI-EQ-BATCH-003",
          target_id: "WI-EQ-BATCH-001",
          edge_type: "depends_on",
          properties: {},
        },
      ];

      const [localResult, remoteResult] = await Promise.all([
        adapters.local.batchMutate({ nodes, edges }),
        adapters.remote.batchMutate({ nodes, edges }),
      ]);

      // Both results arrays must have the same length (3 nodes)
      expect(localResult.results).toHaveLength(3);
      expect(remoteResult.results).toHaveLength(3);

      // Both must report no errors
      expect(localResult.errors).toHaveLength(0);
      expect(remoteResult.errors).toHaveLength(0);

      // Each result must have a valid id and status
      for (const result of localResult.results) {
        expect(result.id).toBeDefined();
        expect(["created", "updated"]).toContain(result.status);
      }
      for (const result of remoteResult.results) {
        expect(result.id).toBeDefined();
        expect(["created", "updated"]).toContain(result.status);
      }

      // The set of IDs in results must be equivalent
      const localIds = new Set(localResult.results.map((r) => r.id));
      const remoteIds = new Set(remoteResult.results.map((r) => r.id));
      expect([...localIds].sort()).toEqual([...remoteIds].sort());
    });

    it("created nodes are retrievable from both adapters after batchMutate", async () => {
      const ids = ["WI-EQ-BATCH-001", "WI-EQ-BATCH-002", "WI-EQ-BATCH-003"];

      for (const id of ids) {
        const [localNode, remoteNode] = await Promise.all([
          adapters.local.getNode(id),
          adapters.remote.getNode(id),
        ]);

        expect(localNode).not.toBeNull();
        expect(remoteNode).not.toBeNull();

        assertNodesEquivalent(localNode!, remoteNode!);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC2: batchMutate DAG cycle — validation errors reported equivalently
  // -------------------------------------------------------------------------

  describe("batchMutate — DAG cycle detection", () => {
    it("batchMutate with circular depends_on via properties.depends returns errors from both adapters", async () => {
      // Test cycle detection via properties.depends (the field LocalAdapter
      // uses for DAG validation). Edges are omitted to isolate this path.
      const nodes = [
        {
          id: "WI-EQ-CYCLE-A",
          type: "work_item" as NodeType,
          properties: {
            title: "Cycle node A",
            status: "pending",
            depends: ["WI-EQ-CYCLE-B"],
          },
        },
        {
          id: "WI-EQ-CYCLE-B",
          type: "work_item" as NodeType,
          properties: {
            title: "Cycle node B",
            status: "pending",
            depends: ["WI-EQ-CYCLE-A"],
          },
        },
      ];

      const [localResult, remoteResult] = await Promise.all([
        adapters.local.batchMutate({ nodes }),
        adapters.remote.batchMutate({ nodes }),
      ]);

      // Both adapters must report errors
      expect(localResult.errors.length).toBeGreaterThan(0);
      expect(remoteResult.errors.length).toBeGreaterThan(0);

      // Error messages should mention the cycle
      const localError = localResult.errors[0].error.toLowerCase();
      const remoteError = remoteResult.errors[0].error.toLowerCase();

      expect(localError).toMatch(/cycle|circular|dag/i);
      expect(remoteError).toMatch(/cycle|circular|dag/i);
    });
  });
});

// ---------------------------------------------------------------------------
// AC3: nextId — same next ID for each NodeType given identical starting state
// ---------------------------------------------------------------------------

suite("Equivalence — nextId", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("nextId('work_item') returns a WI-NNN formatted ID from both adapters", async () => {
    const [localId, remoteId] = await Promise.all([
      adapters.local.nextId("work_item"),
      adapters.remote.nextId("work_item"),
    ]);

    // AC: Return shape must be scalar string (not wrapped object) per P-60
    expect(typeof localId).toBe("string");
    expect(typeof remoteId).toBe("string");
    expect(localId).not.toHaveProperty("id");
    expect(remoteId).not.toHaveProperty("id");

    // Both must return a WI-NNN formatted string
    expect(localId).toMatch(/^WI-\d{3}$/);
    expect(remoteId).toMatch(/^WI-\d{3}$/);

    // Given identical fixture state (WI-001, WI-002, WI-003 exist),
    // both should agree on the next available ID.
    // If they differ, compare just the format (per implementation note).
    expect(localId).toBe(remoteId);
  });

  it("nextId('finding') returns an F-NNN-NNN formatted ID for cycle 1 from both adapters", async () => {
    const [localId, remoteId] = await Promise.all([
      adapters.local.nextId("finding", 1),
      adapters.remote.nextId("finding", 1),
    ]);

    // AC: Return shape must be scalar string (not wrapped object) per P-60
    expect(typeof localId).toBe("string");
    expect(typeof remoteId).toBe("string");
    expect(localId).not.toHaveProperty("id");
    expect(remoteId).not.toHaveProperty("id");

    // Both must return an F-cycle-seq formatted string
    expect(localId).toMatch(/^F-\d{3}-\d{3}$/);
    expect(remoteId).toMatch(/^F-\d{3}-\d{3}$/);

    // Both adapters should agree given the same fixture data
    expect(localId).toBe(remoteId);
  });

  it("nextId('journal_entry') returns a J-NNN-NNN formatted ID for cycle 1 from both adapters", async () => {
    const [localId, remoteId] = await Promise.all([
      adapters.local.nextId("journal_entry", 1),
      adapters.remote.nextId("journal_entry", 1),
    ]);

    // AC: Return shape must be scalar string (not wrapped object) per P-60
    expect(typeof localId).toBe("string");
    expect(typeof remoteId).toBe("string");
    expect(localId).not.toHaveProperty("id");
    expect(remoteId).not.toHaveProperty("id");

    // Both must return a J-cycle-seq formatted string
    expect(localId).toMatch(/^J-\d{3}-\d{3}$/);
    expect(remoteId).toMatch(/^J-\d{3}-\d{3}$/);

    // Returned ID must not collide with existing fixture entry
    expect(localId).not.toBe("J-001-001");

    // Both adapters should agree given the same fixture data
    expect(localId).toBe(remoteId);
  });
});

// ---------------------------------------------------------------------------
// AC4: archiveCycle — both succeed, structured outcome (counts) match
// ---------------------------------------------------------------------------

suite("Equivalence — archiveCycle", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("archiveCycle(1) succeeds on both adapters with consistent outcome", async () => {
    const [localResult, remoteResult] = await Promise.all([
      adapters.local.archiveCycle(1),
      adapters.remote.archiveCycle(1),
    ]);

    // Both return non-empty strings
    expect(typeof localResult).toBe("string");
    expect(localResult.length).toBeGreaterThan(0);
    expect(typeof remoteResult).toBe("string");
    expect(remoteResult.length).toBeGreaterThan(0);

    // Both must reference cycle 1
    const localNumbers = (localResult.match(/\d+/g) ?? []).map(Number);
    const remoteNumbers = (remoteResult.match(/\d+/g) ?? []).map(Number);
    expect(localNumbers).toContain(1);
    expect(remoteNumbers).toContain(1);

    // If both report work item counts, they must match
    const localWiMatch = localResult.match(/(\d+)\s+work\s+item/i);
    const remoteWiMatch = remoteResult.match(/(\d+)\s+work\s+item/i);
    if (localWiMatch && remoteWiMatch) {
      expect(parseInt(localWiMatch[1], 10)).toBe(parseInt(remoteWiMatch[1], 10));
    }
  });
});

// ---------------------------------------------------------------------------
// AC5: appendJournalEntry + getNode round-trip
// ---------------------------------------------------------------------------

suite("Equivalence — appendJournalEntry", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("appendJournalEntry creates a journal entry retrievable by getNode from both adapters", async () => {
    const args = {
      skill: "execute",
      date: "2026-04-03",
      entryType: "work-item-complete",
      body: "Equivalence batch test journal entry body.",
      cycle: 1,
    };

    const [localId, remoteId] = await Promise.all([
      adapters.local.appendJournalEntry(args),
      adapters.remote.appendJournalEntry(args),
    ]);

    // Both must return a non-empty string ID
    expect(typeof localId).toBe("string");
    expect(localId.length).toBeGreaterThan(0);

    expect(typeof remoteId).toBe("string");
    expect(remoteId.length).toBeGreaterThan(0);

    // Both IDs must follow journal entry format J-NNN-NNN
    expect(localId).toMatch(/^J-\d{3}-\d{3}$/);
    expect(remoteId).toMatch(/^J-\d{3}-\d{3}$/);

    // Retrieve each node from its own adapter and verify it exists
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode(localId),
      adapters.remote.getNode(remoteId),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.id).toBe(localId);
    expect(remoteNode!.id).toBe(remoteId);

    expect(localNode!.type).toBe("journal_entry");
    expect(remoteNode!.type).toBe("journal_entry");

    // Cross-adapter comparison: IDs should agree given identical starting state
    expect(localId).toBe(remoteId);

    const [crossLocal, crossRemote] = await Promise.all([
      adapters.local.getNode(localId),
      adapters.remote.getNode(remoteId),
    ]);
    expect(crossLocal).not.toBeNull();
    expect(crossRemote).not.toBeNull();
    assertNodesEquivalent(crossLocal!, crossRemote!);
  });
});

// ---------------------------------------------------------------------------
// AC6: initialize() and shutdown() complete without error
// ---------------------------------------------------------------------------

suite("Equivalence — initialize and shutdown lifecycle", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  it("LocalAdapter.initialize() resolves without error", async () => {
    await expect(adapters.local.initialize()).resolves.toBeUndefined();
  });

  it("RemoteAdapter.initialize() resolves without error", async () => {
    await expect(adapters.remote.initialize()).resolves.toBeUndefined();
  });

  it("LocalAdapter.shutdown() resolves without error", async () => {
    await expect(adapters.local.shutdown()).resolves.toBeUndefined();
  });

  it("RemoteAdapter.shutdown() resolves without error", async () => {
    await expect(adapters.remote.shutdown()).resolves.toBeUndefined();
  });
});
