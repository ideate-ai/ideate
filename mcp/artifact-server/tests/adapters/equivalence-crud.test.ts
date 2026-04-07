/**
 * equivalence-crud.test.ts — Node CRUD and edge operation equivalence tests.
 *
 * Validates that LocalAdapter and RemoteAdapter return identical results for:
 *   - getNode (all ~20 fixture artifacts)
 *   - getNodes (batch of 5+ IDs)
 *   - readNodeContent (all fixture artifacts, compared as parsed objects)
 *   - getEdges (outgoing, incoming, both)
 *   - All 6 schema v5 extension columns
 *   - putNode + getNode round-trip
 *   - patchNode + getNode
 *   - deleteNode + getNode
 *
 * Requires the Docker Compose test stack to be running:
 *   docker compose -f docker-compose.test.yml up -d
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  createDualAdapters,
  isTestServerAvailable,
  assertNodesEquivalent,
  assertEdgesEquivalent,
  type DualAdapters,
} from "./equivalence-helpers.js";
import type { MutateNodeInput } from "../../src/adapter.js";

// ---------------------------------------------------------------------------
// Server availability check
// ---------------------------------------------------------------------------

const serverAvailable = isTestServerAvailable();
const suite = serverAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// All fixture artifact IDs
// ---------------------------------------------------------------------------

const ALL_FIXTURE_IDS = [
  "WI-001",
  "WI-002",
  "WI-003",
  "GP-01",
  "GP-02",
  "C-01",
  "P-01",
  "D-01",
  "D-02",
  "Q-01",
  "MS-01",
  "PR-001",
  "PH-001",
  "PH-002",
  "F-WI-001-001",
  "J-001-001",
  "ME-001",
  "ME-002",
  "RF-001",
] as const;

// ---------------------------------------------------------------------------
// Read-only equivalence tests (fixture data)
// ---------------------------------------------------------------------------

suite("Equivalence — Node CRUD and Edge Operations", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) {
      await adapters.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // AC1: getNode returns identical Node for every fixture artifact ID
  // -------------------------------------------------------------------------

  describe("getNode — all fixture artifacts", () => {
    for (const id of ALL_FIXTURE_IDS) {
      it(`getNode("${id}") returns identical Node from both adapters`, async () => {
        const [localNode, remoteNode] = await Promise.all([
          adapters.local.getNode(id),
          adapters.remote.getNode(id),
        ]);

        expect(localNode).not.toBeNull();
        expect(remoteNode).not.toBeNull();

        assertNodesEquivalent(localNode!, remoteNode!);
      });
    }
  });

  // -------------------------------------------------------------------------
  // AC2: getNodes returns identical Map for a batch of 5+ IDs
  // -------------------------------------------------------------------------

  describe("getNodes — batch operations", () => {
    it("getNodes returns identical Map for a batch of 5 IDs", async () => {
      const batchIds = ["WI-001", "WI-002", "GP-01", "PH-001", "PR-001"];

      const [localMap, remoteMap] = await Promise.all([
        adapters.local.getNodes(batchIds),
        adapters.remote.getNodes(batchIds),
      ]);

      expect(localMap.size).toBe(5);
      expect(remoteMap.size).toBe(5);

      for (const id of batchIds) {
        expect(localMap.has(id)).toBe(true);
        expect(remoteMap.has(id)).toBe(true);
        assertNodesEquivalent(localMap.get(id)!, remoteMap.get(id)!);
      }
    });

    it("getNodes returns identical Map for a larger batch of 8 IDs", async () => {
      const batchIds = ["WI-001", "WI-002", "WI-003", "GP-01", "GP-02", "D-01", "D-02", "Q-01"];

      const [localMap, remoteMap] = await Promise.all([
        adapters.local.getNodes(batchIds),
        adapters.remote.getNodes(batchIds),
      ]);

      expect(localMap.size).toBe(8);
      expect(remoteMap.size).toBe(8);

      for (const id of batchIds) {
        expect(localMap.has(id)).toBe(true);
        expect(remoteMap.has(id)).toBe(true);
        assertNodesEquivalent(localMap.get(id)!, remoteMap.get(id)!);
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC3: readNodeContent returns non-empty string for every fixture artifact
  // Compare parsed objects (YAML vs JSON serialization may differ)
  // -------------------------------------------------------------------------

  describe("readNodeContent — all fixture artifacts", () => {
    // Parse content — try JSON first, fall back to YAML
    const parseContent = (content: string): unknown => {
      try {
        return JSON.parse(content);
      } catch {
        return parseYaml(content);
      }
    };

    for (const id of ALL_FIXTURE_IDS) {
      it(`readNodeContent("${id}") returns non-empty equivalent content from both adapters`, async () => {
        const [localContent, remoteContent] = await Promise.all([
          adapters.local.readNodeContent(id),
          adapters.remote.readNodeContent(id),
        ]);

        expect(typeof localContent).toBe("string");
        expect(localContent.length).toBeGreaterThan(0);

        expect(typeof remoteContent).toBe("string");
        expect(remoteContent.length).toBeGreaterThan(0);

        // Compare parsed content across adapters
        const localParsed = parseContent(localContent) as Record<string, unknown>;
        const remoteParsed = parseContent(remoteContent) as Record<string, unknown>;
        expect(localParsed.id).toBe(remoteParsed.id);
        expect(localParsed.type).toBe(remoteParsed.type);
      });
    }
  });

  // -------------------------------------------------------------------------
  // AC4: getEdges(id, 'outgoing') — WI-001 known outgoing edges
  // Expected: belongs_to_phase→PH-001, belongs_to_domain→artifact-structure,
  //           governed_by→GP-01, blocks→WI-002
  // -------------------------------------------------------------------------

  describe("getEdges — outgoing", () => {
    it("getEdges(WI-001, outgoing) returns identical edge sets from both adapters", async () => {
      const [localEdges, remoteEdges] = await Promise.all([
        adapters.local.getEdges("WI-001", "outgoing"),
        adapters.remote.getEdges("WI-001", "outgoing"),
      ]);

      assertEdgesEquivalent(localEdges, remoteEdges);
    });

    it("getEdges(WI-001, outgoing) includes all 4 known outgoing edges", async () => {
      const localEdges = await adapters.local.getEdges("WI-001", "outgoing");

      const edgeKey = (source: string, type: string, target: string) =>
        `${source}|${type}|${target}`;

      const localKeys = new Set(
        localEdges.map((e) => edgeKey(e.source_id, e.edge_type, e.target_id))
      );

      expect(localKeys.has(edgeKey("WI-001", "belongs_to_phase", "PH-001"))).toBe(true);
      expect(localKeys.has(edgeKey("WI-001", "belongs_to_domain", "artifact-structure"))).toBe(true);
      expect(localKeys.has(edgeKey("WI-001", "governed_by", "GP-01"))).toBe(true);
      expect(localKeys.has(edgeKey("WI-001", "blocks", "WI-002"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC5: getEdges(id, 'incoming') — GP-01 known incoming edges
  // Expected: governed_by from WI-001, governed_by from WI-002,
  //           derived_from from P-01
  // -------------------------------------------------------------------------

  describe("getEdges — incoming", () => {
    it("getEdges(GP-01, incoming) returns identical edge sets from both adapters", async () => {
      const [localEdges, remoteEdges] = await Promise.all([
        adapters.local.getEdges("GP-01", "incoming"),
        adapters.remote.getEdges("GP-01", "incoming"),
      ]);

      assertEdgesEquivalent(localEdges, remoteEdges);
    });

    it("getEdges(GP-01, incoming) includes governed_by from WI-001 and WI-002, and derived_from from P-01", async () => {
      const localEdges = await adapters.local.getEdges("GP-01", "incoming");

      const edgeKey = (source: string, type: string, target: string) =>
        `${source}|${type}|${target}`;

      const localKeys = new Set(
        localEdges.map((e) => edgeKey(e.source_id, e.edge_type, e.target_id))
      );

      expect(localKeys.has(edgeKey("WI-001", "governed_by", "GP-01"))).toBe(true);
      expect(localKeys.has(edgeKey("WI-002", "governed_by", "GP-01"))).toBe(true);
      expect(localKeys.has(edgeKey("P-01", "derived_from", "GP-01"))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // AC6: getEdges(id, 'both') — combined edge sets
  // -------------------------------------------------------------------------

  describe("getEdges — both directions", () => {
    it("getEdges(WI-001, both) returns identical combined edge sets from both adapters", async () => {
      const [localEdges, remoteEdges] = await Promise.all([
        adapters.local.getEdges("WI-001", "both"),
        adapters.remote.getEdges("WI-001", "both"),
      ]);

      assertEdgesEquivalent(localEdges, remoteEdges);
    });

    it("getEdges(WI-001, both) includes both outgoing and incoming edges", async () => {
      const edges = await adapters.local.getEdges("WI-001", "both");

      // Outgoing: WI-001 is source
      const outgoing = edges.filter((e) => e.source_id === "WI-001");
      // Incoming: WI-001 is target (e.g. depends_on from WI-002, WI-003)
      const incoming = edges.filter((e) => e.target_id === "WI-001");

      expect(outgoing.length).toBeGreaterThanOrEqual(4); // the 4 known outgoing edges
      expect(incoming.length).toBeGreaterThanOrEqual(1); // at least depends_on from WI-002
    });

    it("getEdges(GP-01, both) union equals outgoing + incoming without duplicates", async () => {
      const [outgoing, incoming, both] = await Promise.all([
        adapters.local.getEdges("GP-01", "outgoing"),
        adapters.local.getEdges("GP-01", "incoming"),
        adapters.local.getEdges("GP-01", "both"),
      ]);

      // 'both' should contain at least as many edges as the max of outgoing and incoming
      // and no more than outgoing.length + incoming.length (no duplicates)
      expect(both.length).toBeGreaterThanOrEqual(Math.max(outgoing.length, incoming.length));
      expect(both.length).toBeLessThanOrEqual(outgoing.length + incoming.length);
    });
  });

  // -------------------------------------------------------------------------
  // AC7: All 6 schema v5 extension columns present and equal in node properties
  // -------------------------------------------------------------------------

  describe("Schema v5 extension columns", () => {
    it("WI-001 properties.resolution is a non-null string (equal in both adapters)", async () => {
      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("WI-001"),
        adapters.remote.getNode("WI-001"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      expect(typeof localNode!.properties.resolution).toBe("string");
      expect(localNode!.properties.resolution).not.toBeNull();
      expect(localNode!.properties.resolution).toBe(remoteNode!.properties.resolution);
    });

    it("WI-002 properties.resolution is null in both adapters", async () => {
      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("WI-002"),
        adapters.remote.getNode("WI-002"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      expect(localNode!.properties.resolution).toBeNull();
      expect(remoteNode!.properties.resolution).toBeNull();
    });

    it("F-WI-001-001 properties.title is a non-null string (equal in both adapters)", async () => {
      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("F-WI-001-001"),
        adapters.remote.getNode("F-WI-001-001"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      expect(typeof localNode!.properties.title).toBe("string");
      expect(localNode!.properties.title).not.toBeNull();
      expect(localNode!.properties.title).toBe(remoteNode!.properties.title);
    });

    it("D-01 properties.title and properties.source are non-null strings (equal in both adapters)", async () => {
      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("D-01"),
        adapters.remote.getNode("D-01"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      // title
      expect(typeof localNode!.properties.title).toBe("string");
      expect(localNode!.properties.title).not.toBeNull();
      expect(localNode!.properties.title).toBe(remoteNode!.properties.title);

      // source
      expect(typeof localNode!.properties.source).toBe("string");
      expect(localNode!.properties.source).not.toBeNull();
      expect(localNode!.properties.source).toBe(remoteNode!.properties.source);
    });

    it("D-02 properties.title and properties.source are null in both adapters", async () => {
      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("D-02"),
        adapters.remote.getNode("D-02"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      expect(localNode!.properties.title).toBeNull();
      expect(remoteNode!.properties.title).toBeNull();

      expect(localNode!.properties.source).toBeNull();
      expect(remoteNode!.properties.source).toBeNull();
    });

    it("PH-001 properties.completed_date is a non-null string (equal in both adapters)", async () => {
      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("PH-001"),
        adapters.remote.getNode("PH-001"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      expect(typeof localNode!.properties.completed_date).toBe("string");
      expect(localNode!.properties.completed_date).not.toBeNull();
      expect(localNode!.properties.completed_date).toBe(remoteNode!.properties.completed_date);
    });

    it("PH-002 properties.completed_date is null in both adapters", async () => {
      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("PH-002"),
        adapters.remote.getNode("PH-002"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      expect(localNode!.properties.completed_date).toBeNull();
      expect(remoteNode!.properties.completed_date).toBeNull();
    });

    it("PR-001 properties.current_phase_id is a non-null string (equal in both adapters)", async () => {
      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("PR-001"),
        adapters.remote.getNode("PR-001"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      expect(typeof localNode!.properties.current_phase_id).toBe("string");
      expect(localNode!.properties.current_phase_id).not.toBeNull();
      expect(localNode!.properties.current_phase_id).toBe(remoteNode!.properties.current_phase_id);
    });
  });
});

// ---------------------------------------------------------------------------
// Write equivalence tests (isolated to avoid polluting fixture state)
// ---------------------------------------------------------------------------

suite("Equivalence — Write Operations (putNode, patchNode, deleteNode)", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) {
      await adapters.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // AC8: putNode + getNode round-trip produces equivalent results on both adapters
  // -------------------------------------------------------------------------

  describe("putNode + getNode round-trip", () => {
    it("putNode creates a new work_item; getNode returns equivalent node from both adapters", async () => {
      const input: MutateNodeInput = {
        id: "WI-EQ-RT-001",
        type: "work_item",
        properties: {
          title: "Equivalence round-trip test item",
          status: "pending",
          complexity: "small",
          work_item_type: "chore",
          domain: "test-domain",
        },
      };

      const [localResult, remoteResult] = await Promise.all([
        adapters.local.putNode(input),
        adapters.remote.putNode(input),
      ]);

      expect(localResult.id).toBe("WI-EQ-RT-001");
      expect(remoteResult.id).toBe("WI-EQ-RT-001");
      expect(localResult.status).toBe("created");
      expect(remoteResult.status).toBe("created");

      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("WI-EQ-RT-001"),
        adapters.remote.getNode("WI-EQ-RT-001"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      assertNodesEquivalent(localNode!, remoteNode!);
    });

    it("putNode on existing ID updates the node; both adapters return updated node", async () => {
      const id = "WI-EQ-RT-002";
      const initial: MutateNodeInput = {
        id,
        type: "work_item",
        properties: {
          title: "Initial title",
          status: "pending",
        },
      };

      // Create
      await Promise.all([
        adapters.local.putNode(initial),
        adapters.remote.putNode(initial),
      ]);

      // Update via putNode
      const updated: MutateNodeInput = {
        id,
        type: "work_item",
        properties: {
          title: "Updated title",
          status: "in_progress",
        },
      };

      const [localResult, remoteResult] = await Promise.all([
        adapters.local.putNode(updated),
        adapters.remote.putNode(updated),
      ]);

      expect(localResult.status).toBe("updated");
      expect(remoteResult.status).toBe("updated");

      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode(id),
        adapters.remote.getNode(id),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      assertNodesEquivalent(localNode!, remoteNode!);
      expect(localNode!.properties.title).toBe("Updated title");
      expect(remoteNode!.properties.title).toBe("Updated title");
    });

    it("putNode round-trip preserves a guiding_principle node equivalently", async () => {
      const input: MutateNodeInput = {
        id: "GP-EQ-RT-01",
        type: "guiding_principle",
        properties: {
          name: "Equivalence must hold across adapters",
          description: "Both local and remote adapters must return identical data.",
          status: "active",
        },
      };

      await Promise.all([
        adapters.local.putNode(input),
        adapters.remote.putNode(input),
      ]);

      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode("GP-EQ-RT-01"),
        adapters.remote.getNode("GP-EQ-RT-01"),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      assertNodesEquivalent(localNode!, remoteNode!);
    });
  });

  // -------------------------------------------------------------------------
  // AC9: patchNode + getNode produces equivalent results on both adapters
  // -------------------------------------------------------------------------

  describe("patchNode + getNode", () => {
    it("patchNode updates status; both adapters return equivalent node after patch", async () => {
      const id = "WI-EQ-PATCH-001";

      // Create the node in both adapters
      await Promise.all([
        adapters.local.putNode({
          id,
          type: "work_item",
          properties: {
            title: "Patch test item",
            status: "pending",
          },
        }),
        adapters.remote.putNode({
          id,
          type: "work_item",
          properties: {
            title: "Patch test item",
            status: "pending",
          },
        }),
      ]);

      // Patch status in both adapters
      const [localPatchResult, remotePatchResult] = await Promise.all([
        adapters.local.patchNode({ id, properties: { status: "in_progress" } }),
        adapters.remote.patchNode({ id, properties: { status: "in_progress" } }),
      ]);

      expect(localPatchResult.status).toBe("updated");
      expect(remotePatchResult.status).toBe("updated");

      // Verify both adapters return equivalent node after patch
      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode(id),
        adapters.remote.getNode(id),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      assertNodesEquivalent(localNode!, remoteNode!);
      expect(localNode!.status).toBe("in_progress");
      expect(remoteNode!.status).toBe("in_progress");
    });

    it("patchNode updates a property field; both adapters return equivalent node", async () => {
      const id = "WI-EQ-PATCH-002";

      await Promise.all([
        adapters.local.putNode({
          id,
          type: "work_item",
          properties: {
            title: "Property patch test",
            status: "pending",
            complexity: "small",
          },
        }),
        adapters.remote.putNode({
          id,
          type: "work_item",
          properties: {
            title: "Property patch test",
            status: "pending",
            complexity: "small",
          },
        }),
      ]);

      await Promise.all([
        adapters.local.patchNode({ id, properties: { complexity: "medium" } }),
        adapters.remote.patchNode({ id, properties: { complexity: "medium" } }),
      ]);

      const [localNode, remoteNode] = await Promise.all([
        adapters.local.getNode(id),
        adapters.remote.getNode(id),
      ]);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      assertNodesEquivalent(localNode!, remoteNode!);
      expect(localNode!.properties.complexity).toBe("medium");
      expect(remoteNode!.properties.complexity).toBe("medium");
    });

    it("patchNode returns not_found for a missing node in both adapters", async () => {
      const [localResult, remoteResult] = await Promise.all([
        adapters.local.patchNode({ id: "WI-EQ-MISSING-999", properties: { status: "done" } }),
        adapters.remote.patchNode({ id: "WI-EQ-MISSING-999", properties: { status: "done" } }),
      ]);

      expect(localResult.status).toBe("not_found");
      expect(remoteResult.status).toBe("not_found");
    });
  });

  // -------------------------------------------------------------------------
  // AC10: deleteNode + getNode produces null from both adapters
  // -------------------------------------------------------------------------

  describe("deleteNode + getNode", () => {
    it("deleteNode removes node; getNode returns null from both adapters", async () => {
      const id = "WI-EQ-DEL-001";

      // Create the node in both adapters
      await Promise.all([
        adapters.local.putNode({
          id,
          type: "work_item",
          properties: {
            title: "Delete test item",
            status: "pending",
          },
        }),
        adapters.remote.putNode({
          id,
          type: "work_item",
          properties: {
            title: "Delete test item",
            status: "pending",
          },
        }),
      ]);

      // Confirm both have the node
      const [localBefore, remoteBefore] = await Promise.all([
        adapters.local.getNode(id),
        adapters.remote.getNode(id),
      ]);
      expect(localBefore).not.toBeNull();
      expect(remoteBefore).not.toBeNull();

      // Delete from both adapters
      const [localDeleteResult, remoteDeleteResult] = await Promise.all([
        adapters.local.deleteNode(id),
        adapters.remote.deleteNode(id),
      ]);

      expect(localDeleteResult.status).toBe("deleted");
      expect(remoteDeleteResult.status).toBe("deleted");

      // Confirm both return null after deletion
      const [localAfter, remoteAfter] = await Promise.all([
        adapters.local.getNode(id),
        adapters.remote.getNode(id),
      ]);

      expect(localAfter).toBeNull();
      expect(remoteAfter).toBeNull();
    });

    it("deleteNode on already-deleted node returns not_found from both adapters", async () => {
      const id = "WI-EQ-DEL-002";

      // Create and delete
      await Promise.all([
        adapters.local.putNode({
          id,
          type: "work_item",
          properties: { title: "Double delete test", status: "pending" },
        }),
        adapters.remote.putNode({
          id,
          type: "work_item",
          properties: { title: "Double delete test", status: "pending" },
        }),
      ]);

      await Promise.all([
        adapters.local.deleteNode(id),
        adapters.remote.deleteNode(id),
      ]);

      // Second delete
      const [localResult, remoteResult] = await Promise.all([
        adapters.local.deleteNode(id),
        adapters.remote.deleteNode(id),
      ]);

      expect(localResult.status).toBe("not_found");
      expect(remoteResult.status).toBe("not_found");
    });

    it("deleteNode removes a non-work-item node; getNode returns null from both adapters", async () => {
      const id = "GP-EQ-DEL-01";

      await Promise.all([
        adapters.local.putNode({
          id,
          type: "guiding_principle",
          properties: { name: "Delete GP test", status: "active" },
        }),
        adapters.remote.putNode({
          id,
          type: "guiding_principle",
          properties: { name: "Delete GP test", status: "active" },
        }),
      ]);

      await Promise.all([
        adapters.local.deleteNode(id),
        adapters.remote.deleteNode(id),
      ]);

      const [localAfter, remoteAfter] = await Promise.all([
        adapters.local.getNode(id),
        adapters.remote.getNode(id),
      ]);

      expect(localAfter).toBeNull();
      expect(remoteAfter).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // putEdge + getEdges equivalence
  // -------------------------------------------------------------------------

  describe("putEdge + getEdges", () => {
    it("putEdge creates an edge retrievable via getEdges from both adapters", async () => {
      const srcId = "WI-EQ-EDGE-SRC";
      const tgtId = "WI-EQ-EDGE-TGT";

      // Create source and target nodes on both adapters
      await Promise.all([
        adapters.local.putNode({ id: srcId, type: "work_item", properties: { title: "Edge source", status: "pending" } }),
        adapters.remote.putNode({ id: srcId, type: "work_item", properties: { title: "Edge source", status: "pending" } }),
        adapters.local.putNode({ id: tgtId, type: "work_item", properties: { title: "Edge target", status: "pending" } }),
        adapters.remote.putNode({ id: tgtId, type: "work_item", properties: { title: "Edge target", status: "pending" } }),
      ]);

      // putEdge on both
      await Promise.all([
        adapters.local.putEdge({ source_id: srcId, target_id: tgtId, edge_type: "depends_on", properties: {} }),
        adapters.remote.putEdge({ source_id: srcId, target_id: tgtId, edge_type: "depends_on", properties: {} }),
      ]);

      // Verify edge exists on both
      const [localEdges, remoteEdges] = await Promise.all([
        adapters.local.getEdges(srcId, "outgoing"),
        adapters.remote.getEdges(srcId, "outgoing"),
      ]);

      assertEdgesEquivalent(localEdges, remoteEdges);
      expect(localEdges.some(e => e.target_id === tgtId && e.edge_type === "depends_on")).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // removeEdges equivalence
  // -------------------------------------------------------------------------

  describe("removeEdges", () => {
    it("removeEdges removes edges; getEdges returns equivalent empty set from both adapters", async () => {
      const srcId = "WI-EQ-RMEDGE-SRC";
      const tgtId = "WI-EQ-RMEDGE-TGT";

      // Create nodes and edge on both
      await Promise.all([
        adapters.local.putNode({ id: srcId, type: "work_item", properties: { title: "RemoveEdge source", status: "pending" } }),
        adapters.remote.putNode({ id: srcId, type: "work_item", properties: { title: "RemoveEdge source", status: "pending" } }),
        adapters.local.putNode({ id: tgtId, type: "work_item", properties: { title: "RemoveEdge target", status: "pending" } }),
        adapters.remote.putNode({ id: tgtId, type: "work_item", properties: { title: "RemoveEdge target", status: "pending" } }),
      ]);

      await Promise.all([
        adapters.local.putEdge({ source_id: srcId, target_id: tgtId, edge_type: "depends_on", properties: {} }),
        adapters.remote.putEdge({ source_id: srcId, target_id: tgtId, edge_type: "depends_on", properties: {} }),
      ]);

      // Remove the edge on both
      await Promise.all([
        adapters.local.removeEdges(srcId, ["depends_on"]),
        adapters.remote.removeEdges(srcId, ["depends_on"]),
      ]);

      // Verify edge is gone from both
      const [localEdges, remoteEdges] = await Promise.all([
        adapters.local.getEdges(srcId, "outgoing"),
        adapters.remote.getEdges(srcId, "outgoing"),
      ]);

      assertEdgesEquivalent(localEdges, remoteEdges);
      expect(localEdges.some(e => e.target_id === tgtId && e.edge_type === "depends_on")).toBe(false);
    });
  });
});
