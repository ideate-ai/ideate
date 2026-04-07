/**
 * remote-options.test.ts — Regression tests for RemoteAdapter options propagation
 *
 * Addresses GA-003: Missing regression test for max_nodes option propagation.
 * Verifies that all adapter methods correctly pass through their options to the
 * underlying GraphQL queries.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { RemoteAdapter } from "../../adapters/remote/index.js";
import type {
  GraphQuery,
  NodeFilter,
  TraversalOptions,
  EdgeType,
  NodeType,
} from "../../adapter.js";

// Mock the GraphQL client
vi.mock("../../adapters/remote/client.js", () => {
  return {
    GraphQLClient: vi.fn().mockImplementation(() => ({
      query: vi.fn(),
      mutate: vi.fn(),
    })),
  };
});

import { GraphQLClient } from "../../adapters/remote/client.js";

describe("RemoteAdapter — options propagation", () => {
  let adapter: RemoteAdapter;
  let mockQuery: Mock;
  let mockMutate: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create fresh mock instance
    mockQuery = vi.fn();
    mockMutate = vi.fn();

    (GraphQLClient as unknown as Mock).mockImplementation(() => ({
      query: mockQuery,
      mutate: mockMutate,
    }));

    adapter = new RemoteAdapter({
      endpoint: "http://localhost:8080/graphql",
      org_id: "test-org",
      codebase_id: "test-codebase",
      auth_token: "test-token",
    });
  });

  describe("AC-1: max_nodes passed through in queryGraph", () => {
    it("passes limit as first parameter to graphQuery", async () => {
      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: [],
          totalCount: 0,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
        depth: 2,
      };

      await adapter.queryGraph(query, 25, 0);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [, variables] = mockQuery.mock.calls[0];

      // max_nodes (passed as limit) should be mapped to 'first'
      expect(variables.first).toBe(25);
    });

    it("passes limit with different values correctly", async () => {
      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: [],
          totalCount: 0,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
      };

      // Test with max_nodes = 100
      await adapter.queryGraph(query, 100, 0);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.first).toBe(100);
    });

    it("omits 'after' parameter when offset is 0", async () => {
      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: [],
          totalCount: 0,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
      };

      await adapter.queryGraph(query, 25, 0);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.after).toBeUndefined();
    });

    it("includes 'after' parameter when offset is greater than 0", async () => {
      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: [],
          totalCount: 0,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
      };

      await adapter.queryGraph(query, 25, 50);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.after).toBeDefined();
      // The offset - 1 encoded as base64
      expect(variables.after).toBe(Buffer.from("49").toString("base64"));
    });
  });

  describe("AC-2: Options mapping is complete for traverse", () => {
    it("passes max_nodes as maxNodes in traverse", async () => {
      mockQuery.mockResolvedValueOnce({
        assembleContext: {
          rankedNodes: [],
          totalTokens: 0,
          pprScores: [],
        },
      });

      const options: TraversalOptions = {
        seed_ids: ["WI-001"],
        max_nodes: 500,
      };

      await adapter.traverse(options);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [, variables] = mockQuery.mock.calls[0];

      expect(variables.input.maxNodes).toBe(500);
    });

    it("passes all traversal options correctly", async () => {
      mockQuery.mockResolvedValueOnce({
        assembleContext: {
          rankedNodes: [],
          totalTokens: 0,
          pprScores: [],
        },
      });

      const options: TraversalOptions = {
        seed_ids: ["WI-001", "WI-002"],
        alpha: 0.85,
        max_iterations: 100,
        convergence_threshold: 0.001,
        edge_type_weights: { depends_on: 1.5, blocks: 0.8 },
        token_budget: 50000,
        always_include_types: ["work_item", "finding"],
        max_nodes: 1000,
      };

      await adapter.traverse(options);

      const [, variables] = mockQuery.mock.calls[0];
      const input = variables.input;

      expect(input.seedIds).toEqual(["WI-001", "WI-002"]);
      expect(input.alpha).toBe(0.85);
      expect(input.maxIterations).toBe(100);
      expect(input.convergenceThreshold).toBe(0.001);
      expect(input.edgeTypeWeights).toEqual({ DEPENDS_ON: 1.5, BLOCKS: 0.8 });
      expect(input.tokenBudget).toBe(50000);
      expect(input.alwaysIncludeTypes).toEqual(["WORK_ITEM", "FINDING"]);
      expect(input.maxNodes).toBe(1000);
    });

    it("omits undefined traversal options from the input", async () => {
      mockQuery.mockResolvedValueOnce({
        assembleContext: {
          rankedNodes: [],
          totalTokens: 0,
          pprScores: [],
        },
      });

      const options: TraversalOptions = {
        seed_ids: ["WI-001"],
        // Only seed_ids provided, everything else is undefined
      };

      await adapter.traverse(options);

      const [, variables] = mockQuery.mock.calls[0];
      const input = variables.input;

      // Should only have seedIds
      expect(Object.keys(input)).toEqual(["seedIds"]);
      expect(input.maxNodes).toBeUndefined();
      expect(input.alpha).toBeUndefined();
    });
  });

  describe("AC-3: Options mapping is complete for queryNodes", () => {
    it("passes limit and offset correctly to artifactQuery", async () => {
      mockQuery.mockResolvedValueOnce({
        artifactQuery: {
          edges: [],
          pageInfo: {
            totalCount: 0,
          },
        },
      });

      const filter: NodeFilter = {
        type: "work_item",
        status: "pending",
      };

      await adapter.queryNodes(filter, 30, 10);

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [, variables] = mockQuery.mock.calls[0];

      expect(variables.first).toBe(30);
      expect(variables.offset).toBe(10);
    });

    it("omits offset when it is 0", async () => {
      mockQuery.mockResolvedValueOnce({
        artifactQuery: {
          edges: [],
          pageInfo: {
            totalCount: 0,
          },
        },
      });

      const filter: NodeFilter = {
        type: "work_item",
      };

      await adapter.queryNodes(filter, 50, 0);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.offset).toBeUndefined();
    });

    it("D-134: adds statusNotIn filter for work_item queries without explicit status", async () => {
      mockQuery.mockResolvedValueOnce({
        artifactQuery: {
          edges: [],
          pageInfo: {
            totalCount: 0,
          },
        },
      });

      const filter: NodeFilter = {
        type: "work_item",
      };

      await adapter.queryNodes(filter, 50, 0);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.filter.statusNotIn).toEqual(["DONE", "OBSOLETE"]);
    });

    it("D-134: adds statusNotIn filter for cross-type queries without explicit status", async () => {
      mockQuery.mockResolvedValueOnce({
        artifactQuery: {
          edges: [],
          pageInfo: {
            totalCount: 0,
          },
        },
      });

      const filter: NodeFilter = {
        domain: "test-domain",
      };

      await adapter.queryNodes(filter, 50, 0);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.filter.statusNotIn).toEqual(["DONE", "OBSOLETE"]);
    });

    it("D-134: omits statusNotIn filter when explicit status is provided", async () => {
      mockQuery.mockResolvedValueOnce({
        artifactQuery: {
          edges: [],
          pageInfo: {
            totalCount: 0,
          },
        },
      });

      const filter: NodeFilter = {
        type: "work_item",
        status: "done",
      };

      await adapter.queryNodes(filter, 50, 0);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.filter.statusNotIn).toBeUndefined();
      expect(variables.filter.status).toBe("done");
    });

    it("D-134: omits statusNotIn filter for non-work_item types without status", async () => {
      mockQuery.mockResolvedValueOnce({
        artifactQuery: {
          edges: [],
          pageInfo: {
            totalCount: 0,
          },
        },
      });

      const filter: NodeFilter = {
        type: "guiding_principle",
      };

      await adapter.queryNodes(filter, 50, 0);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.filter.statusNotIn).toBeUndefined();
    });
  });

  describe("AC-4: GraphQuery options are fully mapped", () => {
    it("maps all GraphQuery fields to GraphQL input correctly", async () => {
      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: [],
          totalCount: 0,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
        depth: 3,
        direction: "outgoing",
        edge_types: ["depends_on", "blocks"] as EdgeType[],
        type_filter: "work_item" as NodeType,
        filters: {
          status: "pending",
          domain: "test-domain",
        },
      };

      await adapter.queryGraph(query, 20, 0);

      const [, variables] = mockQuery.mock.calls[0];
      const gqlQuery = variables.query;

      expect(gqlQuery.originId).toBe("WI-001");
      expect(gqlQuery.depth).toBe(3);
      expect(gqlQuery.direction).toBe("OUTGOING");
      expect(gqlQuery.edgeTypes).toEqual(["DEPENDS_ON", "BLOCKS"]);
      expect(gqlQuery.typeFilter).toBe("WORK_ITEM");
      expect(gqlQuery.filters).toEqual({
        status: "pending",
        domain: "test-domain",
      });
    });

    it("only includes defined GraphQuery fields", async () => {
      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: [],
          totalCount: 0,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
        // Only origin_id is provided
      };

      await adapter.queryGraph(query, 20, 0);

      const [, variables] = mockQuery.mock.calls[0];
      const gqlQuery = variables.query;

      expect(Object.keys(gqlQuery)).toEqual(["originId"]);
      expect(gqlQuery.depth).toBeUndefined();
      expect(gqlQuery.direction).toBeUndefined();
    });
  });

  describe("AC-5: Edge type and direction case conversion", () => {
    it("converts edge_types to UPPER_SNAKE_CASE", async () => {
      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: [],
          totalCount: 0,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
        edge_types: ["depends_on", "belongs_to_module"] as EdgeType[],
      };

      await adapter.queryGraph(query, 20, 0);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.query.edgeTypes).toEqual([
        "DEPENDS_ON",
        "BELONGS_TO_MODULE",
      ]);
    });

    it("converts direction to UPPER_CASE", async () => {
      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: [],
          totalCount: 0,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
        direction: "both",
      };

      await adapter.queryGraph(query, 20, 0);

      const [, variables] = mockQuery.mock.calls[0];
      expect(variables.query.direction).toBe("BOTH");
    });
  });

  describe("AC-6: max_nodes boundary conditions in traverse", () => {
    it("returns nodes when count is at exactly max_nodes limit", async () => {
      // Server returns exactly max_nodes (500) nodes - should be accepted
      const nodesAtLimit = Array.from({ length: 500 }, (_, i) => ({
        node: {
          artifactId: `WI-${String(i + 1).padStart(3, "0")}`,
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: `hash${i}`,
          tokenCount: 100,
        },
        score: 1.0 - i * 0.001,
        content: `{"title": "Work item ${i + 1}"}`,
      }));

      mockQuery.mockResolvedValueOnce({
        assembleContext: {
          rankedNodes: nodesAtLimit,
          totalTokens: 50000,
          pprScores: nodesAtLimit.map((n) => ({ id: n.node.artifactId, score: n.score })),
        },
      });

      const options: TraversalOptions = {
        seed_ids: ["WI-001"],
        max_nodes: 500,
      };

      const result = await adapter.traverse(options);

      // When at exactly max_nodes, results should be returned
      expect(result.ranked_nodes.length).toBe(500);
      expect(result.total_tokens).toBe(50000);
    });

    it("returns empty result when server exceeds max_nodes limit", async () => {
      // Server would return more than max_nodes - simulates server-side enforcement
      mockQuery.mockResolvedValueOnce({
        assembleContext: {
          rankedNodes: [], // Server returns empty when limit exceeded
          totalTokens: 0,
          pprScores: [],
        },
      });

      const options: TraversalOptions = {
        seed_ids: ["WI-001"],
        max_nodes: 100,
      };

      const result = await adapter.traverse(options);

      // When max_nodes is exceeded, server returns empty result
      expect(result.ranked_nodes).toEqual([]);
      expect(result.total_tokens).toBe(0);
      expect(result.ppr_scores).toEqual([]);
    });

    it("handles max_nodes = 1 (minimum boundary)", async () => {
      const singleNode = [{
        node: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
        },
        score: 1.0,
        content: '{"title": "Single item"}',
      }];

      mockQuery.mockResolvedValueOnce({
        assembleContext: {
          rankedNodes: singleNode,
          totalTokens: 100,
          pprScores: [{ id: "WI-001", score: 1.0 }],
        },
      });

      const options: TraversalOptions = {
        seed_ids: ["WI-001"],
        max_nodes: 1,
      };

      const result = await adapter.traverse(options);

      expect(result.ranked_nodes.length).toBe(1);
      expect(result.ranked_nodes[0].node.id).toBe("WI-001");
    });

    it("handles large max_nodes values", async () => {
      const manyNodes = Array.from({ length: 1000 }, (_, i) => ({
        node: {
          artifactId: `WI-${String(i + 1).padStart(3, "0")}`,
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: `hash${i}`,
          tokenCount: 100,
        },
        score: 1.0 - i * 0.0001,
        content: `{"title": "Work item ${i + 1}"}`,
      }));

      mockQuery.mockResolvedValueOnce({
        assembleContext: {
          rankedNodes: manyNodes,
          totalTokens: 100000,
          pprScores: manyNodes.map((n) => ({ id: n.node.artifactId, score: n.score })),
        },
      });

      const options: TraversalOptions = {
        seed_ids: ["WI-001"],
        max_nodes: 10000, // Large limit
      };

      const result = await adapter.traverse(options);

      expect(result.ranked_nodes.length).toBe(1000);
      expect(result.total_tokens).toBe(100000);
    });
  });

  describe("AC-7: max_nodes boundary conditions in queryGraph", () => {
    it("returns nodes when count is at exactly the limit", async () => {
      const nodesAtLimit = Array.from({ length: 50 }, (_, i) => ({
        node: {
          artifactId: `WI-${String(i + 1).padStart(3, "0")}`,
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: `hash${i}`,
          tokenCount: 100,
        },
        summary: `Work item ${i + 1}`,
        edgeType: null,
        direction: null,
        depth: null,
      }));

      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: nodesAtLimit,
          totalCount: 50,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
        depth: 2,
      };

      const result = await adapter.queryGraph(query, 50, 0);

      // Should return all 50 nodes
      expect(result.nodes.length).toBe(50);
      expect(result.total_count).toBe(50);
    });

    it("respects limit parameter as max_nodes boundary", async () => {
      // Server returns only up to 'first' (limit) nodes
      const limitedNodes = Array.from({ length: 25 }, (_, i) => ({
        node: {
          artifactId: `WI-${String(i + 1).padStart(3, "0")}`,
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: `hash${i}`,
          tokenCount: 100,
        },
        summary: `Work item ${i + 1}`,
        edgeType: "DEPENDS_ON",
        direction: "OUTGOING",
        depth: 1,
      }));

      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: limitedNodes,
          totalCount: 100, // Total available is more
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
        depth: 2,
      };

      // Request only 25 nodes (limit acts as max_nodes)
      const result = await adapter.queryGraph(query, 25, 0);

      expect(result.nodes.length).toBe(25);
      expect(result.total_count).toBe(100); // Total available
    });

    it("handles limit = 1 (minimum boundary)", async () => {
      const singleNode = [{
        node: {
          artifactId: "WI-001",
          type: "WORK_ITEM",
          status: "PENDING",
          cycleCreated: 1,
          cycleModified: null,
          contentHash: "abc123",
          tokenCount: 100,
        },
        summary: "Single result",
        edgeType: null,
        direction: null,
        depth: 0,
      }];

      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: singleNode,
          totalCount: 1,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-001",
      };

      const result = await adapter.queryGraph(query, 1, 0);

      expect(result.nodes.length).toBe(1);
      expect(result.nodes[0].node.id).toBe("WI-001");
    });

    it("handles zero results within limit", async () => {
      mockQuery.mockResolvedValueOnce({
        graphQuery: {
          nodes: [],
          totalCount: 0,
        },
      });

      const query: GraphQuery = {
        origin_id: "WI-NONEXISTENT",
        depth: 1,
      };

      const result = await adapter.queryGraph(query, 100, 0);

      expect(result.nodes).toEqual([]);
      expect(result.total_count).toBe(0);
    });
  });
});
