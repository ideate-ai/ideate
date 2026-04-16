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
import { insertToolUsage } from "../db-helpers.js";
import { LocalAdapter } from "../adapters/local/index.js";
import { ValidatingAdapter } from "../validating.js";
import type {
  StorageAdapter,
  MutateNodeInput,
  NodeType,
  Edge,
  ToolUsageRow,
  ToolUsageInsert,
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

  /**
   * Optional callback to insert tool_usage rows into the backing store before
   * each getToolUsage contract test. Called with a set of seed rows that the
   * contract test will then query.
   *
   * When omitted (e.g. RemoteAdapter stub), the getToolUsage tests run against
   * an empty store and assert on shape/empty-result semantics only.
   *
   * @param rows - Rows to insert. The callback is responsible for committing
   *               them to whichever backing store the adapter uses.
   */
  seedToolUsage?: (rows: ToolUsageInsert[]) => void | Promise<void>;
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

      itTraverse(
        "traverse enforces token_budget on always_include_types (WI-787 AC-5)",
        async () => {
          // Seed node — also serves as the traverse seed_id.
          await adapter.putNode({
            id: "GP-SEED-TR",
            type: "guiding_principle",
            properties: {
              name: "Seed",
              description: "seed",
            },
          });

          // Seed many oversized guiding_principles and constraints so that
          // unconditionally including all of them would exceed a 1000-token
          // budget by a wide margin.
          for (let i = 1; i <= 30; i++) {
            const pad = String(i).padStart(3, "0");
            const description = "x".repeat(2 * 1024); // ~512 tokens each
            await adapter.putNode({
              id: `GP-BG-${pad}`,
              type: "guiding_principle",
              properties: { name: `GP ${pad}`, description },
            });
            await adapter.putNode({
              id: `C-BG-${pad}`,
              type: "constraint",
              properties: { category: "data", description },
            });
          }

          const result = await adapter.traverse({
            seed_ids: ["GP-SEED-TR"],
            token_budget: 1000,
            always_include_types: ["guiding_principle", "constraint"],
          });

          // Without budget enforcement, total_tokens would easily exceed
          // 1000 (30 GPs * ~512 tokens + 30 constraints * ~512 tokens = ~30k).
          // Seeds are force-included, so the seed's tokens may push the
          // total above budget slightly; non-seed tokens must stay within.
          const seedTokens = result.ranked_nodes
            .filter((rn) => rn.node.id === "GP-SEED-TR")
            .reduce((sum, rn) => sum + (rn.node.token_count ?? 0), 0);
          const nonSeedTokens = result.total_tokens - seedTokens;
          expect(nonSeedTokens).toBeLessThanOrEqual(1000);

          // Overflow must be signaled so callers can detect incomplete context.
          expect(result.budget_exhausted).toBe(true);
          expect(Array.isArray(result.truncated_types)).toBe(true);
          expect((result.truncated_types ?? []).length).toBeGreaterThan(0);
        }
      );

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

      it("includes domain_decisions with null/absent status in getDomainState results", async () => {
        await adapter.putNode({
          id: "D-null-status",
          type: "domain_decision",
          properties: {
            domain: "null-status-decision-test",
            title: "Null status decision",
            body: "Should appear in results",
            // No status field — defaults to null
          },
        });
        const result = await adapter.getDomainState(["null-status-decision-test"]);
        const entry = result.get("null-status-decision-test");
        expect(entry).toBeDefined();
        const decisionIds = entry!.decisions.map((d: any) => d.id);
        expect(decisionIds).toContain("D-null-status");
      });

      it("excludes domain_questions with null/absent status from getDomainState results", async () => {
        // Anchor the domain with a decision so it always appears in the result map.
        // Without an anchor, a null-status question causes the domain to never enter
        // domainSet, making result.get(...) return undefined regardless of behavior.
        await adapter.putNode({
          id: "D-anchor-for-q-test",
          type: "domain_decision",
          properties: {
            domain: "null-status-question-test",
            title: "Anchor decision",
            body: "Ensures domain appears in getDomainState results",
          },
        });
        await adapter.putNode({
          id: "Q-null-status",
          type: "domain_question",
          properties: {
            domain: "null-status-question-test",
            title: "Null status question",
            body: "Should not appear in results",
            // No status field — defaults to null; questions require status='open'
          },
        });
        const result = await adapter.getDomainState(["null-status-question-test"]);
        const entry = result.get("null-status-question-test");
        expect(entry).toBeDefined();
        const questionIds = entry!.questions.map((q: any) => q.id);
        expect(questionIds).not.toContain("Q-null-status");
      });

      it("getConvergenceData returns findings_by_severity and cycle_summary_content", async () => {
        const data = await adapter.getConvergenceData(1);
        expect(data).toHaveProperty("findings_by_severity");
        expect(data).toHaveProperty("cycle_summary_content");
        expect(typeof data.findings_by_severity).toBe("object");
      });

      // WI-860: Regression tests — resolved findings (addressed_by set) must not
      // block convergence. Only unresolved findings (addressed_by IS NULL) count.

      it("getConvergenceData excludes findings with addressed_by set (resolves convergence false-negative)", async () => {
        // Seed: 2 significant findings for cycle 100
        // One resolved (addressed_by set), one unresolved
        await adapter.putNode({
          id: "F-100-001",
          type: "finding",
          cycle: 100,
          properties: {
            severity: "significant",
            work_item: "WI-001",
            verdict: "Fail",
            cycle: 100,
            reviewer: "test-reviewer",
            addressed_by: null,
          },
        });
        await adapter.putNode({
          id: "F-100-002",
          type: "finding",
          cycle: 100,
          properties: {
            severity: "significant",
            work_item: "WI-001",
            verdict: "Fail",
            cycle: 100,
            reviewer: "test-reviewer",
            addressed_by: "PH-001",
          },
        });

        const data = await adapter.getConvergenceData(100);
        // Only the unresolved finding (F-100-001) should be counted
        expect(data.findings_by_severity["significant"]).toBe(1);
      });

      it("getConvergenceData counts all findings when none are resolved (passing behavior preserved)", async () => {
        // Seed: 2 minor findings for cycle 101, both unresolved (addressed_by null)
        await adapter.putNode({
          id: "F-101-001",
          type: "finding",
          cycle: 101,
          properties: {
            severity: "minor",
            work_item: "WI-001",
            verdict: "Fail",
            cycle: 101,
            reviewer: "test-reviewer",
            addressed_by: null,
          },
        });
        await adapter.putNode({
          id: "F-101-002",
          type: "finding",
          cycle: 101,
          properties: {
            severity: "minor",
            work_item: "WI-001",
            verdict: "Fail",
            cycle: 101,
            reviewer: "test-reviewer",
            addressed_by: null,
          },
        });

        const data = await adapter.getConvergenceData(101);
        // Both unresolved findings should be counted
        expect(data.findings_by_severity["minor"]).toBe(2);
      });

      // WI-868: Regression tests — countNodes severity path must also exclude
      // resolved findings, and getConvergenceData must reject empty-string addressed_by.

      it("countNodes with group_by='severity' excludes findings where addressed_by is set (non-null or empty string)", async () => {
        // Seed: 3 critical findings for cycle 102
        // One unresolved (addressed_by null), one resolved with a value, one resolved with empty string
        await adapter.putNode({
          id: "F-102-001",
          type: "finding",
          cycle: 102,
          properties: {
            severity: "critical",
            work_item: "WI-001",
            verdict: "Fail",
            cycle: 102,
            reviewer: "test-reviewer",
            addressed_by: null,
          },
        });
        await adapter.putNode({
          id: "F-102-002",
          type: "finding",
          cycle: 102,
          properties: {
            severity: "critical",
            work_item: "WI-001",
            verdict: "Fail",
            cycle: 102,
            reviewer: "test-reviewer",
            addressed_by: "PH-001",
          },
        });
        await adapter.putNode({
          id: "F-102-003",
          type: "finding",
          cycle: 102,
          properties: {
            severity: "critical",
            work_item: "WI-001",
            verdict: "Fail",
            cycle: 102,
            reviewer: "test-reviewer",
            addressed_by: "",
          },
        });

        const counts = await adapter.countNodes(
          { type: "finding", cycle: 102 },
          "severity"
        );
        // Only the unresolved finding (F-102-001) should be counted
        const criticalEntry = counts.find((c) => c.key === "critical");
        expect(criticalEntry).toBeDefined();
        expect(criticalEntry!.count).toBe(1);
      });

      it("getConvergenceData excludes findings with addressed_by='' (empty string)", async () => {
        // Seed: 2 significant findings for cycle 103
        // One unresolved (addressed_by null), one with empty-string addressed_by
        await adapter.putNode({
          id: "F-103-001",
          type: "finding",
          cycle: 103,
          properties: {
            severity: "significant",
            work_item: "WI-001",
            verdict: "Fail",
            cycle: 103,
            reviewer: "test-reviewer",
            addressed_by: null,
          },
        });
        await adapter.putNode({
          id: "F-103-002",
          type: "finding",
          cycle: 103,
          properties: {
            severity: "significant",
            work_item: "WI-001",
            verdict: "Fail",
            cycle: 103,
            reviewer: "test-reviewer",
            addressed_by: "",
          },
        });

        const data = await adapter.getConvergenceData(103);
        // Only the truly unresolved finding (F-103-001) should be counted
        expect(data.findings_by_severity["significant"]).toBe(1);
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

    // -----------------------------------------------------------------------
    // Context assembly: five code paths (WI-785)
    //
    // These tests verify that the five query patterns used by handleGetContextPackage
    // work correctly through the StorageAdapter contract. Previously these went
    // through a LocalContextAdapter cast; now they compose queryNodes + getNodes
    // (+ readNodeContent for architecture). Both LocalAdapter and RemoteAdapter
    // must satisfy this contract.
    // -----------------------------------------------------------------------

    describe("Context assembly queries", () => {
      // -----------------------------------------------------------------------
      // 1. Architecture document
      // -----------------------------------------------------------------------

      describe("queryNodes({type:'architecture'}) + getNodes + readNodeContent", () => {
        it("returns empty result when no architecture node exists", async () => {
          const result = await adapter.queryNodes({ type: "architecture" }, 1, 0);
          expect(result.nodes).toHaveLength(0);
          expect(result.total_count).toBe(0);
        });

        it("returns the architecture node with content in properties", async () => {
          await adapter.putNode({
            id: "arch-001",
            type: "architecture",
            properties: {
              title: "Test Architecture",
              content: "## Overview\nSystem description here.",
            },
          });

          const queryResult = await adapter.queryNodes({ type: "architecture" }, 1, 0);
          expect(queryResult.nodes).toHaveLength(1);
          expect(queryResult.nodes[0].node.id).toBe("arch-001");

          const nodesMap = await adapter.getNodes(["arch-001"]);
          const archNode = nodesMap.get("arch-001");
          expect(archNode).toBeDefined();
          expect(typeof archNode!.properties.content).toBe("string");
          expect(archNode!.properties.content).toContain("## Overview");
          expect(archNode!.properties.title).toBe("Test Architecture");
        });

        it("readNodeContent returns non-empty string for an architecture node", async () => {
          await adapter.putNode({
            id: "arch-002",
            type: "architecture",
            properties: { title: "Arch", content: "Some arch content." },
          });

          // readNodeContent is available on the raw adapter contract
          const content = await adapter.readNodeContent("arch-002");
          // May be empty for RemoteAdapter (it stores differently), but must not throw
          expect(typeof content).toBe("string");
        });
      });

      // -----------------------------------------------------------------------
      // 2. Guiding Principles
      // -----------------------------------------------------------------------

      describe("queryNodes({type:'guiding_principle'}) + getNodes", () => {
        it("returns empty result when no guiding principles exist", async () => {
          const result = await adapter.queryNodes({ type: "guiding_principle" }, 1000, 0);
          expect(result.nodes).toHaveLength(0);
        });

        it("returns guiding principles with name and description in properties", async () => {
          await adapter.putNode({
            id: "GP-01",
            type: "guiding_principle",
            properties: { name: "Test Principle", description: "Do the right thing." },
          });
          await adapter.putNode({
            id: "GP-02",
            type: "guiding_principle",
            properties: { name: "Another Principle", description: "Be consistent." },
          });

          const queryResult = await adapter.queryNodes({ type: "guiding_principle" }, 1000, 0);
          expect(queryResult.nodes.length).toBeGreaterThanOrEqual(2);

          const ids = queryResult.nodes.map((n) => n.node.id);
          const nodesMap = await adapter.getNodes(ids);

          const gp01 = nodesMap.get("GP-01");
          expect(gp01).toBeDefined();
          expect(gp01!.properties.name).toBe("Test Principle");
          expect(gp01!.properties.description).toBe("Do the right thing.");

          const gp02 = nodesMap.get("GP-02");
          expect(gp02).toBeDefined();
          expect(gp02!.properties.name).toBe("Another Principle");
        });

        it("preserves id-order sorting (GP-01 before GP-02)", async () => {
          await adapter.putNode({
            id: "GP-01",
            type: "guiding_principle",
            properties: { name: "First", description: "First principle." },
          });
          await adapter.putNode({
            id: "GP-02",
            type: "guiding_principle",
            properties: { name: "Second", description: "Second principle." },
          });

          const result = await adapter.queryNodes({ type: "guiding_principle" }, 1000, 0);
          const ids = result.nodes.map((n) => n.node.id);
          const idx01 = ids.indexOf("GP-01");
          const idx02 = ids.indexOf("GP-02");
          expect(idx01).toBeGreaterThanOrEqual(0);
          expect(idx02).toBeGreaterThanOrEqual(0);
          expect(idx01).toBeLessThan(idx02);
        });
      });

      // -----------------------------------------------------------------------
      // 3. Constraints
      // -----------------------------------------------------------------------

      describe("queryNodes({type:'constraint'}) + getNodes", () => {
        it("returns empty result when no constraints exist", async () => {
          const result = await adapter.queryNodes({ type: "constraint" }, 1000, 0);
          expect(result.nodes).toHaveLength(0);
        });

        it("returns constraints with category and description in properties", async () => {
          await adapter.putNode({
            id: "C-01",
            type: "constraint",
            properties: { category: "technology", description: "Use TypeScript." },
          });
          await adapter.putNode({
            id: "C-02",
            type: "constraint",
            properties: { category: "security", description: "No plaintext secrets." },
          });

          const queryResult = await adapter.queryNodes({ type: "constraint" }, 1000, 0);
          expect(queryResult.nodes.length).toBeGreaterThanOrEqual(2);

          const ids = queryResult.nodes.map((n) => n.node.id);
          const nodesMap = await adapter.getNodes(ids);

          const c01 = nodesMap.get("C-01");
          expect(c01).toBeDefined();
          expect(c01!.properties.category).toBe("technology");
          expect(c01!.properties.description).toBe("Use TypeScript.");

          const c02 = nodesMap.get("C-02");
          expect(c02).toBeDefined();
          expect(c02!.properties.category).toBe("security");
        });
      });

      // -----------------------------------------------------------------------
      // 4. Active Project
      // -----------------------------------------------------------------------

      describe("queryNodes({type:'project', status:'active'}) + getNodes", () => {
        it("returns empty result when no active project exists", async () => {
          await adapter.putNode({
            id: "PR-001",
            type: "project",
            properties: { intent: "Build something great.", status: "archived" },
          });
          // Patch to archived status
          await adapter.patchNode({ id: "PR-001", properties: { status: "archived" } });

          const result = await adapter.queryNodes({ type: "project", status: "active" }, 1, 0);
          expect(result.nodes).toHaveLength(0);
        });

        it("returns active project with intent and related fields in properties", async () => {
          await adapter.putNode({
            id: "PR-001",
            type: "project",
            properties: {
              intent: "Build a great system.",
              success_criteria: '["criterion 1", "criterion 2"]',
              appetite: 3,
              horizon: '{"start": "2026-01"}',
              status: "active",
            },
          });
          await adapter.patchNode({ id: "PR-001", properties: { status: "active" } });

          const result = await adapter.queryNodes({ type: "project", status: "active" }, 1, 0);
          expect(result.nodes.length).toBeGreaterThanOrEqual(1);

          const nodesMap = await adapter.getNodes([result.nodes[0].node.id]);
          const proj = nodesMap.get("PR-001");
          expect(proj).toBeDefined();
          expect(proj!.properties.intent).toBe("Build a great system.");
        });
      });

      // -----------------------------------------------------------------------
      // 5. Active Phase
      // -----------------------------------------------------------------------

      describe("queryNodes({type:'phase', status:'active'}) + getNodes", () => {
        it("returns empty result when no active phase exists", async () => {
          const result = await adapter.queryNodes({ type: "phase", status: "active" }, 1, 0);
          expect(result.nodes).toHaveLength(0);
        });

        it("returns active phase with phase_type, intent, steering in properties", async () => {
          await adapter.putNode({
            id: "PH-001",
            type: "phase",
            properties: {
              project: "PR-001",
              phase_type: "execution",
              intent: "Execute the plan.",
              steering: "Focus on quality.",
              work_items: '["WI-001", "WI-002"]',
              status: "active",
            },
          });
          await adapter.patchNode({ id: "PH-001", properties: { status: "active" } });

          const result = await adapter.queryNodes({ type: "phase", status: "active" }, 1, 0);
          expect(result.nodes.length).toBeGreaterThanOrEqual(1);

          const nodesMap = await adapter.getNodes([result.nodes[0].node.id]);
          const phase = nodesMap.get("PH-001");
          expect(phase).toBeDefined();
          expect(phase!.properties.phase_type).toBe("execution");
          expect(phase!.properties.intent).toBe("Execute the plan.");
          expect(phase!.properties.steering).toBe("Focus on quality.");
        });
      });
    });

    // -----------------------------------------------------------------------
    // getToolUsage contract (WI-863)
    //
    // Verifies that getToolUsage returns correctly-shaped ToolUsageRow objects
    // and that filters (session_id, cycle, phase) AND-combine correctly.
    //
    // When seedToolUsage is provided (LocalAdapter), rows are pre-inserted and
    // the full filter suite runs. When it is absent (RemoteAdapter stub), the
    // empty-result path is exercised instead.
    // -----------------------------------------------------------------------

    describe("getToolUsage", () => {
      // Seed rows used across all filter tests.
      const SEED_ROWS: ToolUsageInsert[] = [
        {
          tool_name: "ideate_artifact_query",
          request_tokens: 100,
          response_tokens: 200,
          request_bytes: 512,
          response_bytes: 1024,
          session_id: "sess-a",
          cycle: 1,
          phase: "execute",
          timestamp: "2026-04-10T10:00:00.000Z",
        },
        {
          tool_name: "ideate_artifact_query",
          request_tokens: 150,
          response_tokens: 300,
          request_bytes: 768,
          response_bytes: 2048,
          session_id: "sess-a",
          cycle: 1,
          phase: "execute",
          timestamp: "2026-04-10T11:00:00.000Z",
        },
        {
          tool_name: "ideate_write_artifact",
          request_tokens: 80,
          response_tokens: 160,
          request_bytes: 400,
          response_bytes: 800,
          session_id: "sess-b",
          cycle: 2,
          phase: "review",
          timestamp: "2026-04-11T09:00:00.000Z",
        },
        {
          tool_name: "ideate_write_artifact",
          request_tokens: null,
          response_tokens: null,
          request_bytes: 300,
          response_bytes: 600,
          session_id: "sess-b",
          cycle: 2,
          phase: "review",
          timestamp: "2026-04-11T14:00:00.000Z",
        },
        {
          tool_name: "ideate_artifact_query",
          request_tokens: 200,
          response_tokens: 400,
          request_bytes: 900,
          response_bytes: 1800,
          session_id: "sess-c",
          cycle: 2,
          phase: "execute",
          timestamp: "2026-04-12T08:00:00.000Z",
        },
      ];

      // -----------------------------------------------------------------------
      // Shape — runs regardless of whether seedToolUsage is provided
      // -----------------------------------------------------------------------

      it("getToolUsage() resolves to an array without error", async () => {
        await expect(adapter.getToolUsage()).resolves.toBeInstanceOf(Array);
      });

      it("getToolUsage() with empty filter resolves to an array without error", async () => {
        await expect(adapter.getToolUsage({})).resolves.toBeInstanceOf(Array);
      });

      it("getToolUsage rows have correct shape when rows exist", async () => {
        if (!options.seedToolUsage) return; // skip shape check when adapter has no seed hook
        await options.seedToolUsage(SEED_ROWS);

        const rows = await adapter.getToolUsage();
        expect(rows.length).toBeGreaterThan(0);

        for (const row of rows) {
          // Required numeric id
          expect(typeof row.id).toBe("number");
          // Required string fields
          expect(typeof row.tool_name).toBe("string");
          expect(typeof row.timestamp).toBe("string");
          // Required numeric byte fields
          expect(typeof row.request_bytes).toBe("number");
          expect(typeof row.response_bytes).toBe("number");
          // Nullable token fields
          expect(
            row.request_tokens === null || typeof row.request_tokens === "number"
          ).toBe(true);
          expect(
            row.response_tokens === null || typeof row.response_tokens === "number"
          ).toBe(true);
          // Nullable context fields (wired by WI-861)
          expect(
            row.session_id === null || typeof row.session_id === "string"
          ).toBe(true);
          expect(row.cycle === null || typeof row.cycle === "number").toBe(true);
          expect(row.phase === null || typeof row.phase === "string").toBe(true);
        }
      });

      // -----------------------------------------------------------------------
      // Aggregate view — unfiltered; all rows returned
      // -----------------------------------------------------------------------

      it("aggregate view: no filter returns all seeded rows", async () => {
        if (!options.seedToolUsage) return;
        await options.seedToolUsage(SEED_ROWS);

        const rows = await adapter.getToolUsage();
        expect(rows).toHaveLength(SEED_ROWS.length);
      });

      it("aggregate view: rows are ordered by timestamp ASC", async () => {
        if (!options.seedToolUsage) return;
        await options.seedToolUsage(SEED_ROWS);

        const rows = await adapter.getToolUsage();
        const timestamps = rows.map((r) => r.timestamp);
        expect(timestamps).toEqual([...timestamps].sort());
      });

      // -----------------------------------------------------------------------
      // Detail view — filtered; subset of rows
      // -----------------------------------------------------------------------

      it("detail view: filter by session_id returns only matching rows", async () => {
        if (!options.seedToolUsage) return;
        await options.seedToolUsage(SEED_ROWS);

        const rows = await adapter.getToolUsage({ session_id: "sess-a" });
        // SEED_ROWS rows 0 and 1 both have session_id "sess-a"
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.session_id).toBe("sess-a");
        }
      });

      it("detail view: filter by cycle returns only matching rows", async () => {
        if (!options.seedToolUsage) return;
        await options.seedToolUsage(SEED_ROWS);

        const rows = await adapter.getToolUsage({ cycle: 1 });
        // Rows 0 and 1 have cycle=1
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.cycle).toBe(1);
        }
      });

      it("detail view: filter by phase returns only matching rows", async () => {
        if (!options.seedToolUsage) return;
        await options.seedToolUsage(SEED_ROWS);

        const rows = await adapter.getToolUsage({ phase: "review" });
        // Rows 2 and 3 have phase="review"
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.phase).toBe("review");
        }
      });

      // -----------------------------------------------------------------------
      // Filter combination — AND semantics; intersection of criteria
      // -----------------------------------------------------------------------

      it("filter combination: session_id + cycle filters are AND-combined", async () => {
        if (!options.seedToolUsage) return;
        await options.seedToolUsage(SEED_ROWS);

        // sess-a AND cycle=1 → rows 0 and 1 only
        const rows = await adapter.getToolUsage({ session_id: "sess-a", cycle: 1 });
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(row.session_id).toBe("sess-a");
          expect(row.cycle).toBe(1);
        }
      });

      it("filter combination: cycle + phase filters are AND-combined", async () => {
        if (!options.seedToolUsage) return;
        await options.seedToolUsage(SEED_ROWS);

        // cycle=2 AND phase="execute" → row 4 only (sess-c, ideate_artifact_query)
        const rows = await adapter.getToolUsage({ cycle: 2, phase: "execute" });
        expect(rows).toHaveLength(1);
        expect(rows[0].cycle).toBe(2);
        expect(rows[0].phase).toBe("execute");
        expect(rows[0].session_id).toBe("sess-c");
      });

      // -----------------------------------------------------------------------
      // No-match path — filter with no matches returns empty array (not an error)
      // -----------------------------------------------------------------------

      it("no-match: filter with no matching rows returns empty array", async () => {
        if (!options.seedToolUsage) {
          // Even without seeding, a non-matching filter must return []
          const rows = await adapter.getToolUsage({ session_id: "nonexistent-session-xyz" });
          expect(rows).toBeInstanceOf(Array);
          expect(rows).toHaveLength(0);
          return;
        }
        await options.seedToolUsage(SEED_ROWS);

        const rows = await adapter.getToolUsage({ session_id: "nonexistent-session-xyz" });
        expect(rows).toBeInstanceOf(Array);
        expect(rows).toHaveLength(0);
      });

      // -----------------------------------------------------------------------
      // Adapter truncation — the adapter contract covers (a) no silent
      // truncation from the adapter itself and (b) correctness of returned rows
      // at any size. Limit truncation (handler-level slicing via rows.slice(0,
      // limit) in tool-usage.ts) is a handler concern, not an adapter concern:
      // ToolUsageFilter has no `limit` field. This test verifies the adapter
      // does not silently cap results.
      // -----------------------------------------------------------------------

      it("no silent truncation: adapter returns all rows without capping at any threshold", async () => {
        if (!options.seedToolUsage) return;

        // Insert 50 rows with unique timestamps
        const manyRows: ToolUsageInsert[] = Array.from({ length: 50 }, (_, i) => ({
          tool_name: "ideate_artifact_query",
          request_tokens: i,
          response_tokens: i * 2,
          request_bytes: 100 + i,
          response_bytes: 200 + i,
          session_id: "sess-limit",
          cycle: 1,
          phase: "execute",
          // Use padded minute offsets so ordering is deterministic
          timestamp: `2026-04-15T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        }));
        await options.seedToolUsage(manyRows);

        const rows = await adapter.getToolUsage({ session_id: "sess-limit" });
        expect(rows).toHaveLength(50);
        // Verify rows are ordered by timestamp ASC
        const timestamps = rows.map((r) => r.timestamp);
        expect(timestamps).toEqual([...timestamps].sort());
      });

      // -----------------------------------------------------------------------
      // Context field round-trip (WI-861) — session_id, cycle, phase populated
      // -----------------------------------------------------------------------

      it("context fields round-trip: session_id, cycle, and phase survive insert→query", async () => {
        if (!options.seedToolUsage) return;

        const row: ToolUsageInsert = {
          tool_name: "ideate_context_tool",
          request_tokens: 42,
          response_tokens: 84,
          request_bytes: 256,
          response_bytes: 512,
          session_id: "sess-roundtrip",
          cycle: 7,
          phase: "refine",
          timestamp: "2026-04-15T12:00:00.000Z",
        };
        await options.seedToolUsage([row]);

        const rows = await adapter.getToolUsage({ session_id: "sess-roundtrip" });
        expect(rows).toHaveLength(1);

        const r = rows[0];
        expect(r.session_id).toBe("sess-roundtrip");
        expect(r.cycle).toBe(7);
        expect(r.phase).toBe("refine");
        expect(r.tool_name).toBe("ideate_context_tool");
        expect(r.request_tokens).toBe(42);
        expect(r.response_tokens).toBe(84);
        expect(r.request_bytes).toBe(256);
        expect(r.response_bytes).toBe(512);
        expect(r.timestamp).toBe("2026-04-15T12:00:00.000Z");
      });

      // -----------------------------------------------------------------------
      // Null tolerance — null token values do not cause errors or wrong shape
      // -----------------------------------------------------------------------

      it("null token fields: rows with null request/response tokens are returned correctly", async () => {
        if (!options.seedToolUsage) return;

        const row: ToolUsageInsert = {
          tool_name: "ideate_null_tokens",
          request_tokens: null,
          response_tokens: null,
          request_bytes: 100,
          response_bytes: 200,
          session_id: "sess-null",
          cycle: null,
          phase: null,
          timestamp: "2026-04-15T13:00:00.000Z",
        };
        await options.seedToolUsage([row]);

        const rows = await adapter.getToolUsage({ session_id: "sess-null" });
        expect(rows).toHaveLength(1);
        expect(rows[0].request_tokens).toBeNull();
        expect(rows[0].response_tokens).toBeNull();
        expect(rows[0].cycle).toBeNull();
        expect(rows[0].phase).toBeNull();
      });

      // -----------------------------------------------------------------------
      // Negative shape (AC-4) — ValidatingAdapter rejects malformed rows
      //
      // Constructs a minimal stub whose getToolUsage returns a row with a
      // missing required field (tool_name: undefined), wraps it in
      // ValidatingAdapter, and asserts that ValidatingAdapter throws rather
      // than silently propagating the corrupt row.
      // -----------------------------------------------------------------------

      it("negative shape: ValidatingAdapter throws when inner adapter returns row with missing tool_name", async () => {
        // Build a stub that returns a single malformed row (tool_name missing)
        const malformedRow = {
          id: 1,
          tool_name: undefined as unknown as string,
          timestamp: "2026-04-15T00:00:00.000Z",
          request_tokens: null,
          response_tokens: null,
          request_bytes: 0,
          response_bytes: 0,
          session_id: null,
          cycle: null,
          phase: null,
        };

        const stubAdapter = {
          ...adapter, // inherit all methods from the real adapter
          getToolUsage: async (): Promise<ToolUsageRow[]> => [malformedRow as ToolUsageRow],
        } as StorageAdapter;

        const validating = new ValidatingAdapter(stubAdapter);
        await expect(validating.getToolUsage()).rejects.toThrow();
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
    drizzleDb: ReturnType<typeof drizzle<typeof dbSchema>> | null;
  } = {
    tmpDir: "",
    db: null,
    drizzleDb: null,
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
      state.drizzleDb = drizzleDb;

      const raw = new LocalAdapter({ db, drizzleDb, ideateDir });
      const adapter = new ValidatingAdapter(raw);
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
      state.drizzleDb = null;
      if (state.tmpDir) {
        fs.rmSync(state.tmpDir, { recursive: true, force: true });
        state.tmpDir = "";
      }
    },
    {
      // Provide a seedToolUsage hook that inserts rows via insertToolUsage
      // using the drizzleDb from the most recently created adapter instance.
      seedToolUsage: (rows: ToolUsageInsert[]) => {
        if (!state.drizzleDb) {
          throw new Error("seedToolUsage called before adapter was created");
        }
        for (const row of rows) {
          insertToolUsage(state.drizzleDb, row);
        }
      },
    }
  );
});
