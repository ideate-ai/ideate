/**
 * validating.test.ts — Unit tests for ValidatingAdapter decorator.
 *
 * Architecture:
 * - A mock StorageAdapter is created via createMockAdapter(). It records every
 *   call in a `calls` array and returns the minimal valid response for each
 *   method. Tests use this to verify:
 *   (a) Invalid inputs throw ValidationError with the expected error code.
 *   (b) Valid inputs are passed through to the inner adapter unchanged.
 *
 * The mock isolates ValidatingAdapter from all real storage concerns
 * (filesystem, SQLite, etc.) so these tests run purely in-memory.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  StorageAdapter,
  Node,
  NodeType,
  MutateNodeInput,
  MutateNodeResult,
  UpdateNodeInput,
  UpdateNodeResult,
  DeleteNodeResult,
  Edge,
  TraversalOptions,
  TraversalResult,
  GraphQuery,
  QueryResult,
  BatchMutateInput,
  BatchMutateResult,
  NodeFilter,
  ALL_NODE_TYPES,
  ALL_EDGE_TYPES,
  ValidationError,
  ImmutableFieldError,
} from "../adapter.js";
import { ValidatingAdapter, CYCLE_SCOPED_TYPES } from "../validating.js";
import type { EdgeType } from "../schema.js";

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

interface MockCall {
  method: string;
  args: unknown[];
}

interface MockAdapter extends StorageAdapter {
  calls: MockCall[];
}

function createMockAdapter(): MockAdapter {
  const calls: MockCall[] = [];

  const minimalNode: Node = {
    id: "WI-001",
    type: "work_item",
    status: null,
    cycle_created: null,
    cycle_modified: null,
    content_hash: "abc123",
    token_count: null,
    properties: {},
  };

  const minimalQueryResult: QueryResult = {
    nodes: [],
    total_count: 0,
  };

  const minimalTraversalResult: TraversalResult = {
    ranked_nodes: [],
    total_tokens: 0,
    ppr_scores: [],
  };

  const minimalBatchResult: BatchMutateResult = {
    results: [],
    errors: [],
  };

  return {
    calls,

    async initialize() {
      calls.push({ method: "initialize", args: [] });
    },

    async shutdown() {
      calls.push({ method: "shutdown", args: [] });
    },

    async getNode(id) {
      calls.push({ method: "getNode", args: [id] });
      return null;
    },

    async getNodes(ids) {
      calls.push({ method: "getNodes", args: [ids] });
      return new Map();
    },

    async readNodeContent(id) {
      calls.push({ method: "readNodeContent", args: [id] });
      return "";
    },

    async putNode(input) {
      calls.push({ method: "putNode", args: [input] });
      return { id: input.id, status: "created" };
    },

    async patchNode(input) {
      calls.push({ method: "patchNode", args: [input] });
      return { id: input.id, status: "updated" };
    },

    async deleteNode(id) {
      calls.push({ method: "deleteNode", args: [id] });
      return { id, status: "deleted" };
    },

    async putEdge(edge) {
      calls.push({ method: "putEdge", args: [edge] });
    },

    async removeEdges(source_id, edge_types) {
      calls.push({ method: "removeEdges", args: [source_id, edge_types] });
    },

    async getEdges(id, direction) {
      calls.push({ method: "getEdges", args: [id, direction] });
      return [];
    },

    async traverse(options) {
      calls.push({ method: "traverse", args: [options] });
      return minimalTraversalResult;
    },

    async queryGraph(query, limit, offset) {
      calls.push({ method: "queryGraph", args: [query, limit, offset] });
      return minimalQueryResult;
    },

    async queryNodes(filter, limit, offset) {
      calls.push({ method: "queryNodes", args: [filter, limit, offset] });
      return minimalQueryResult;
    },

    async indexFiles(paths: string[]): Promise<void> {
      calls.push({ method: "indexFiles", args: [paths] });
    },

    async removeFiles(paths: string[]): Promise<void> {
      calls.push({ method: "removeFiles", args: [paths] });
    },

    async nextId(type, cycle) {
      calls.push({ method: "nextId", args: [type, cycle] });
      return "WI-001";
    },

    async batchMutate(input) {
      calls.push({ method: "batchMutate", args: [input] });
      return minimalBatchResult;
    },

    async countNodes(filter, group_by) {
      calls.push({ method: "countNodes", args: [filter, group_by] });
      return [];
    },

    async getDomainState(domains) {
      calls.push({ method: "getDomainState", args: [domains] });
      return new Map();
    },

    async getConvergenceData(cycle) {
      calls.push({ method: "getConvergenceData", args: [cycle] });
      return { findings_by_severity: {}, cycle_summary_content: null };
    },

    async archiveCycle(cycle) {
      calls.push({ method: "archiveCycle", args: [cycle] });
      return "Archived cycle";
    },

    async appendJournalEntry(args) {
      calls.push({ method: "appendJournalEntry", args: [args] });
      return "J-001-001";
    },

    async getToolUsage(filter) {
      calls.push({ method: "getToolUsage", args: [filter] });
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid NodeType guaranteed to be in ALL_NODE_TYPES (not cycle-scoped). */
const VALID_NODE_TYPE: NodeType = "work_item";

/** A cycle-scoped NodeType from CYCLE_SCOPED_TYPES. */
const CYCLE_SCOPED_TYPE: NodeType = "finding";

/** A valid EdgeType guaranteed to be in ALL_EDGE_TYPES. */
const VALID_EDGE_TYPE: EdgeType = ALL_EDGE_TYPES[0];

/** A NodeType string that is definitely not in ALL_NODE_TYPES. */
const INVALID_NODE_TYPE = "nonexistent_type_xyz";

/** An EdgeType string that is definitely not in ALL_EDGE_TYPES. */
const INVALID_EDGE_TYPE = "nonexistent_edge_xyz";

function assertValidationError(
  err: unknown,
  expectedCode: string
): asserts err is ValidationError {
  expect(err).toBeInstanceOf(ValidationError);
  expect((err as ValidationError).code).toBe(expectedCode);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let mock: MockAdapter;
let adapter: ValidatingAdapter;

beforeEach(() => {
  mock = createMockAdapter();
  adapter = new ValidatingAdapter(mock);
});

// ---------------------------------------------------------------------------
// initialize / shutdown — pass through without validation
// ---------------------------------------------------------------------------

describe("initialize", () => {
  it("passes through to inner adapter", async () => {
    await adapter.initialize();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe("initialize");
  });
});

describe("shutdown", () => {
  it("passes through to inner adapter", async () => {
    await adapter.shutdown();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe("shutdown");
  });
});

// ---------------------------------------------------------------------------
// getNode
// ---------------------------------------------------------------------------

describe("getNode", () => {
  it("throws INVALID_NODE_ID for empty string id", async () => {
    await expect(adapter.getNode("")).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_NODE_ID for whitespace-only id", async () => {
    await expect(adapter.getNode("   ")).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid id to inner adapter", async () => {
    await adapter.getNode("WI-001");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "getNode", args: ["WI-001"] });
  });
});

// ---------------------------------------------------------------------------
// getNodes
// ---------------------------------------------------------------------------

describe("getNodes", () => {
  it("throws INVALID_NODE_ID if any id is empty", async () => {
    await expect(adapter.getNodes(["WI-001", ""])).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid ids to inner adapter", async () => {
    await adapter.getNodes(["WI-001", "WI-002"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "getNodes",
      args: [["WI-001", "WI-002"]],
    });
  });
});

// ---------------------------------------------------------------------------
// readNodeContent
// ---------------------------------------------------------------------------

describe("readNodeContent", () => {
  it("throws INVALID_NODE_ID for empty string id", async () => {
    await expect(adapter.readNodeContent("")).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid id to inner adapter", async () => {
    await adapter.readNodeContent("WI-001");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "readNodeContent",
      args: ["WI-001"],
    });
  });
});

// ---------------------------------------------------------------------------
// putNode
// ---------------------------------------------------------------------------

describe("putNode", () => {
  it("throws INVALID_NODE_ID for empty id", async () => {
    const input: MutateNodeInput = {
      id: "",
      type: VALID_NODE_TYPE,
      properties: { name: "test" },
    };
    await expect(adapter.putNode(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_NODE_ID for non-string id", async () => {
    const input = {
      id: 123 as unknown as string,
      type: VALID_NODE_TYPE,
      properties: { name: "test" },
    };
    await expect(adapter.putNode(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_NODE_TYPE for invalid type", async () => {
    const input = {
      id: "WI-001",
      type: INVALID_NODE_TYPE as unknown as NodeType,
      properties: { name: "test" },
    };
    await expect(adapter.putNode(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_NODE_PROPERTIES for null properties", async () => {
    const input = {
      id: "WI-001",
      type: VALID_NODE_TYPE,
      properties: null as unknown as Record<string, unknown>,
    };
    await expect(adapter.putNode(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_NODE_PROPERTIES");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_NODE_PROPERTIES for array properties", async () => {
    const input = {
      id: "WI-001",
      type: VALID_NODE_TYPE,
      properties: [] as unknown as Record<string, unknown>,
    };
    await expect(adapter.putNode(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_NODE_PROPERTIES");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_CYCLE for cycle-scoped type without cycle", async () => {
    const input: MutateNodeInput = {
      id: "F-001-001",
      type: CYCLE_SCOPED_TYPE,
      properties: { title: "test finding" },
      // cycle intentionally omitted
    };
    await expect(adapter.putNode(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_CYCLE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid input for non-cycle-scoped type", async () => {
    const input: MutateNodeInput = {
      id: "WI-001",
      type: VALID_NODE_TYPE,
      properties: { title: "My work item" },
    };
    const result = await adapter.putNode(input);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "putNode", args: [input] });
    expect(result).toEqual({ id: "WI-001", status: "created" });
  });

  it("passes through valid input for cycle-scoped type with cycle provided", async () => {
    const input: MutateNodeInput = {
      id: "F-001-001",
      type: CYCLE_SCOPED_TYPE,
      properties: { title: "Finding" },
      cycle: 1,
    };
    await adapter.putNode(input);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "putNode", args: [input] });
  });

  it("CYCLE_SCOPED_TYPES includes all expected types", () => {
    const expected = [
      "finding",
      "decision_log",
      "cycle_summary",
      "review_manifest",
      "review_output",
      "proxy_human_decision",
    ] as const;
    for (const t of expected) {
      expect(CYCLE_SCOPED_TYPES.has(t)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// patchNode
// ---------------------------------------------------------------------------

describe("patchNode", () => {
  it("throws INVALID_NODE_ID for empty id", async () => {
    const input: UpdateNodeInput = { id: "", properties: { title: "new" } };
    await expect(adapter.patchNode(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_NODE_PROPERTIES for null properties", async () => {
    const input = {
      id: "WI-001",
      properties: null as unknown as Record<string, unknown>,
    };
    await expect(adapter.patchNode(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_NODE_PROPERTIES");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_NODE_PROPERTIES for array properties", async () => {
    const input = {
      id: "WI-001",
      properties: ["bad"] as unknown as Record<string, unknown>,
    };
    await expect(adapter.patchNode(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_NODE_PROPERTIES");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws IMMUTABLE_FIELD when properties contains 'id'", async () => {
    const input: UpdateNodeInput = {
      id: "WI-001",
      properties: { id: "WI-002" },
    };
    await expect(adapter.patchNode(input)).rejects.toBeInstanceOf(ImmutableFieldError);
    expect(mock.calls).toHaveLength(0);
  });

  it("throws IMMUTABLE_FIELD when properties contains 'type'", async () => {
    const input: UpdateNodeInput = {
      id: "WI-001",
      properties: { type: "work_item" },
    };
    await expect(adapter.patchNode(input)).rejects.toBeInstanceOf(ImmutableFieldError);
    expect(mock.calls).toHaveLength(0);
  });

  it("throws IMMUTABLE_FIELD when properties contains 'cycle_created'", async () => {
    const input: UpdateNodeInput = {
      id: "WI-001",
      properties: { cycle_created: 1 },
    };
    await expect(adapter.patchNode(input)).rejects.toBeInstanceOf(ImmutableFieldError);
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid input to inner adapter", async () => {
    const input: UpdateNodeInput = {
      id: "WI-001",
      properties: { title: "Updated title", status: "active" },
    };
    const result = await adapter.patchNode(input);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "patchNode", args: [input] });
    expect(result).toEqual({ id: "WI-001", status: "updated" });
  });
});

// ---------------------------------------------------------------------------
// deleteNode
// ---------------------------------------------------------------------------

describe("deleteNode", () => {
  it("throws INVALID_NODE_ID for empty string id", async () => {
    await expect(adapter.deleteNode("")).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid id to inner adapter", async () => {
    const result = await adapter.deleteNode("WI-001");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "deleteNode", args: ["WI-001"] });
    expect(result).toEqual({ id: "WI-001", status: "deleted" });
  });
});

// ---------------------------------------------------------------------------
// putEdge
// ---------------------------------------------------------------------------

describe("putEdge", () => {
  const validEdge: Edge = {
    source_id: "WI-001",
    target_id: "WI-002",
    edge_type: VALID_EDGE_TYPE,
    properties: {},
  };

  it("throws MISSING_EDGE_SOURCE for empty source_id", async () => {
    const edge: Edge = { ...validEdge, source_id: "" };
    await expect(adapter.putEdge(edge)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_EDGE_SOURCE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_EDGE_TARGET for empty target_id", async () => {
    const edge: Edge = { ...validEdge, target_id: "" };
    await expect(adapter.putEdge(edge)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_EDGE_TARGET");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_EDGE_TYPE for invalid edge_type", async () => {
    const edge = { ...validEdge, edge_type: INVALID_EDGE_TYPE as unknown as EdgeType };
    await expect(adapter.putEdge(edge)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid edge to inner adapter", async () => {
    await adapter.putEdge(validEdge);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "putEdge", args: [validEdge] });
  });
});

// ---------------------------------------------------------------------------
// removeEdges
// ---------------------------------------------------------------------------

describe("removeEdges", () => {
  it("throws INVALID_NODE_ID for empty source_id", async () => {
    await expect(adapter.removeEdges("", [VALID_EDGE_TYPE])).rejects.toSatisfy(
      (e) => {
        assertValidationError(e, "INVALID_NODE_ID");
        return true;
      }
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("resolves without error for empty edge_types array (no-op)", async () => {
    await expect(adapter.removeEdges("WI-001", [])).resolves.toBeUndefined();
    // Empty array is a no-op — inner adapter should not be called
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_EDGE_TYPE for invalid edge_type in array", async () => {
    await expect(
      adapter.removeEdges("WI-001", [INVALID_EDGE_TYPE as unknown as EdgeType])
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid input to inner adapter", async () => {
    await adapter.removeEdges("WI-001", [VALID_EDGE_TYPE]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "removeEdges",
      args: ["WI-001", [VALID_EDGE_TYPE]],
    });
  });
});

// ---------------------------------------------------------------------------
// getEdges
// ---------------------------------------------------------------------------

describe("getEdges", () => {
  it("throws INVALID_NODE_ID for empty id", async () => {
    await expect(adapter.getEdges("", "outgoing")).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_DIRECTION for invalid direction", async () => {
    await expect(
      adapter.getEdges("WI-001", "sideways" as "outgoing" | "incoming" | "both")
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_DIRECTION");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid input with direction=outgoing", async () => {
    await adapter.getEdges("WI-001", "outgoing");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "getEdges",
      args: ["WI-001", "outgoing"],
    });
  });

  it("passes through valid input with direction=incoming", async () => {
    await adapter.getEdges("WI-001", "incoming");
    expect(mock.calls[0]).toEqual({
      method: "getEdges",
      args: ["WI-001", "incoming"],
    });
  });

  it("passes through valid input with direction=both", async () => {
    await adapter.getEdges("WI-001", "both");
    expect(mock.calls[0]).toEqual({
      method: "getEdges",
      args: ["WI-001", "both"],
    });
  });
});

// ---------------------------------------------------------------------------
// traverse
// ---------------------------------------------------------------------------

describe("traverse", () => {
  const validOptions: TraversalOptions = {
    seed_ids: ["WI-001"],
    alpha: 0.5,
    token_budget: 1000,
  };

  it("throws INVALID_SEED_IDS for non-array seed_ids", async () => {
    await expect(
      adapter.traverse({ seed_ids: "not-an-array" as any })
    ).rejects.toMatchObject({ code: "INVALID_SEED_IDS" });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws EMPTY_SEED_IDS for empty seed_ids array", async () => {
    await expect(
      adapter.traverse({ ...validOptions, seed_ids: [] })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "EMPTY_SEED_IDS");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_SEED_ID for seed_ids containing empty string", async () => {
    await expect(
      adapter.traverse({ ...validOptions, seed_ids: ["WI-001", ""] })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_SEED_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_ALPHA for alpha < 0", async () => {
    await expect(
      adapter.traverse({ ...validOptions, alpha: -0.1 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_ALPHA");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_ALPHA for alpha > 1", async () => {
    await expect(
      adapter.traverse({ ...validOptions, alpha: 1.1 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_ALPHA");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_ALPHA for NaN alpha", async () => {
    await expect(
      adapter.traverse({ ...validOptions, alpha: NaN })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_ALPHA");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_ALPHA for Infinity alpha", async () => {
    await expect(
      adapter.traverse({ ...validOptions, alpha: Infinity })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_ALPHA");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_TOKEN_BUDGET for negative token_budget", async () => {
    await expect(
      adapter.traverse({ ...validOptions, token_budget: -1 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_TOKEN_BUDGET");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through zero token_budget to inner adapter (non-negative is valid)", async () => {
    // token_budget: 0 is valid (non-negative), should pass through to inner adapter
    await expect(adapter.traverse({ ...validOptions, token_budget: 0 })).resolves.toBeDefined();
  });

  it("throws INVALID_CONVERGENCE_THRESHOLD for zero convergence_threshold", async () => {
    await expect(
      adapter.traverse({ ...validOptions, convergence_threshold: 0 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CONVERGENCE_THRESHOLD");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_CONVERGENCE_THRESHOLD for negative convergence_threshold", async () => {
    await expect(
      adapter.traverse({ ...validOptions, convergence_threshold: -1 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CONVERGENCE_THRESHOLD");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_CONVERGENCE_THRESHOLD for NaN convergence_threshold", async () => {
    await expect(
      adapter.traverse({ ...validOptions, convergence_threshold: NaN })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CONVERGENCE_THRESHOLD");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_CONVERGENCE_THRESHOLD for Infinity convergence_threshold", async () => {
    await expect(
      adapter.traverse({ ...validOptions, convergence_threshold: Infinity })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CONVERGENCE_THRESHOLD");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid convergence_threshold to inner adapter", async () => {
    await adapter.traverse({ ...validOptions, convergence_threshold: 0.001 });
    expect(mock.calls).toHaveLength(1);
  });

  it("throws INVALID_MAX_NODES for negative max_nodes", async () => {
    await expect(
      adapter.traverse({ ...validOptions, max_nodes: -1 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_MAX_NODES");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_MAX_NODES for non-integer max_nodes", async () => {
    await expect(
      adapter.traverse({ ...validOptions, max_nodes: 1.5 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_MAX_NODES");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through zero max_nodes to inner adapter (non-negative is valid)", async () => {
    await adapter.traverse({ ...validOptions, max_nodes: 0 });
    expect(mock.calls).toHaveLength(1);
  });

  it("throws INVALID_EDGE_WEIGHTS for non-object edge_type_weights", async () => {
    await expect(
      adapter.traverse({ ...validOptions, edge_type_weights: "bad" as any })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_WEIGHTS");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_EDGE_WEIGHTS for array edge_type_weights", async () => {
    await expect(
      adapter.traverse({ ...validOptions, edge_type_weights: [] as any })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_WEIGHTS");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_EDGE_TYPE for invalid key in edge_type_weights", async () => {
    await expect(
      adapter.traverse({ ...validOptions, edge_type_weights: { bad_key: 1.0 } })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_EDGE_WEIGHT for negative value in edge_type_weights", async () => {
    await expect(
      adapter.traverse({ ...validOptions, edge_type_weights: { [VALID_EDGE_TYPE]: -1 } })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_WEIGHT");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_EDGE_WEIGHT for NaN value in edge_type_weights", async () => {
    await expect(
      adapter.traverse({ ...validOptions, edge_type_weights: { [VALID_EDGE_TYPE]: NaN } })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_WEIGHT");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_EDGE_WEIGHT for Infinity value in edge_type_weights", async () => {
    await expect(
      adapter.traverse({ ...validOptions, edge_type_weights: { [VALID_EDGE_TYPE]: Infinity } })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_WEIGHT");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid edge_type_weights to inner adapter", async () => {
    await adapter.traverse({ ...validOptions, edge_type_weights: { [VALID_EDGE_TYPE]: 0.5 } });
    expect(mock.calls).toHaveLength(1);
  });

  it("passes through empty edge_type_weights to inner adapter", async () => {
    await adapter.traverse({ ...validOptions, edge_type_weights: {} });
    expect(mock.calls).toHaveLength(1);
  });

  it("throws INVALID_MAX_ITERATIONS for zero max_iterations", async () => {
    await expect(
      adapter.traverse({ ...validOptions, max_iterations: 0 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_MAX_ITERATIONS");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_MAX_ITERATIONS for negative max_iterations", async () => {
    await expect(
      adapter.traverse({ ...validOptions, max_iterations: -1 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_MAX_ITERATIONS");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_NODE_TYPE for invalid type in always_include_types", async () => {
    await expect(
      adapter.traverse({
        ...validOptions,
        always_include_types: [INVALID_NODE_TYPE as unknown as NodeType],
      })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid options to inner adapter", async () => {
    const result = await adapter.traverse(validOptions);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "traverse", args: [validOptions] });
    expect(result.ranked_nodes).toEqual([]);
  });

  it("passes through valid options with always_include_types using ALL_NODE_TYPES values", async () => {
    // Use boundary values from ALL_NODE_TYPES — avoid hardcoding type counts (P-75)
    const alwaysInclude: NodeType[] = [ALL_NODE_TYPES[0], ALL_NODE_TYPES[1]];
    await adapter.traverse({ ...validOptions, always_include_types: alwaysInclude });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].method).toBe("traverse");
  });

  it("rejects alpha=0 (exclusive lower bound)", async () => {
    await expect(
      adapter.traverse({ ...validOptions, alpha: 0 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_ALPHA");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("accepts alpha=1 (boundary)", async () => {
    await adapter.traverse({ ...validOptions, alpha: 1 });
    expect(mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// queryNodes
// ---------------------------------------------------------------------------

describe("queryNodes", () => {
  const validFilter: NodeFilter = { type: VALID_NODE_TYPE };

  it("throws INVALID_LIMIT for negative limit", async () => {
    await expect(adapter.queryNodes(validFilter, -1, 0)).rejects.toSatisfy(
      (e) => {
        assertValidationError(e, "INVALID_LIMIT");
        return true;
      }
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_OFFSET for negative offset", async () => {
    await expect(adapter.queryNodes(validFilter, 10, -1)).rejects.toSatisfy(
      (e) => {
        assertValidationError(e, "INVALID_OFFSET");
        return true;
      }
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid input to inner adapter", async () => {
    await adapter.queryNodes(validFilter, 10, 0);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "queryNodes",
      args: [validFilter, 10, 0],
    });
  });

  it("accepts zero limit and zero offset (boundaries)", async () => {
    await adapter.queryNodes(validFilter, 0, 0);
    expect(mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// queryGraph
// ---------------------------------------------------------------------------

describe("queryGraph", () => {
  const validQuery: GraphQuery = { origin_id: "WI-001" };

  it("throws INVALID_LIMIT for negative limit", async () => {
    await expect(adapter.queryGraph(validQuery, -1, 0)).rejects.toSatisfy(
      (e) => {
        assertValidationError(e, "INVALID_LIMIT");
        return true;
      }
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_OFFSET for negative offset", async () => {
    await expect(adapter.queryGraph(validQuery, 10, -1)).rejects.toSatisfy(
      (e) => {
        assertValidationError(e, "INVALID_OFFSET");
        return true;
      }
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_NODE_ID for empty origin_id", async () => {
    await expect(adapter.queryGraph({ origin_id: "" }, 10, 0)).rejects.toSatisfy(
      (e) => {
        assertValidationError(e, "INVALID_NODE_ID");
        return true;
      }
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_DIRECTION for invalid direction", async () => {
    await expect(
      adapter.queryGraph(
        { ...validQuery, direction: "diagonal" as "outgoing" | "incoming" | "both" },
        10,
        0
      )
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_DIRECTION");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_EDGE_TYPE for invalid edge_types", async () => {
    await expect(
      adapter.queryGraph(
        {
          ...validQuery,
          edge_types: [INVALID_EDGE_TYPE as unknown as EdgeType],
        },
        10,
        0
      )
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_DEPTH for zero depth", async () => {
    await expect(
      adapter.queryGraph({ ...validQuery, depth: 0 }, 10, 0)
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_DEPTH");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_DEPTH for negative depth", async () => {
    await expect(
      adapter.queryGraph({ ...validQuery, depth: -1 }, 10, 0)
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_DEPTH");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid query to inner adapter", async () => {
    await adapter.queryGraph(validQuery, 10, 0);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "queryGraph",
      args: [validQuery, 10, 0],
    });
  });

  it("passes through valid query with direction and edge_types", async () => {
    const query: GraphQuery = {
      ...validQuery,
      direction: "outgoing",
      edge_types: [VALID_EDGE_TYPE],
    };
    await adapter.queryGraph(query, 5, 0);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "queryGraph",
      args: [query, 5, 0],
    });
  });
});

// ---------------------------------------------------------------------------
// nextId
// ---------------------------------------------------------------------------

describe("nextId", () => {
  it("throws INVALID_NODE_TYPE for invalid type", async () => {
    await expect(
      adapter.nextId(INVALID_NODE_TYPE as unknown as NodeType)
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid type to inner adapter", async () => {
    const result = await adapter.nextId(VALID_NODE_TYPE);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "nextId",
      args: [VALID_NODE_TYPE, undefined],
    });
    expect(result).toBe("WI-001");
  });

  it("passes through valid cycle-scoped type with cycle to inner adapter (no cycle enforcement)", async () => {
    // nextId does NOT enforce cycle requirements — delegates to inner adapter
    await adapter.nextId(CYCLE_SCOPED_TYPE, 3);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "nextId",
      args: [CYCLE_SCOPED_TYPE, 3],
    });
  });

  it("passes through cycle-scoped type WITHOUT cycle — no MISSING_CYCLE thrown", async () => {
    // Spec: nextId does NOT enforce cycle requirements
    await expect(adapter.nextId(CYCLE_SCOPED_TYPE)).resolves.toBe("WI-001");
    expect(mock.calls).toHaveLength(1);
  });

  it("validates all entries in ALL_NODE_TYPES are accepted", async () => {
    for (const type of ALL_NODE_TYPES) {
      mock.calls.length = 0;
      await expect(adapter.nextId(type as NodeType)).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// batchMutate
// ---------------------------------------------------------------------------

describe("batchMutate", () => {
  const validNode: MutateNodeInput = {
    id: "WI-001",
    type: VALID_NODE_TYPE,
    properties: { title: "test" },
  };

  const validEdge: Edge = {
    source_id: "WI-001",
    target_id: "WI-002",
    edge_type: VALID_EDGE_TYPE,
    properties: {},
  };

  it("throws EMPTY_BATCH for empty nodes array", async () => {
    await expect(adapter.batchMutate({ nodes: [] })).rejects.toSatisfy((e) => {
      assertValidationError(e, "EMPTY_BATCH");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_NODE_ID for invalid node in batch", async () => {
    const input: BatchMutateInput = {
      nodes: [{ id: "", type: VALID_NODE_TYPE, properties: {} }],
    };
    await expect(adapter.batchMutate(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_ID");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_NODE_TYPE for invalid node type in batch", async () => {
    const input: BatchMutateInput = {
      nodes: [
        { id: "WI-001", type: INVALID_NODE_TYPE as unknown as NodeType, properties: {} },
      ],
    };
    await expect(adapter.batchMutate(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_NODE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_NODE_ID for batch node without id field", async () => {
    await expect(
      adapter.batchMutate({ nodes: [{ type: VALID_NODE_TYPE, properties: {} } as any] })
    ).rejects.toMatchObject({ code: "MISSING_NODE_ID" });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_NODE_TYPE for batch node without type field", async () => {
    await expect(
      adapter.batchMutate({ nodes: [{ id: "test-id", properties: {} } as any] })
    ).rejects.toMatchObject({ code: "MISSING_NODE_TYPE" });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_EDGE_SOURCE for invalid edge in batch", async () => {
    const input: BatchMutateInput = {
      nodes: [validNode],
      edges: [{ ...validEdge, source_id: "" }],
    };
    await expect(adapter.batchMutate(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_EDGE_SOURCE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_EDGE_TARGET for edge with empty target_id in batch", async () => {
    const input: BatchMutateInput = {
      nodes: [validNode],
      edges: [{ ...validEdge, target_id: "" }],
    };
    await expect(adapter.batchMutate(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_EDGE_TARGET");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_EDGE_TYPE for invalid edge type in batch", async () => {
    const input: BatchMutateInput = {
      nodes: [validNode],
      edges: [{ ...validEdge, edge_type: INVALID_EDGE_TYPE as unknown as EdgeType }],
    };
    await expect(adapter.batchMutate(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_EDGE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_NODE_PROPERTIES for batch node with null properties", async () => {
    const input: BatchMutateInput = {
      nodes: [{ id: "WI-001", type: VALID_NODE_TYPE, properties: null } as any],
    };
    await expect(adapter.batchMutate(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_NODE_PROPERTIES");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_CYCLE for cycle-scoped type without cycle in batch", async () => {
    const input: BatchMutateInput = {
      nodes: [{ id: "F-001", type: "finding" as NodeType, properties: { title: "test" } }],
    };
    await expect(adapter.batchMutate(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_CYCLE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_EDGE_TYPE for edge without edge_type in batch", async () => {
    const input: BatchMutateInput = {
      nodes: [validNode],
      edges: [{ source_id: "WI-001", target_id: "WI-002", edge_type: "", properties: {} } as any],
    };
    await expect(adapter.batchMutate(input)).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_EDGE_TYPE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid input to inner adapter", async () => {
    const input: BatchMutateInput = {
      nodes: [validNode],
      edges: [validEdge],
    };
    const result = await adapter.batchMutate(input);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "batchMutate", args: [input] });
    expect(result.errors).toEqual([]);
  });

  it("passes through valid batch without edges", async () => {
    const input: BatchMutateInput = { nodes: [validNode] };
    await adapter.batchMutate(input);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "batchMutate", args: [input] });
  });
});

// ---------------------------------------------------------------------------
// countNodes
// ---------------------------------------------------------------------------

describe("countNodes", () => {
  const validFilter: NodeFilter = {};

  it("throws INVALID_GROUP_BY for invalid group_by value", async () => {
    await expect(
      adapter.countNodes(validFilter, "color" as "status" | "type" | "domain" | "severity")
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_GROUP_BY");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid group_by=status", async () => {
    await adapter.countNodes(validFilter, "status");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "countNodes",
      args: [validFilter, "status"],
    });
  });

  it("passes through valid group_by=type", async () => {
    await adapter.countNodes(validFilter, "type");
    expect(mock.calls[0].args[1]).toBe("type");
  });

  it("passes through valid group_by=domain", async () => {
    await adapter.countNodes(validFilter, "domain");
    expect(mock.calls[0].args[1]).toBe("domain");
  });

  it("passes through valid group_by=severity", async () => {
    await adapter.countNodes(validFilter, "severity");
    expect(mock.calls[0].args[1]).toBe("severity");
  });
});

// ---------------------------------------------------------------------------
// appendJournalEntry
// ---------------------------------------------------------------------------

describe("appendJournalEntry", () => {
  const validArgs = {
    skill: "execute",
    date: "2026-04-13",
    entryType: "work-item-complete",
    body: "Some journal body text.",
    cycle: 3,
  };

  it("throws MISSING_JOURNAL_FIELD for empty skill", async () => {
    await expect(
      adapter.appendJournalEntry({ ...validArgs, skill: "" })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_JOURNAL_FIELD");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_JOURNAL_FIELD for empty date", async () => {
    await expect(
      adapter.appendJournalEntry({ ...validArgs, date: "" })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_JOURNAL_FIELD");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_JOURNAL_FIELD for empty entryType", async () => {
    await expect(
      adapter.appendJournalEntry({ ...validArgs, entryType: "" })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_JOURNAL_FIELD");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws MISSING_JOURNAL_FIELD for empty body", async () => {
    await expect(
      adapter.appendJournalEntry({ ...validArgs, body: "" })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "MISSING_JOURNAL_FIELD");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_CYCLE for zero cycle", async () => {
    await expect(
      adapter.appendJournalEntry({ ...validArgs, cycle: 0 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CYCLE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_CYCLE for negative cycle", async () => {
    await expect(
      adapter.appendJournalEntry({ ...validArgs, cycle: -1 })
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CYCLE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid input to inner adapter", async () => {
    const result = await adapter.appendJournalEntry(validArgs);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "appendJournalEntry",
      args: [validArgs],
    });
    expect(result).toBe("J-001-001");
  });
});

// ---------------------------------------------------------------------------
// archiveCycle
// ---------------------------------------------------------------------------

describe("archiveCycle", () => {
  it("throws INVALID_CYCLE for zero cycle", async () => {
    await expect(adapter.archiveCycle(0)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CYCLE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_CYCLE for negative cycle", async () => {
    await expect(adapter.archiveCycle(-5)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CYCLE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid cycle to inner adapter", async () => {
    const result = await adapter.archiveCycle(1);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "archiveCycle", args: [1] });
    expect(result).toBe("Archived cycle");
  });
});

// ---------------------------------------------------------------------------
// getConvergenceData
// ---------------------------------------------------------------------------

describe("getConvergenceData", () => {
  it("throws INVALID_CYCLE for zero cycle", async () => {
    await expect(adapter.getConvergenceData(0)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CYCLE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_CYCLE for negative cycle", async () => {
    await expect(adapter.getConvergenceData(-1)).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_CYCLE");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid cycle to inner adapter", async () => {
    const result = await adapter.getConvergenceData(3);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({ method: "getConvergenceData", args: [3] });
    expect(result).toEqual({
      findings_by_severity: {},
      cycle_summary_content: null,
    });
  });
});

// ---------------------------------------------------------------------------
// getDomainState
// ---------------------------------------------------------------------------

describe("getDomainState", () => {
  it("throws INVALID_DOMAIN for empty string in domains array", async () => {
    await expect(adapter.getDomainState(["workflow", ""])).rejects.toSatisfy(
      (e) => {
        assertValidationError(e, "INVALID_DOMAIN");
        return true;
      }
    );
    expect(mock.calls).toHaveLength(0);
  });

  it("throws INVALID_DOMAIN for whitespace-only string in domains array", async () => {
    await expect(adapter.getDomainState(["  "])).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_DOMAIN");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid domains array to inner adapter", async () => {
    await adapter.getDomainState(["workflow", "artifact-structure"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "getDomainState",
      args: [["workflow", "artifact-structure"]],
    });
  });

  it("passes through undefined domains to inner adapter", async () => {
    await adapter.getDomainState(undefined);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "getDomainState",
      args: [undefined],
    });
  });

  it("passes through with no argument (all domains)", async () => {
    await adapter.getDomainState();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "getDomainState",
      args: [undefined],
    });
  });
});

// ---------------------------------------------------------------------------
// indexFiles
// ---------------------------------------------------------------------------

describe("indexFiles", () => {
  it("throws INVALID_PATHS for non-array input", async () => {
    await expect(
      adapter.indexFiles("not-an-array" as unknown as string[])
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_PATHS");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid string[] to inner adapter", async () => {
    await adapter.indexFiles(["path/to/file.yaml", "path/to/other.yaml"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "indexFiles",
      args: [["path/to/file.yaml", "path/to/other.yaml"]],
    });
  });
});

// ---------------------------------------------------------------------------
// removeFiles
// ---------------------------------------------------------------------------

describe("removeFiles", () => {
  it("throws INVALID_PATHS for non-array input", async () => {
    await expect(
      adapter.removeFiles(42 as unknown as string[])
    ).rejects.toSatisfy((e) => {
      assertValidationError(e, "INVALID_PATHS");
      return true;
    });
    expect(mock.calls).toHaveLength(0);
  });

  it("passes through valid string[] to inner adapter", async () => {
    await adapter.removeFiles(["path/to/file.yaml"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "removeFiles",
      args: [["path/to/file.yaml"]],
    });
  });
});

describe("getToolUsage", () => {
  it("passes filter through to inner adapter", async () => {
    const filter = { tool_name: "ideate_query", cycle: 1 };
    await adapter.getToolUsage(filter);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "getToolUsage",
      args: [filter],
    });
  });

  it("passes undefined filter through to inner adapter", async () => {
    await adapter.getToolUsage();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "getToolUsage",
      args: [undefined],
    });
  });
});
