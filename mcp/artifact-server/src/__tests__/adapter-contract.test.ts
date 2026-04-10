/**
 * adapter-contract.test.ts — StorageAdapter contract tests.
 *
 * Defines what it means to be a correct StorageAdapter implementation.
 * Uses a factory pattern: runAdapterContractTests() accepts an adapter
 * factory + cleanup function and runs the full suite against it. When the
 * RemoteAdapter is built, its test file calls this factory with a
 * RemoteAdapter instance.
 *
 * Current invocation: LocalAdapter with a temp dir + temp SQLite DB.
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
import type {
  StorageAdapter,
  MutateNodeInput,
  NodeType,
  Edge,
} from "../adapter.js";
import { ImmutableFieldError, ValidationError } from "../adapter.js";

// ---------------------------------------------------------------------------
// Contract test factory
// ---------------------------------------------------------------------------

export interface AdapterContractOptions {
  /**
   * If true, skip traverse() tests. Set this for partial implementations
   * where traverse() is not yet implemented (e.g. LocalAdapter before WI-554).
   */
  skipTraverse?: boolean;
}

/**
 * Export a factory that any StorageAdapter implementation can use to
 * validate conformance to the StorageAdapter contract.
 *
 * @param createAdapter  Returns a ready-to-use adapter instance.
 * @param cleanupAdapter Called after every test to tear down the instance.
 * @param options        Optional flags to skip unimplemented operations.
 */
export function runAdapterContractTests(
  createAdapter: () => Promise<StorageAdapter>,
  cleanupAdapter: (adapter: StorageAdapter) => Promise<void>,
  options: AdapterContractOptions = {}
): void {
  describe("StorageAdapter Contract", () => {
    let adapter: StorageAdapter;

    beforeEach(async () => {
      adapter = await createAdapter();
    });

    afterEach(async () => {
      await cleanupAdapter(adapter);
    });

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    describe("Lifecycle", () => {
      it("initialize() resolves without error", async () => {
        await expect(adapter.initialize()).resolves.toBeUndefined();
      });

      it("shutdown() resolves without error", async () => {
        await expect(adapter.shutdown()).resolves.toBeUndefined();
      });

      it("initialize() is idempotent — calling twice does not throw", async () => {
        await adapter.initialize();
        await expect(adapter.initialize()).resolves.toBeUndefined();
      });
    });

    // -----------------------------------------------------------------------
    // CRUD — putNode / getNode / patchNode / deleteNode
    // -----------------------------------------------------------------------

    describe("CRUD", () => {
      it("putNode creates a new node (status: created)", async () => {
        const input: MutateNodeInput = {
          id: "GP-01",
          type: "guiding_principle",
          properties: { name: "Test Principle", description: "A test principle." },
        };
        const result = await adapter.putNode(input);
        expect(result.id).toBe("GP-01");
        expect(result.status).toBe("created");
      });

      it("getNode retrieves the node after putNode", async () => {
        await adapter.putNode({
          id: "GP-02",
          type: "guiding_principle",
          properties: { name: "Retrievable", description: "Can be fetched." },
        });
        const node = await adapter.getNode("GP-02");
        expect(node).not.toBeNull();
        expect(node!.id).toBe("GP-02");
        expect(node!.type).toBe("guiding_principle");
        expect(node!.properties.name).toBe("Retrievable");
      });

      it("getNode returns null for a missing node", async () => {
        const node = await adapter.getNode("MISSING-999");
        expect(node).toBeNull();
      });

      it("getNodes returns a map containing requested nodes", async () => {
        await adapter.putNode({
          id: "GP-03",
          type: "guiding_principle",
          properties: { name: "Batch One" },
        });
        await adapter.putNode({
          id: "GP-04",
          type: "guiding_principle",
          properties: { name: "Batch Two" },
        });
        const result = await adapter.getNodes(["GP-03", "GP-04"]);
        expect(result.size).toBe(2);
        expect(result.has("GP-03")).toBe(true);
        expect(result.has("GP-04")).toBe(true);
      });

      it("getNodes omits IDs that are not found (no error)", async () => {
        await adapter.putNode({
          id: "GP-05",
          type: "guiding_principle",
          properties: { name: "Present" },
        });
        const result = await adapter.getNodes(["GP-05", "GP-MISSING"]);
        expect(result.size).toBe(1);
        expect(result.has("GP-05")).toBe(true);
        expect(result.has("GP-MISSING")).toBe(false);
      });

      it("getNodes returns empty map for empty input", async () => {
        const result = await adapter.getNodes([]);
        expect(result.size).toBe(0);
      });

      it("readNodeContent returns non-empty string for an existing node", async () => {
        await adapter.putNode({
          id: "GP-06",
          type: "guiding_principle",
          properties: { name: "Readable" },
        });
        const content = await adapter.readNodeContent("GP-06");
        expect(typeof content).toBe("string");
        expect(content.length).toBeGreaterThan(0);
      });

      it("readNodeContent returns empty string for a missing node", async () => {
        const content = await adapter.readNodeContent("MISSING-000");
        expect(content).toBe("");
      });

      it("patchNode updates a property on an existing node", async () => {
        await adapter.putNode({
          id: "WI-001",
          type: "work_item",
          properties: {
            title: "Original Title",
            status: "pending",
          },
        });
        const result = await adapter.patchNode({
          id: "WI-001",
          properties: { status: "in_progress" },
        });
        expect(result.id).toBe("WI-001");
        expect(result.status).toBe("updated");

        const updated = await adapter.getNode("WI-001");
        expect(updated!.status).toBe("in_progress");
      });

      it("patchNode returns not_found for a missing node", async () => {
        const result = await adapter.patchNode({
          id: "WI-MISSING",
          properties: { status: "done" },
        });
        expect(result.status).toBe("not_found");
      });

      it("patchNode rejects immutable field 'id'", async () => {
        await adapter.putNode({
          id: "WI-002",
          type: "work_item",
          properties: { title: "Immutable Test", status: "pending" },
        });
        await expect(
          adapter.patchNode({ id: "WI-002", properties: { id: "WI-999" } })
        ).rejects.toThrow(ImmutableFieldError);
      });

      it("patchNode rejects immutable field 'type'", async () => {
        await adapter.putNode({
          id: "WI-003",
          type: "work_item",
          properties: { title: "Type Test", status: "pending" },
        });
        await expect(
          adapter.patchNode({ id: "WI-003", properties: { type: "finding" } })
        ).rejects.toThrow(ImmutableFieldError);
      });

      it("patchNode rejects immutable field 'cycle_created'", async () => {
        await adapter.putNode({
          id: "WI-004",
          type: "work_item",
          properties: { title: "Cycle Test", status: "pending" },
        });
        await expect(
          adapter.patchNode({ id: "WI-004", properties: { cycle_created: 99 } })
        ).rejects.toThrow(ImmutableFieldError);
      });

      // Input validation — putNode
      it("putNode throws INVALID_NODE_ID for empty string id", async () => {
        await expect(
          adapter.putNode({ id: "", type: "work_item", properties: { title: "x" } })
        ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
      });

      it("putNode throws INVALID_NODE_ID for non-string id", async () => {
        await expect(
          adapter.putNode({ id: null as any, type: "work_item", properties: { title: "x" } })
        ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
      });

      it("putNode throws INVALID_NODE_TYPE for unknown type", async () => {
        await expect(
          adapter.putNode({ id: "WI-V01", type: "bogus" as any, properties: { title: "x" } })
        ).rejects.toMatchObject({ code: "INVALID_NODE_TYPE" });
      });

      it("putNode throws MISSING_NODE_PROPERTIES when properties is null", async () => {
        await expect(
          adapter.putNode({ id: "WI-V02", type: "work_item", properties: null as any })
        ).rejects.toMatchObject({ code: "MISSING_NODE_PROPERTIES" });
      });

      // Input validation — patchNode
      it("patchNode throws INVALID_NODE_ID for empty string id", async () => {
        await expect(
          adapter.patchNode({ id: "", properties: { title: "x" } })
        ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
      });

      it("patchNode throws INVALID_NODE_ID for non-string id", async () => {
        await expect(
          adapter.patchNode({ id: null as any, properties: { title: "x" } })
        ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
      });

      it("deleteNode removes an existing node (status: deleted)", async () => {
        await adapter.putNode({
          id: "WI-010",
          type: "work_item",
          properties: { title: "To Delete", status: "pending" },
        });
        const result = await adapter.deleteNode("WI-010");
        expect(result.id).toBe("WI-010");
        expect(result.status).toBe("deleted");

        const node = await adapter.getNode("WI-010");
        expect(node).toBeNull();
      });

      it("deleteNode returns not_found for a missing node", async () => {
        const result = await adapter.deleteNode("WI-GONE");
        expect(result.status).toBe("not_found");
      });

      it("deleteNode removes associated edges", async () => {
        await adapter.putNode({
          id: "WI-011",
          type: "work_item",
          properties: { title: "Edge Owner", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-012",
          type: "work_item",
          properties: { title: "Edge Target", status: "pending" },
        });
        await adapter.putEdge({
          source_id: "WI-011",
          target_id: "WI-012",
          edge_type: "depends_on",
          properties: {},
        });

        await adapter.deleteNode("WI-011");

        // Edges sourced from WI-011 should be gone
        const edges = await adapter.getEdges("WI-011", "outgoing");
        expect(edges).toHaveLength(0);
      });
    });

    // -----------------------------------------------------------------------
    // Idempotency
    // -----------------------------------------------------------------------

    describe("Idempotency", () => {
      it("putNode twice with same ID updates the node (status: updated on second call)", async () => {
        const input: MutateNodeInput = {
          id: "GP-IDEM",
          type: "guiding_principle",
          properties: { name: "First" },
        };
        const first = await adapter.putNode(input);
        expect(first.status).toBe("created");

        const second = await adapter.putNode({
          ...input,
          properties: { name: "Second" },
        });
        expect(second.status).toBe("updated");

        const node = await adapter.getNode("GP-IDEM");
        expect(node!.properties.name).toBe("Second");
      });

      it("putEdge is idempotent — calling twice does not create duplicate edges", async () => {
        await adapter.putNode({
          id: "WI-IDEM-A",
          type: "work_item",
          properties: { title: "Source", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-IDEM-B",
          type: "work_item",
          properties: { title: "Target", status: "pending" },
        });

        const edge: Edge = {
          source_id: "WI-IDEM-A",
          target_id: "WI-IDEM-B",
          edge_type: "depends_on",
          properties: {},
        };
        await adapter.putEdge(edge);
        await adapter.putEdge(edge); // second call — must not throw or duplicate

        const edges = await adapter.getEdges("WI-IDEM-A", "outgoing");
        const dependsOnEdges = edges.filter(
          (e) => e.edge_type === "depends_on" && e.target_id === "WI-IDEM-B"
        );
        expect(dependsOnEdges).toHaveLength(1);
      });
    });

    // -----------------------------------------------------------------------
    // Edges
    // -----------------------------------------------------------------------

    describe("Edges", () => {
      it("putEdge creates an edge; getEdges retrieves it (outgoing)", async () => {
        await adapter.putNode({
          id: "WI-E01",
          type: "work_item",
          properties: { title: "Source", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-E02",
          type: "work_item",
          properties: { title: "Target", status: "pending" },
        });

        await adapter.putEdge({
          source_id: "WI-E01",
          target_id: "WI-E02",
          edge_type: "depends_on",
          properties: {},
        });

        const edges = await adapter.getEdges("WI-E01", "outgoing");
        expect(edges.some((e) => e.target_id === "WI-E02" && e.edge_type === "depends_on")).toBe(true);
      });

      it("getEdges incoming returns edges where node is the target", async () => {
        await adapter.putNode({
          id: "WI-E03",
          type: "work_item",
          properties: { title: "Source 2", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-E04",
          type: "work_item",
          properties: { title: "Target 2", status: "pending" },
        });

        await adapter.putEdge({
          source_id: "WI-E03",
          target_id: "WI-E04",
          edge_type: "depends_on",
          properties: {},
        });

        const edges = await adapter.getEdges("WI-E04", "incoming");
        expect(edges.some((e) => e.source_id === "WI-E03" && e.edge_type === "depends_on")).toBe(true);
      });

      it("getEdges both returns outgoing and incoming edges", async () => {
        await adapter.putNode({
          id: "WI-E05",
          type: "work_item",
          properties: { title: "Hub", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-E06",
          type: "work_item",
          properties: { title: "Dep A", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-E07",
          type: "work_item",
          properties: { title: "Dep B", status: "pending" },
        });

        // WI-E05 depends on WI-E06
        await adapter.putEdge({
          source_id: "WI-E05",
          target_id: "WI-E06",
          edge_type: "depends_on",
          properties: {},
        });
        // WI-E07 depends on WI-E05
        await adapter.putEdge({
          source_id: "WI-E07",
          target_id: "WI-E05",
          edge_type: "depends_on",
          properties: {},
        });

        const edges = await adapter.getEdges("WI-E05", "both");
        const outgoing = edges.filter((e) => e.source_id === "WI-E05");
        const incoming = edges.filter((e) => e.target_id === "WI-E05");
        expect(outgoing.length).toBeGreaterThanOrEqual(1);
        expect(incoming.length).toBeGreaterThanOrEqual(1);
      });

      it("getEdges returns empty array for a node with no edges", async () => {
        await adapter.putNode({
          id: "WI-E08",
          type: "work_item",
          properties: { title: "Isolated", status: "pending" },
        });
        const edges = await adapter.getEdges("WI-E08", "both");
        expect(edges).toHaveLength(0);
      });

      it("removeEdges deletes edges of the specified types from a source node", async () => {
        await adapter.putNode({
          id: "WI-RE01",
          type: "work_item",
          properties: { title: "Remove Source", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-RE02",
          type: "work_item",
          properties: { title: "Remove Target", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-RE03",
          type: "work_item",
          properties: { title: "Keep Target", status: "pending" },
        });

        await adapter.putEdge({
          source_id: "WI-RE01",
          target_id: "WI-RE02",
          edge_type: "depends_on",
          properties: {},
        });
        await adapter.putEdge({
          source_id: "WI-RE01",
          target_id: "WI-RE03",
          edge_type: "blocks",
          properties: {},
        });

        // Remove only 'depends_on' edges
        await adapter.removeEdges("WI-RE01", ["depends_on"]);

        const remaining = await adapter.getEdges("WI-RE01", "outgoing");
        const depEdges = remaining.filter((e) => e.edge_type === "depends_on");
        const blocksEdges = remaining.filter((e) => e.edge_type === "blocks");
        expect(depEdges).toHaveLength(0);
        expect(blocksEdges).toHaveLength(1);
      });

      it("removeEdges is a no-op when edge_types is empty", async () => {
        await adapter.putNode({
          id: "WI-RE04",
          type: "work_item",
          properties: { title: "No-op Source", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-RE05",
          type: "work_item",
          properties: { title: "No-op Target", status: "pending" },
        });
        await adapter.putEdge({
          source_id: "WI-RE04",
          target_id: "WI-RE05",
          edge_type: "relates_to",
          properties: {},
        });

        await adapter.removeEdges("WI-RE04", []);

        const edges = await adapter.getEdges("WI-RE04", "outgoing");
        expect(edges.some((e) => e.edge_type === "relates_to")).toBe(true);
      });
    });

    // -----------------------------------------------------------------------
    // Query — queryNodes / countNodes
    // -----------------------------------------------------------------------

    describe("Query", () => {
      it("queryNodes returns nodes matching the type filter", async () => {
        await adapter.putNode({
          id: "GP-Q01",
          type: "guiding_principle",
          properties: { name: "Query GP 1" },
        });
        await adapter.putNode({
          id: "WI-Q01",
          type: "work_item",
          properties: { title: "Query WI 1", status: "pending" },
        });

        const result = await adapter.queryNodes({ type: "guiding_principle" }, 10, 0);
        const ids = result.nodes.map((n) => n.node.id);
        expect(ids).toContain("GP-Q01");
        expect(ids).not.toContain("WI-Q01");
      });

      it("queryNodes respects pagination (limit + offset)", async () => {
        for (let i = 1; i <= 5; i++) {
          await adapter.putNode({
            id: `GP-PAG-${String(i).padStart(2, "0")}`,
            type: "guiding_principle",
            properties: { name: `Page GP ${i}` },
          });
        }

        const page1 = await adapter.queryNodes({ type: "guiding_principle" }, 2, 0);
        const page2 = await adapter.queryNodes({ type: "guiding_principle" }, 2, 2);

        expect(page1.nodes.length).toBeLessThanOrEqual(2);
        expect(page2.nodes.length).toBeLessThanOrEqual(2);
        // No overlap between pages
        const page1Ids = page1.nodes.map((n) => n.node.id);
        const page2Ids = page2.nodes.map((n) => n.node.id);
        for (const id of page1Ids) {
          expect(page2Ids).not.toContain(id);
        }
      });

      it("queryNodes returns empty results when no matches exist", async () => {
        const result = await adapter.queryNodes({ type: "module_spec" }, 10, 0);
        expect(result.nodes).toHaveLength(0);
        expect(result.total_count).toBe(0);
      });

      it("queryNodes rejects negative limit with ValidationError (INVALID_LIMIT)", async () => {
        await expect(
          adapter.queryNodes({ type: "work_item" }, -1, 0)
        ).rejects.toThrow(ValidationError);

        try {
          await adapter.queryNodes({ type: "work_item" }, -1, 0);
          expect.fail("Should have thrown ValidationError");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("INVALID_LIMIT");
          expect((err as Error).message).toContain("Limit must be a non-negative integer");
        }
      });

      it("queryNodes rejects negative offset with ValidationError (INVALID_OFFSET)", async () => {
        await expect(
          adapter.queryNodes({ type: "work_item" }, 10, -1)
        ).rejects.toThrow(ValidationError);

        try {
          await adapter.queryNodes({ type: "work_item" }, 10, -1);
          expect.fail("Should have thrown ValidationError");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("INVALID_OFFSET");
          expect((err as Error).message).toContain("Offset must be a non-negative integer");
        }
      });

      it("queryNodes rejects non-integer limit with ValidationError", async () => {
        await expect(
          adapter.queryNodes({ type: "work_item" }, 1.5, 0)
        ).rejects.toThrow(ValidationError);
      });

      it("queryNodes rejects non-integer offset with ValidationError", async () => {
        await expect(
          adapter.queryNodes({ type: "work_item" }, 10, 1.5)
        ).rejects.toThrow(ValidationError);
      });

      it("queryNodes filters by status", async () => {
        await adapter.putNode({
          id: "WI-QS01",
          type: "work_item",
          properties: { title: "Pending Item", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-QS02",
          type: "work_item",
          properties: { title: "Done Item", status: "done" },
        });

        const result = await adapter.queryNodes({ type: "work_item", status: "done" }, 10, 0);
        const ids = result.nodes.map((n) => n.node.id);
        expect(ids).toContain("WI-QS02");
        expect(ids).not.toContain("WI-QS01");
      });

      it("countNodes groups nodes by type", async () => {
        await adapter.putNode({
          id: "GP-CNT01",
          type: "guiding_principle",
          properties: { name: "Count GP 1" },
        });
        await adapter.putNode({
          id: "GP-CNT02",
          type: "guiding_principle",
          properties: { name: "Count GP 2" },
        });

        const counts = await adapter.countNodes({}, "type");
        const gpEntry = counts.find((c) => c.key === "guiding_principle");
        expect(gpEntry).toBeDefined();
        expect(gpEntry!.count).toBeGreaterThanOrEqual(2);
      });

      it("countNodes groups by status", async () => {
        await adapter.putNode({
          id: "WI-CNT01",
          type: "work_item",
          properties: { title: "Pending WI 1", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-CNT02",
          type: "work_item",
          properties: { title: "Done WI 1", status: "done" },
        });

        const counts = await adapter.countNodes({ type: "work_item" }, "status");
        const pendingEntry = counts.find((c) => c.key === "pending");
        const doneEntry = counts.find((c) => c.key === "done");
        expect(pendingEntry?.count).toBeGreaterThanOrEqual(1);
        expect(doneEntry?.count).toBeGreaterThanOrEqual(1);
      });
    });

    // -----------------------------------------------------------------------
    // Traversal — traverse / queryGraph
    // -----------------------------------------------------------------------

    describe("Traversal", () => {
      // traverse() tests are skipped when the adapter marks it as not yet
      // implemented (e.g. LocalAdapter before WI-554 is complete).
      const itTraverse = options.skipTraverse ? it.skip : it;

      itTraverse("traverse with a valid seed ID returns a TraversalResult", async () => {
        await adapter.putNode({
          id: "WI-TR01",
          type: "work_item",
          properties: { title: "Seed Node", status: "pending" },
        });

        const result = await adapter.traverse({
          seed_ids: ["WI-TR01"],
          token_budget: 1000,
        });

        expect(result).toHaveProperty("ranked_nodes");
        expect(result).toHaveProperty("total_tokens");
        expect(result).toHaveProperty("ppr_scores");
        expect(Array.isArray(result.ranked_nodes)).toBe(true);
      });

      itTraverse("traverse with empty seed_ids throws ValidationError", async () => {
        try {
          await adapter.traverse({ seed_ids: [], token_budget: 1000 });
          expect.fail("Should have thrown ValidationError");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("EMPTY_SEED_IDS");
        }
      });

      itTraverse("traverse rejects negative token_budget with ValidationError", async () => {
        await adapter.putNode({
          id: "WI-TR02",
          type: "work_item",
          properties: { title: "Seed Node", status: "pending" },
        });

        await expect(
          adapter.traverse({
            seed_ids: ["WI-TR02"],
            token_budget: -1,
          })
        ).rejects.toThrow(ValidationError);

        try {
          await adapter.traverse({
            seed_ids: ["WI-TR02"],
            token_budget: -100,
          });
          expect.fail("Should have thrown ValidationError");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("INVALID_TOKEN_BUDGET");
          expect((err as ValidationError).details?.value).toBe(-100);
          expect((err as Error).message).toContain("token_budget must be non-negative");
        }
      });

      it("queryGraph returns nodes connected to the origin", async () => {
        await adapter.putNode({
          id: "WI-QG01",
          type: "work_item",
          properties: { title: "Graph Origin", status: "pending" },
        });
        await adapter.putNode({
          id: "WI-QG02",
          type: "work_item",
          properties: { title: "Graph Neighbor", status: "pending" },
        });
        await adapter.putEdge({
          source_id: "WI-QG01",
          target_id: "WI-QG02",
          edge_type: "depends_on",
          properties: {},
        });

        const result = await adapter.queryGraph(
          { origin_id: "WI-QG01", depth: 1, direction: "outgoing" },
          10,
          0
        );
        const ids = result.nodes.map((n) => n.node.id);
        expect(ids).toContain("WI-QG02");
      });

      it("queryGraph returns empty results for an isolated node", async () => {
        await adapter.putNode({
          id: "WI-QG03",
          type: "work_item",
          properties: { title: "Isolated Graph Node", status: "pending" },
        });

        const result = await adapter.queryGraph(
          { origin_id: "WI-QG03", depth: 1, direction: "outgoing" },
          10,
          0
        );
        // An isolated node has no neighbors (though it may include itself depending on impl)
        const neighborIds = result.nodes.filter((n) => n.node.id !== "WI-QG03").map((n) => n.node.id);
        expect(neighborIds).toHaveLength(0);
      });

      it("queryGraph rejects negative limit with ValidationError (INVALID_LIMIT)", async () => {
        await adapter.putNode({
          id: "WI-QG04",
          type: "work_item",
          properties: { title: "Graph Origin", status: "pending" },
        });

        await expect(
          adapter.queryGraph({ origin_id: "WI-QG04", depth: 1 }, -1, 0)
        ).rejects.toThrow(ValidationError);

        try {
          await adapter.queryGraph({ origin_id: "WI-QG04", depth: 1 }, -5, 0);
          expect.fail("Should have thrown ValidationError");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("INVALID_LIMIT");
          expect((err as Error).message).toContain("Limit must be a non-negative integer");
        }
      });

      it("queryGraph rejects negative offset with ValidationError (INVALID_OFFSET)", async () => {
        await adapter.putNode({
          id: "WI-QG05",
          type: "work_item",
          properties: { title: "Graph Origin", status: "pending" },
        });

        await expect(
          adapter.queryGraph({ origin_id: "WI-QG05", depth: 1 }, 10, -1)
        ).rejects.toThrow(ValidationError);

        try {
          await adapter.queryGraph({ origin_id: "WI-QG05", depth: 1 }, 10, -5);
          expect.fail("Should have thrown ValidationError");
        } catch (err) {
          expect(err).toBeInstanceOf(ValidationError);
          expect((err as ValidationError).code).toBe("INVALID_OFFSET");
          expect((err as Error).message).toContain("Offset must be a non-negative integer");
        }
      });

      it("queryGraph rejects non-integer limit with ValidationError", async () => {
        await adapter.putNode({
          id: "WI-QG06",
          type: "work_item",
          properties: { title: "Graph Origin", status: "pending" },
        });

        await expect(
          adapter.queryGraph({ origin_id: "WI-QG06", depth: 1 }, 1.5, 0)
        ).rejects.toThrow(ValidationError);
      });

      it("queryGraph rejects non-integer offset with ValidationError", async () => {
        await adapter.putNode({
          id: "WI-QG07",
          type: "work_item",
          properties: { title: "Graph Origin", status: "pending" },
        });

        await expect(
          adapter.queryGraph({ origin_id: "WI-QG07", depth: 1 }, 10, 1.5)
        ).rejects.toThrow(ValidationError);
      });
    });

    // -----------------------------------------------------------------------
    // Batch operations
    // -----------------------------------------------------------------------

    describe("Batch", () => {
      it("batchMutate creates multiple nodes atomically", async () => {
        const result = await adapter.batchMutate({
          nodes: [
            {
              id: "WI-B01",
              type: "work_item",
              properties: { title: "Batch Item 1", status: "pending" },
            },
            {
              id: "WI-B02",
              type: "work_item",
              properties: { title: "Batch Item 2", status: "pending" },
            },
          ],
        });

        expect(result.errors).toHaveLength(0);
        expect(result.results).toHaveLength(2);
        expect(result.results.map((r) => r.id)).toContain("WI-B01");
        expect(result.results.map((r) => r.id)).toContain("WI-B02");

        // Nodes should be retrievable
        const n1 = await adapter.getNode("WI-B01");
        const n2 = await adapter.getNode("WI-B02");
        expect(n1).not.toBeNull();
        expect(n2).not.toBeNull();
      });

      it("batchMutate creates edges provided alongside nodes", async () => {
        await adapter.batchMutate({
          nodes: [
            {
              id: "WI-BE01",
              type: "work_item",
              properties: { title: "Batch Edge Source", status: "pending" },
            },
            {
              id: "WI-BE02",
              type: "work_item",
              properties: { title: "Batch Edge Target", status: "pending" },
            },
          ],
          edges: [
            {
              source_id: "WI-BE01",
              target_id: "WI-BE02",
              edge_type: "relates_to",
              properties: {},
            },
          ],
        });

        const edges = await adapter.getEdges("WI-BE01", "outgoing");
        expect(edges.some((e) => e.edge_type === "relates_to" && e.target_id === "WI-BE02")).toBe(true);
      });

      it("batchMutate returns errors and persists nothing when a DAG cycle is detected", async () => {
        // Create WI-CYC01 -> WI-CYC02 -> WI-CYC01 (cycle)
        const result = await adapter.batchMutate({
          nodes: [
            {
              id: "WI-CYC01",
              type: "work_item",
              properties: {
                title: "Cycle A",
                status: "pending",
                depends: ["WI-CYC02"],
              },
            },
            {
              id: "WI-CYC02",
              type: "work_item",
              properties: {
                title: "Cycle B",
                status: "pending",
                depends: ["WI-CYC01"],
              },
            },
          ],
        });

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.results).toHaveLength(0);

        // Neither node should have been persisted
        const n1 = await adapter.getNode("WI-CYC01");
        const n2 = await adapter.getNode("WI-CYC02");
        expect(n1).toBeNull();
        expect(n2).toBeNull();
      });

      it("batchMutate throws ValidationError with EMPTY_BATCH for empty node list", async () => {
        try {
          await adapter.batchMutate({ nodes: [] });
          expect.fail("Should have thrown ValidationError");
        } catch (error: any) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error.code).toBe("EMPTY_BATCH");
        }
      });

      // Batch validation tests
      it("batchMutate throws MISSING_NODE_ID error when node has no id field", async () => {
        const nodes = [
          { type: "work_item", properties: { title: "Test" } },
        ] as any[];
        // Remove id field completely
        delete (nodes[0] as any).id;
        try {
          await adapter.batchMutate({ nodes });
          expect.fail("Should have thrown ValidationError");
        } catch (error: any) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error.code).toBe("MISSING_NODE_ID");
        }
      });

      it("batchMutate throws MISSING_NODE_TYPE error when node has no type", async () => {
        const nodes = [{ id: "WI-TEST-001", properties: { title: "Test" } } as any];
        try {
          await adapter.batchMutate({ nodes });
          expect.fail("Should have thrown ValidationError");
        } catch (error: any) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error.code).toBe("MISSING_NODE_TYPE");
        }
      });

      it("batchMutate throws MISSING_NODE_PROPERTIES error when node has no properties", async () => {
        const nodes = [{ id: "WI-TEST-002", type: "work_item" } as any];
        try {
          await adapter.batchMutate({ nodes });
          expect.fail("Should have thrown ValidationError");
        } catch (error: any) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error.code).toBe("MISSING_NODE_PROPERTIES");
        }
      });

      it("batchMutate throws INVALID_NODE_TYPE error for unknown type", async () => {
        const nodes = [{
          id: "WI-TEST-003",
          type: "unknown_type",
          properties: { title: "Test" },
        } as any];
        try {
          await adapter.batchMutate({ nodes });
          expect.fail("Should have thrown ValidationError");
        } catch (error: any) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error.code).toBe("INVALID_NODE_TYPE");
        }
      });

      it("batchMutate throws MISSING_EDGE_SOURCE error when edge has no source_id", async () => {
        const nodes = [{
          id: "WI-TEST-004",
          type: "work_item" as NodeType,
          properties: { title: "Test" },
        }];
        const edges = [{
          target_id: "WI-TEST-004",
          edge_type: "depends_on",
          properties: {},
        } as any];
        try {
          await adapter.batchMutate({ nodes, edges });
          expect.fail("Should have thrown ValidationError");
        } catch (error: any) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error.code).toBe("MISSING_EDGE_SOURCE");
        }
      });

      it("batchMutate throws MISSING_EDGE_TARGET error when edge has no target_id", async () => {
        const nodes = [{
          id: "WI-TEST-005",
          type: "work_item" as NodeType,
          properties: { title: "Test" },
        }];
        const edges = [{
          source_id: "WI-TEST-005",
          edge_type: "depends_on",
          properties: {},
        } as any];
        try {
          await adapter.batchMutate({ nodes, edges });
          expect.fail("Should have thrown ValidationError");
        } catch (error: any) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error.code).toBe("MISSING_EDGE_TARGET");
        }
      });

      it("batchMutate throws MISSING_EDGE_TYPE error when edge has no edge_type", async () => {
        const nodes = [
          { id: "WI-TEST-006", type: "work_item" as NodeType, properties: { title: "Test 1" } },
          { id: "WI-TEST-007", type: "work_item" as NodeType, properties: { title: "Test 2" } },
        ];
        const edges = [{
          source_id: "WI-TEST-006",
          target_id: "WI-TEST-007",
          properties: {},
        } as any];
        try {
          await adapter.batchMutate({ nodes, edges });
          expect.fail("Should have thrown ValidationError");
        } catch (error: any) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error.code).toBe("MISSING_EDGE_TYPE");
        }
      });

      it("batchMutate throws INVALID_EDGE_TYPE error for unknown edge type", async () => {
        const nodes = [
          { id: "WI-TEST-008", type: "work_item" as NodeType, properties: { title: "Test 1" } },
          { id: "WI-TEST-009", type: "work_item" as NodeType, properties: { title: "Test 2" } },
        ];
        const edges = [{
          source_id: "WI-TEST-008",
          target_id: "WI-TEST-009",
          edge_type: "invalid_edge_type",
          properties: {},
        } as any];
        try {
          await adapter.batchMutate({ nodes, edges });
          expect.fail("Should have thrown ValidationError");
        } catch (error: any) {
          expect(error).toBeInstanceOf(ValidationError);
          expect(error.code).toBe("INVALID_EDGE_TYPE");
        }
      });
    });

    // -----------------------------------------------------------------------
    // ID generation
    // -----------------------------------------------------------------------

    describe("ID generation", () => {
      it("nextId for work_item returns a WI-NNN formatted ID", async () => {
        const id = await adapter.nextId("work_item");
        expect(id).toMatch(/^WI-\d{3}$/);
      });

      it("nextId for work_item increments after a node is created", async () => {
        const first = await adapter.nextId("work_item");
        await adapter.putNode({
          id: first,
          type: "work_item",
          properties: { title: "ID Gen Test", status: "pending" },
        });
        const second = await adapter.nextId("work_item");
        expect(second).not.toBe(first);
      });

      it("nextId for journal_entry requires a cycle parameter", async () => {
        const id = await adapter.nextId("journal_entry", 1);
        expect(id).toMatch(/^J-\d{3}-\d{3}$/);
      });

      it("nextId for finding requires a cycle parameter", async () => {
        const id = await adapter.nextId("finding", 1);
        expect(id).toMatch(/^F-\d{3}-\d{3}$/);
      });
    });

    // -----------------------------------------------------------------------
    // Aggregation — getDomainState / getConvergenceData
    // -----------------------------------------------------------------------

    describe("Aggregation", () => {
      it("getDomainState returns a map (possibly empty) without error", async () => {
        const state = await adapter.getDomainState();
        expect(state instanceof Map).toBe(true);
      });

      it("getDomainState returns entries for domains that have policies", async () => {
        await adapter.putNode({
          id: "P-DS01",
          type: "domain_policy",
          properties: {
            domain: "workflow",
            description: "A test policy",
            status: "active",
          },
        });

        const state = await adapter.getDomainState(["workflow"]);
        expect(state.has("workflow")).toBe(true);
        const workflowState = state.get("workflow")!;
        expect(Array.isArray(workflowState.policies)).toBe(true);
        const policyIds = workflowState.policies.map((p) => p.id);
        expect(policyIds).toContain("P-DS01");
      });

      it("excludes deprecated and superseded policies from getDomainState results", async () => {
        await adapter.putNode({
          id: "P-filter-active",
          type: "domain_policy",
          properties: {
            domain: "filter-test",
            description: "Active policy",
            status: "active",
          },
        });
        await adapter.putNode({
          id: "P-filter-deprecated",
          type: "domain_policy",
          properties: {
            domain: "filter-test",
            description: "Deprecated policy",
            status: "deprecated",
          },
        });
        await adapter.putNode({
          id: "P-filter-superseded",
          type: "domain_policy",
          properties: {
            domain: "filter-test",
            description: "Superseded policy",
            status: "superseded",
          },
        });

        const result = await adapter.getDomainState(["filter-test"]);
        const entry = result.get("filter-test");
        expect(entry).toBeDefined();
        const policyIds = entry!.policies.map((p: any) => p.id);
        expect(policyIds).toContain("P-filter-active");
        expect(policyIds).not.toContain("P-filter-deprecated");
        expect(policyIds).not.toContain("P-filter-superseded");
      });

      it("includes policies with null/absent status in getDomainState results", async () => {
        await adapter.putNode({
          id: "P-null-status",
          type: "domain_policy",
          properties: {
            domain: "null-status-test",
            description: "Null status policy",
            // No status field — defaults to null
          },
        });
        const result = await adapter.getDomainState(["null-status-test"]);
        const entry = result.get("null-status-test");
        expect(entry).toBeDefined();
        const policyIds = entry!.policies.map((p: any) => p.id);
        expect(policyIds).toContain("P-null-status");
      });

      it("getConvergenceData returns findings_by_severity and cycle_summary_content", async () => {
        const data = await adapter.getConvergenceData(1);
        expect(data).toHaveProperty("findings_by_severity");
        expect(data).toHaveProperty("cycle_summary_content");
        expect(typeof data.findings_by_severity).toBe("object");
      });
    });

    // -----------------------------------------------------------------------
    // archiveCycle lifecycle
    // -----------------------------------------------------------------------

    describe("archiveCycle", () => {
      it("archiveCycle is a no-op (returns a summary string) when cycle has no artifacts", async () => {
        // A cycle with no findings should not throw and returns a summary string
        const result = await adapter.archiveCycle(99);
        expect(typeof result).toBe("string");
        expect(result).toContain("0");
      });
    });

    // -----------------------------------------------------------------------
    // appendJournalEntry
    // -----------------------------------------------------------------------

    describe("appendJournalEntry", () => {
      it("returns a J-NNN-NNN format ID", async () => {
        const id = await adapter.appendJournalEntry({
          skill: "execute",
          date: "2026-04-02",
          entryType: "test",
          body: "Test entry",
          cycle: 1,
        });
        expect(id).toMatch(/^J-\d{3}-\d{3}$/);
      });

      it("sequential entries within a cycle get incrementing sequence numbers", async () => {
        const first = await adapter.appendJournalEntry({
          skill: "execute",
          date: "2026-04-02",
          entryType: "test",
          body: "First entry",
          cycle: 1,
        });
        const second = await adapter.appendJournalEntry({
          skill: "execute",
          date: "2026-04-02",
          entryType: "test",
          body: "Second entry",
          cycle: 1,
        });

        // Both match the format
        expect(first).toMatch(/^J-\d{3}-\d{3}$/);
        expect(second).toMatch(/^J-\d{3}-\d{3}$/);

        // Parse out the sequence numbers (last three digits)
        const firstSeq = parseInt(first.split("-")[2], 10);
        const secondSeq = parseInt(second.split("-")[2], 10);
        expect(secondSeq).toBeGreaterThan(firstSeq);
      });

      it("created journal entry can be retrieved via getNode", async () => {
        const id = await adapter.appendJournalEntry({
          skill: "execute",
          date: "2026-04-02",
          entryType: "test",
          body: "Retrievable entry",
          cycle: 1,
        });

        const node = await adapter.getNode(id);
        expect(node).not.toBeNull();
        expect(node!.id).toBe(id);
        expect(node!.type).toBe("journal_entry");
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Run contract tests against LocalAdapter
// ---------------------------------------------------------------------------

describe("LocalAdapter", () => {
  // Shared state for setup/teardown visible in factory closures
  const state: {
    tmpDir: string;
    db: Database.Database | null;
  } = {
    tmpDir: "",
    db: null,
  };

  runAdapterContractTests(
    async (): Promise<StorageAdapter> => {
      const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "ideate-adapter-contract-")
      );
      state.tmpDir = tmpDir;

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

      // Create domains index (needed for patchNode cycle_modified resolution)
      fs.writeFileSync(
        path.join(ideateDir, "domains", "index.yaml"),
        "current_cycle: 1\n",
        "utf8"
      );

      const dbPath = path.join(tmpDir, "test.db");
      const db = new Database(dbPath);
      state.db = db;
      createSchema(db);

      const drizzleDb = drizzle(db, { schema: dbSchema });

      const adapter = new LocalAdapter({ db, drizzleDb, ideateDir });
      return adapter;
    },
    async (_adapter: StorageAdapter): Promise<void> => {
      // Close DB before removing tmpDir
      try {
        state.db?.close();
      } catch {
        // ignore
      }
      state.db = null;
      if (state.tmpDir) {
        fs.rmSync(state.tmpDir, { recursive: true, force: true });
        state.tmpDir = "";
      }
    },
  );
});
