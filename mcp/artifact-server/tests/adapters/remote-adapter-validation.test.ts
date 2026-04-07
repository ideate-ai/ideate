/**
 * remote-adapter-validation.test.ts — RemoteAdapter pre-flight validation tests
 *
 * Per WI-671: Covers limit/offset and batchMutate input validation for RemoteAdapter.
 * All tests here are offline (pre-flight checks run before any GraphQL call is issued).
 * GraphQLClient is mocked so no live server is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the GraphQLClient so no network calls are made.
// Validation runs before the client is ever invoked, so the mock just needs to exist.
vi.mock("../../src/adapters/remote/client.js", () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({
    query: vi.fn(),
    mutate: vi.fn(),
  })),
}));

import { RemoteAdapter } from "../../src/adapters/remote/index.js";
import { ValidationError, ImmutableFieldError } from "../../src/adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAdapter(): RemoteAdapter {
  return new RemoteAdapter({
    endpoint: "http://localhost:4000/graphql",
    org_id: "test-org",
    codebase_id: "test-codebase",
    auth_token: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RemoteAdapter Validation Layer (WI-671)", () => {
  let adapter: RemoteAdapter;

  beforeEach(() => {
    adapter = createAdapter();
  });

  // =========================================================================
  // AC-2: limit/offset validation in queryNodes() and queryGraph()
  // =========================================================================

  describe("queryNodes — limit/offset validation", () => {
    it("rejects negative limit with INVALID_LIMIT", async () => {
      await expect(
        adapter.queryNodes({ type: "guiding_principle" }, -1, 0)
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.queryNodes({ type: "guiding_principle" }, -1, 0);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_LIMIT");
      }
    });

    it("rejects non-integer limit with INVALID_LIMIT", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        adapter.queryNodes({ type: "guiding_principle" }, 1.5, 0)
      ).rejects.toThrow(ValidationError);

      try {
        // @ts-expect-error Testing runtime behavior
        await adapter.queryNodes({ type: "guiding_principle" }, 1.5, 0);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_LIMIT");
      }
    });

    it("rejects negative offset with INVALID_OFFSET", async () => {
      await expect(
        adapter.queryNodes({ type: "guiding_principle" }, 10, -1)
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.queryNodes({ type: "guiding_principle" }, 10, -1);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_OFFSET");
      }
    });

    it("rejects non-integer offset with INVALID_OFFSET", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        adapter.queryNodes({ type: "guiding_principle" }, 10, 0.7)
      ).rejects.toThrow(ValidationError);

      try {
        // @ts-expect-error Testing runtime behavior
        await adapter.queryNodes({ type: "guiding_principle" }, 10, 0.7);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_OFFSET");
      }
    });

    // Happy path: zero limit/offset are valid (throw past validation, hit network mock)
    it("passes validation for zero limit and offset (network will fail — that is expected)", async () => {
      // Validation passes but the mocked client throws. We only care that the error
      // is NOT a ValidationError with INVALID_LIMIT / INVALID_OFFSET.
      try {
        await adapter.queryNodes({ type: "guiding_principle" }, 0, 0);
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("INVALID_LIMIT");
          expect((err as ValidationError).code).not.toBe("INVALID_OFFSET");
        }
        // Any other error type (network, mock, etc.) is fine — validation passed
      }
    });

    it("passes validation for positive limit and offset", async () => {
      try {
        await adapter.queryNodes({ type: "guiding_principle" }, 10, 5);
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("INVALID_LIMIT");
          expect((err as ValidationError).code).not.toBe("INVALID_OFFSET");
        }
      }
    });
  });

  describe("queryGraph — limit/offset validation", () => {
    it("rejects negative limit with INVALID_LIMIT", async () => {
      await expect(
        adapter.queryGraph({ origin_id: "GP-001" }, -1, 0)
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.queryGraph({ origin_id: "GP-001" }, -1, 0);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_LIMIT");
      }
    });

    it("rejects non-integer limit with INVALID_LIMIT", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        adapter.queryGraph({ origin_id: "GP-001" }, 2.5, 0)
      ).rejects.toThrow(ValidationError);

      try {
        // @ts-expect-error Testing runtime behavior
        await adapter.queryGraph({ origin_id: "GP-001" }, 2.5, 0);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_LIMIT");
      }
    });

    it("rejects negative offset with INVALID_OFFSET", async () => {
      await expect(
        adapter.queryGraph({ origin_id: "GP-001" }, 10, -1)
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.queryGraph({ origin_id: "GP-001" }, 10, -1);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_OFFSET");
      }
    });

    it("rejects non-integer offset with INVALID_OFFSET", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior
        adapter.queryGraph({ origin_id: "GP-001" }, 10, 1.9)
      ).rejects.toThrow(ValidationError);

      try {
        // @ts-expect-error Testing runtime behavior
        await adapter.queryGraph({ origin_id: "GP-001" }, 10, 1.9);
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_OFFSET");
      }
    });

    it("passes validation for positive limit and offset", async () => {
      try {
        await adapter.queryGraph({ origin_id: "GP-001" }, 10, 0);
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("INVALID_LIMIT");
          expect((err as ValidationError).code).not.toBe("INVALID_OFFSET");
        }
      }
    });
  });

  // =========================================================================
  // AC-3: batchMutate input validation
  // =========================================================================

  describe("batchMutate — input validation", () => {
    // --- EMPTY_BATCH ---

    it("throws EMPTY_BATCH for empty nodes array", async () => {
      await expect(
        adapter.batchMutate({ nodes: [] })
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.batchMutate({ nodes: [] });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("EMPTY_BATCH");
      }
    });

    // Happy path for EMPTY_BATCH — a valid single-node batch passes validation
    it("passes validation for a valid node batch", async () => {
      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "Test" } },
          ],
        });
      } catch (err) {
        // Any error other than EMPTY_BATCH is fine — validation passed
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("EMPTY_BATCH");
        }
      }
    });

    // --- MISSING_NODE_ID ---

    it("throws MISSING_NODE_ID when node lacks id field", async () => {
      await expect(
        adapter.batchMutate({
          nodes: [
            // @ts-expect-error Testing missing id
            { type: "guiding_principle", properties: { name: "Test" } },
          ],
        })
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.batchMutate({
          nodes: [
            // @ts-expect-error Testing missing id
            { type: "guiding_principle", properties: { name: "Test" } },
          ],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("MISSING_NODE_ID");
      }
    });

    it("passes validation when node has an id", async () => {
      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "Test" } },
          ],
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("MISSING_NODE_ID");
        }
      }
    });

    // --- MISSING_NODE_TYPE ---

    it("throws MISSING_NODE_TYPE when node lacks type field", async () => {
      await expect(
        adapter.batchMutate({
          nodes: [
            // @ts-expect-error Testing missing type
            { id: "GP-001", properties: { name: "Test" } },
          ],
        })
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.batchMutate({
          nodes: [
            // @ts-expect-error Testing missing type
            { id: "GP-001", properties: { name: "Test" } },
          ],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("MISSING_NODE_TYPE");
      }
    });

    it("passes validation when node has a type", async () => {
      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "Test" } },
          ],
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("MISSING_NODE_TYPE");
        }
      }
    });

    // --- MISSING_NODE_PROPERTIES ---

    it("throws MISSING_NODE_PROPERTIES when node lacks properties field", async () => {
      await expect(
        adapter.batchMutate({
          nodes: [
            // @ts-expect-error Testing missing properties
            { id: "GP-001", type: "guiding_principle" },
          ],
        })
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.batchMutate({
          nodes: [
            // @ts-expect-error Testing missing properties
            { id: "GP-001", type: "guiding_principle" },
          ],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("MISSING_NODE_PROPERTIES");
      }
    });

    it("passes validation when node has properties", async () => {
      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "Test" } },
          ],
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("MISSING_NODE_PROPERTIES");
        }
      }
    });

    // --- INVALID_NODE_TYPE ---

    it("throws INVALID_NODE_TYPE for an unknown node type", async () => {
      await expect(
        adapter.batchMutate({
          nodes: [
            {
              id: "GP-001",
              // @ts-expect-error Testing invalid type
              type: "not_a_real_type",
              properties: { name: "Test" },
            },
          ],
        })
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.batchMutate({
          nodes: [
            {
              id: "GP-001",
              // @ts-expect-error Testing invalid type
              type: "not_a_real_type",
              properties: { name: "Test" },
            },
          ],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_NODE_TYPE");
      }
    });

    it("passes validation for a known node type", async () => {
      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "Test" } },
          ],
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("INVALID_NODE_TYPE");
        }
      }
    });

    // --- MISSING_EDGE_SOURCE ---

    it("throws MISSING_EDGE_SOURCE when edge lacks source_id", async () => {
      await expect(
        adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            // @ts-expect-error Testing missing source_id
            { target_id: "GP-002", edge_type: "relates_to", properties: {} },
          ],
        })
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            // @ts-expect-error Testing missing source_id
            { target_id: "GP-002", edge_type: "relates_to", properties: {} },
          ],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("MISSING_EDGE_SOURCE");
      }
    });

    it("passes validation when edge has source_id", async () => {
      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            { source_id: "GP-001", target_id: "GP-002", edge_type: "relates_to", properties: {} },
          ],
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("MISSING_EDGE_SOURCE");
        }
      }
    });

    // --- MISSING_EDGE_TARGET ---

    it("throws MISSING_EDGE_TARGET when edge lacks target_id", async () => {
      await expect(
        adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            // @ts-expect-error Testing missing target_id
            { source_id: "GP-001", edge_type: "relates_to", properties: {} },
          ],
        })
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            // @ts-expect-error Testing missing target_id
            { source_id: "GP-001", edge_type: "relates_to", properties: {} },
          ],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("MISSING_EDGE_TARGET");
      }
    });

    it("passes validation when edge has target_id", async () => {
      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            { source_id: "GP-001", target_id: "GP-002", edge_type: "relates_to", properties: {} },
          ],
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("MISSING_EDGE_TARGET");
        }
      }
    });

    // --- MISSING_EDGE_TYPE ---

    it("throws MISSING_EDGE_TYPE when edge lacks edge_type", async () => {
      await expect(
        adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            // @ts-expect-error Testing missing edge_type
            { source_id: "GP-001", target_id: "GP-002", properties: {} },
          ],
        })
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            // @ts-expect-error Testing missing edge_type
            { source_id: "GP-001", target_id: "GP-002", properties: {} },
          ],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("MISSING_EDGE_TYPE");
      }
    });

    it("passes validation when edge has an edge_type", async () => {
      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            { source_id: "GP-001", target_id: "GP-002", edge_type: "relates_to", properties: {} },
          ],
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("MISSING_EDGE_TYPE");
        }
      }
    });

    // --- INVALID_EDGE_TYPE ---

    it("throws INVALID_EDGE_TYPE for an unknown edge type", async () => {
      await expect(
        adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            {
              source_id: "GP-001",
              target_id: "GP-002",
              // @ts-expect-error Testing invalid edge_type
              edge_type: "not_a_real_edge_type",
              properties: {},
            },
          ],
        })
      ).rejects.toThrow(ValidationError);

      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            {
              source_id: "GP-001",
              target_id: "GP-002",
              // @ts-expect-error Testing invalid edge_type
              edge_type: "not_a_real_edge_type",
              properties: {},
            },
          ],
        });
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).code).toBe("INVALID_EDGE_TYPE");
      }
    });

    it("passes validation for a known edge type", async () => {
      try {
        await adapter.batchMutate({
          nodes: [
            { id: "GP-001", type: "guiding_principle", properties: { name: "T1" } },
            { id: "GP-002", type: "guiding_principle", properties: { name: "T2" } },
          ],
          edges: [
            { source_id: "GP-001", target_id: "GP-002", edge_type: "relates_to", properties: {} },
          ],
        });
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("INVALID_EDGE_TYPE");
        }
      }
    });
  });

  // =========================================================================
  // AC-676: deleteNode, putEdge, removeEdges validation
  // =========================================================================

  describe("deleteNode — id validation", () => {
    it("throws INVALID_NODE_ID for empty string id", async () => {
      await expect(adapter.deleteNode("")).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
    });

    it("throws INVALID_NODE_ID for whitespace-only id", async () => {
      await expect(adapter.deleteNode("   ")).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
    });

    it("throws INVALID_NODE_ID for non-string id", async () => {
      // @ts-expect-error Testing runtime behavior with wrong type
      await expect(adapter.deleteNode(42)).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
    });

    it("passes validation for a non-empty id (network error is expected)", async () => {
      try {
        await adapter.deleteNode("GP-001");
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("INVALID_NODE_ID");
        }
      }
    });
  });

  describe("putEdge — input validation", () => {
    it("throws MISSING_EDGE_SOURCE when source_id is empty", async () => {
      await expect(
        adapter.putEdge({ source_id: "", target_id: "GP-002", edge_type: "relates_to", properties: {} })
      ).rejects.toMatchObject({ code: "MISSING_EDGE_SOURCE" });
    });

    it("throws MISSING_EDGE_SOURCE when source_id is whitespace", async () => {
      await expect(
        adapter.putEdge({ source_id: "   ", target_id: "GP-002", edge_type: "relates_to", properties: {} })
      ).rejects.toMatchObject({ code: "MISSING_EDGE_SOURCE" });
    });

    it("throws MISSING_EDGE_TARGET when target_id is empty", async () => {
      await expect(
        adapter.putEdge({ source_id: "GP-001", target_id: "", edge_type: "relates_to", properties: {} })
      ).rejects.toMatchObject({ code: "MISSING_EDGE_TARGET" });
    });

    it("throws MISSING_EDGE_TARGET when target_id is whitespace", async () => {
      await expect(
        adapter.putEdge({ source_id: "GP-001", target_id: "   ", edge_type: "relates_to", properties: {} })
      ).rejects.toMatchObject({ code: "MISSING_EDGE_TARGET" });
    });

    it("throws MISSING_EDGE_TYPE when edge_type is missing", async () => {
      await expect(
        // @ts-expect-error Testing missing edge_type
        adapter.putEdge({ source_id: "GP-001", target_id: "GP-002", properties: {} })
      ).rejects.toMatchObject({ code: "MISSING_EDGE_TYPE" });
    });

    it("throws INVALID_EDGE_TYPE for an unknown edge type", async () => {
      await expect(
        adapter.putEdge({
          source_id: "GP-001",
          target_id: "GP-002",
          // @ts-expect-error Testing invalid edge_type
          edge_type: "not_a_real_edge_type",
          properties: {},
        })
      ).rejects.toMatchObject({ code: "INVALID_EDGE_TYPE" });
    });

    it("passes validation for a valid edge (network error is expected)", async () => {
      try {
        await adapter.putEdge({ source_id: "GP-001", target_id: "GP-002", edge_type: "relates_to", properties: {} });
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toMatch(/^MISSING_EDGE_|^INVALID_EDGE_TYPE$/);
        }
      }
    });
  });

  describe("removeEdges — input validation", () => {
    it("throws INVALID_NODE_ID when source_id is empty string", async () => {
      await expect(
        adapter.removeEdges("", ["relates_to"])
      ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
    });

    it("throws INVALID_NODE_ID when source_id is whitespace", async () => {
      await expect(
        adapter.removeEdges("   ", ["relates_to"])
      ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
    });

    it("throws INVALID_NODE_ID when source_id is non-string", async () => {
      await expect(
        // @ts-expect-error Testing runtime behavior with wrong type
        adapter.removeEdges(null, ["relates_to"])
      ).rejects.toMatchObject({ code: "INVALID_NODE_ID" });
    });

    it("throws INVALID_EDGE_TYPE for an invalid edge type in the array", async () => {
      await expect(
        // @ts-expect-error Testing invalid edge_type
        adapter.removeEdges("GP-001", ["not_a_real_edge_type"])
      ).rejects.toMatchObject({ code: "INVALID_EDGE_TYPE" });
    });

    it("passes validation for valid inputs (network error is expected)", async () => {
      try {
        await adapter.removeEdges("GP-001", ["relates_to"]);
      } catch (err) {
        if (err instanceof ValidationError) {
          expect((err as ValidationError).code).not.toBe("INVALID_NODE_ID");
          expect((err as ValidationError).code).not.toBe("INVALID_EDGE_TYPE");
        }
      }
    });
  });

  // =========================================================================
  // patchNode — IMMUTABLE_FIELD validation
  // =========================================================================

  describe("patchNode — IMMUTABLE_FIELD validation", () => {
    it("throws ImmutableFieldError when 'id' appears in properties", async () => {
      await expect(
        adapter.patchNode({ id: "GP-001", properties: { id: "GP-099" } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);

      try {
        await adapter.patchNode({ id: "GP-001", properties: { id: "GP-099" } });
      } catch (err) {
        expect(err).toBeInstanceOf(ImmutableFieldError);
        expect((err as ImmutableFieldError).code).toBe("IMMUTABLE_FIELD");
      }
    });

    it("throws ImmutableFieldError when 'type' appears in properties", async () => {
      await expect(
        adapter.patchNode({ id: "GP-001", properties: { type: "constraint" } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);

      try {
        await adapter.patchNode({ id: "GP-001", properties: { type: "constraint" } });
      } catch (err) {
        expect(err).toBeInstanceOf(ImmutableFieldError);
        expect((err as ImmutableFieldError).code).toBe("IMMUTABLE_FIELD");
      }
    });

    it("throws ImmutableFieldError when 'cycle_created' appears in properties", async () => {
      await expect(
        adapter.patchNode({ id: "GP-001", properties: { cycle_created: 3 } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);

      try {
        await adapter.patchNode({ id: "GP-001", properties: { cycle_created: 3 } });
      } catch (err) {
        expect(err).toBeInstanceOf(ImmutableFieldError);
        expect((err as ImmutableFieldError).code).toBe("IMMUTABLE_FIELD");
      }
    });

    it("passes validation for mutable properties (network error is expected)", async () => {
      try {
        await adapter.patchNode({ id: "GP-001", properties: { name: "Updated Name" } });
      } catch (err) {
        if (err instanceof ImmutableFieldError) {
          throw new Error("Should not have thrown ImmutableFieldError for mutable field");
        }
      }
    });

    it('rejects empty node id with INVALID_NODE_ID', async () => {
      const err = await adapter.patchNode({ id: '', properties: { name: 'test' } }).catch(e => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.code).toBe('INVALID_NODE_ID');
    });
  });
});
