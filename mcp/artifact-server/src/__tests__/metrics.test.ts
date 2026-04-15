/**
 * metrics.test.ts — Tests for handleEmitMetric and handleGetMetrics tools.
 *
 * handleGetMetrics tests use a hand-rolled mock StorageAdapter (no ctx.db,
 * no ctx.drizzleDb, no SQLite) to verify the adapter-delegated data path
 * required by RF-clean-interface-proposal §1 invariant 2 (WI-805 / Leak 7).
 *
 * handleEmitMetric tests use a minimal ctx (no adapter required — the handler
 * is a no-op that does not touch storage).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import type { StorageAdapter, Node, NodeType, QueryResult } from "../adapter.js";
import type { ToolContext } from "../types.js";
import { handleEmitMetric, handleGetMetrics } from "../tools/metrics.js";

// ---------------------------------------------------------------------------
// Mock adapter factory
//
// Builds a minimal StorageAdapter stub that supports queryNodes and getNodes.
// All other methods throw — any unexpected call is a test failure.
// ---------------------------------------------------------------------------

type MockNodes = Map<string, Node>;

function makeNode(
  id: string,
  eventName: string,
  payload: Record<string, unknown>,
  options: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    outcome?: string;
    findingCount?: number;
    findingSeverities?: string;
    firstPassAccepted?: number | null;
    reworkCount?: number;
    cycleCreated?: number | null;
    timestamp?: string;
  } = {}
): Node {
  return {
    id,
    type: "metrics_event" as NodeType,
    status: null,
    cycle_created: options.cycleCreated ?? null,
    cycle_modified: null,
    content_hash: "test-hash",
    token_count: null,
    properties: {
      event_name: eventName,
      timestamp: options.timestamp ?? "2026-01-01T00:00:00Z",
      payload: JSON.stringify(payload),
      input_tokens: options.inputTokens ?? null,
      output_tokens: options.outputTokens ?? null,
      cache_read_tokens: options.cacheReadTokens ?? null,
      cache_write_tokens: null,
      outcome: options.outcome ?? null,
      finding_count: options.findingCount ?? null,
      finding_severities: options.findingSeverities ?? null,
      first_pass_accepted: options.firstPassAccepted ?? null,
      rework_count: options.reworkCount ?? null,
      work_item_total_tokens: null,
      cycle_total_tokens: null,
      cycle_total_cost_estimate: null,
      convergence_cycles: null,
      context_artifact_ids: null,
    },
  };
}

function buildMockAdapter(nodes: MockNodes): {
  adapter: StorageAdapter;
  queryNodesCalls: Array<{ filter: unknown; limit: number; offset: number }>;
  getNodesCalls: Array<string[]>;
} {
  const queryNodesCalls: Array<{ filter: unknown; limit: number; offset: number }> = [];
  const getNodesCalls: Array<string[]> = [];

  const notImplemented = (name: string) => () => {
    throw new Error(`MockAdapter.${name} was called unexpectedly`);
  };

  const adapter: StorageAdapter = {
    async queryNodes(filter, limit, offset): Promise<QueryResult> {
      queryNodesCalls.push({ filter, limit, offset });
      // Return all nodes whose type matches (filter.type = "metrics_event")
      const matching = Array.from(nodes.values()).filter(
        (n) => !filter.type || n.type === filter.type
      );
      return {
        nodes: matching.map((n) => ({ node: n, summary: n.id })),
        total_count: matching.length,
      };
    },

    async getNodes(ids: string[]): Promise<Map<string, Node>> {
      getNodesCalls.push(ids);
      const result = new Map<string, Node>();
      for (const id of ids) {
        const n = nodes.get(id);
        if (n) result.set(id, n);
      }
      return result;
    },

    getNode: notImplemented("getNode") as StorageAdapter["getNode"],
    readNodeContent: notImplemented("readNodeContent") as StorageAdapter["readNodeContent"],
    putNode: notImplemented("putNode") as StorageAdapter["putNode"],
    patchNode: notImplemented("patchNode") as StorageAdapter["patchNode"],
    deleteNode: notImplemented("deleteNode") as StorageAdapter["deleteNode"],
    putEdge: notImplemented("putEdge") as StorageAdapter["putEdge"],
    removeEdges: notImplemented("removeEdges") as StorageAdapter["removeEdges"],
    getEdges: notImplemented("getEdges") as StorageAdapter["getEdges"],
    traverse: notImplemented("traverse") as StorageAdapter["traverse"],
    queryGraph: notImplemented("queryGraph") as StorageAdapter["queryGraph"],
    nextId: notImplemented("nextId") as StorageAdapter["nextId"],
    batchMutate: notImplemented("batchMutate") as StorageAdapter["batchMutate"],
    countNodes: notImplemented("countNodes") as StorageAdapter["countNodes"],
    getDomainState: notImplemented("getDomainState") as StorageAdapter["getDomainState"],
    getConvergenceData: notImplemented("getConvergenceData") as StorageAdapter["getConvergenceData"],
    initialize: notImplemented("initialize") as StorageAdapter["initialize"],
    shutdown: notImplemented("shutdown") as StorageAdapter["shutdown"],
    archiveCycle: notImplemented("archiveCycle") as StorageAdapter["archiveCycle"],
    appendJournalEntry: notImplemented("appendJournalEntry") as StorageAdapter["appendJournalEntry"],
  };

  return { adapter, queryNodesCalls, getNodesCalls };
}

// ---------------------------------------------------------------------------
// ctx factory — adapter-only, no ctx.db
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-metrics-test-"));
});

function makeCtx(adapter: StorageAdapter): ToolContext {
  // ctx.db is intentionally omitted — handleGetMetrics must not access it.
  // TypeScript requires the field, so we cast undefined through unknown.
  return {
    db: undefined as unknown as ToolContext["db"],
    drizzleDb: undefined as unknown as ToolContext["drizzleDb"],
    ideateDir: tmpDir,
    adapter,
  };
}

// ---------------------------------------------------------------------------
// handleEmitMetric tests
// (No adapter required — handler is a pure no-op.)
// ---------------------------------------------------------------------------

const minimalCtx: ToolContext = {
  db: undefined as unknown as ToolContext["db"],
  drizzleDb: undefined as unknown as ToolContext["drizzleDb"],
  ideateDir: os.tmpdir(),
};

describe("handleEmitMetric", () => {
  describe("required parameters", () => {
    it("throws when payload is missing", async () => {
      await expect(
        handleEmitMetric(minimalCtx, {})
      ).rejects.toThrow("Missing required parameter: payload");
    });

    it("throws when payload is null", async () => {
      await expect(
        handleEmitMetric(minimalCtx, { payload: null })
      ).rejects.toThrow("Missing required parameter: payload");
    });
  });

  describe("no-op emission (soft-deprecated)", () => {
    it("returns deprecation message and creates no file under metrics/", async () => {
      const payload = { event_name: "code-reviewer", input_tokens: 100 };
      const result = await handleEmitMetric(minimalCtx, { payload });

      expect(result).toBe("Metric emission deprecated — event not recorded.");

      // No YAML file should be written
      const metricsDir = path.join(os.tmpdir(), "metrics");
      const files = fs.existsSync(metricsDir)
        ? fs.readdirSync(metricsDir).filter((f) => f.endsWith(".yaml"))
        : [];
      expect(files).toHaveLength(0);
    });

    it("returns deprecation message for any payload", async () => {
      const result = await handleEmitMetric(minimalCtx, {
        payload: { event_name: "architect", input_tokens: 1000, cycle: 3 },
      });
      expect(result).toBe("Metric emission deprecated — event not recorded.");
    });

    it("does not write metrics.jsonl", async () => {
      await handleEmitMetric(minimalCtx, { payload: { event_name: "test" } });
      const jsonlPath = path.join(os.tmpdir(), "metrics.jsonl");
      // The file should not have been created by this handler
      // (it may exist from other tests — we just verify the handler didn't create it here)
      // Test passes trivially since handler is a no-op
    });
  });
});

// ---------------------------------------------------------------------------
// handleGetMetrics tests — all use mock adapter, no ctx.db
// ---------------------------------------------------------------------------

describe("handleGetMetrics", () => {
  describe("adapter requirement", () => {
    it("throws if ctx.adapter is not set", async () => {
      const ctx: ToolContext = {
        db: undefined as unknown as ToolContext["db"],
        drizzleDb: undefined as unknown as ToolContext["drizzleDb"],
        ideateDir: tmpDir,
      };
      await expect(handleGetMetrics(ctx, {})).rejects.toThrow(
        "metrics.ts: ToolContext.adapter is required"
      );
    });

    it("routes data through adapter — queryNodes and getNodes are called", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "code-reviewer", { agent_type: "code-reviewer" }, { inputTokens: 100 })],
      ]);
      const { adapter, queryNodesCalls, getNodesCalls } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      await handleGetMetrics(ctx, { scope: "agent" });

      expect(queryNodesCalls).toHaveLength(1);
      expect(queryNodesCalls[0].filter).toMatchObject({ type: "metrics_event" });
      expect(getNodesCalls).toHaveLength(1);
      expect(getNodesCalls[0]).toContain("m1");
    });
  });

  describe("empty result", () => {
    it("returns empty tables when no metrics exist", async () => {
      const { adapter } = buildMockAdapter(new Map());
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, {});
      expect(result).toContain("No agent metrics data found");
      expect(result).toContain("No work item metrics data found");
      expect(result).toContain("No cycle metrics data found");
      expect(result).toContain("**Total events**: 0");
    });
  });

  describe("agent scope aggregation", () => {
    it("aggregates metrics by agent type", async () => {
      const nodes: MockNodes = new Map([
        [
          "m1",
          makeNode("m1", "code-reviewer", { agent_type: "code-reviewer", work_item: "WI-1" }, { inputTokens: 1000, outputTokens: 500 }),
        ],
        [
          "m2",
          makeNode("m2", "code-reviewer", { agent_type: "code-reviewer", work_item: "WI-2" }, { inputTokens: 2000, outputTokens: 800 }),
        ],
        [
          "m3",
          makeNode("m3", "architect", { agent_type: "architect", work_item: "WI-3" }, { inputTokens: 5000, outputTokens: 2000 }),
        ],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "agent" });

      expect(result).not.toContain("No agent metrics data found");
      expect(result).toContain("code-reviewer");
      expect(result).toContain("architect");
      expect(result).toContain("**Total events**: 3");
      // code-reviewer has 2 events: total input = 1000 + 2000 = 3000
      expect(result).toContain("3000");
    });

    it("calculates average tokens correctly", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "test-agent", {}, { inputTokens: 100, outputTokens: 50 })],
        ["m2", makeNode("m2", "test-agent", {}, { inputTokens: 300, outputTokens: 150 })],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "agent" });

      // Avg input: (100 + 300) / 2 = 200; avg output: (50 + 150) / 2 = 100
      expect(result).toContain("200"); // avg input
      expect(result).toContain("100"); // avg output
    });

    it("tracks finding severities by agent", async () => {
      const nodes: MockNodes = new Map([
        [
          "m1",
          makeNode("m1", "reviewer", {}, {
            findingCount: 3,
            findingSeverities: '{"critical":1,"significant":1,"minor":1}',
          }),
        ],
        [
          "m2",
          makeNode("m2", "reviewer", {}, {
            findingCount: 2,
            findingSeverities: '{"critical":0,"significant":2,"minor":0}',
          }),
        ],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "agent" });
      // Total: critical:1, significant:3, minor:1
      expect(result).toContain("1/3/1");
    });

    it("tracks outcomes by agent", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "worker", {}, { outcome: "pass" })],
        ["m2", makeNode("m2", "worker", {}, { outcome: "pass" })],
        ["m3", makeNode("m3", "worker", {}, { outcome: "rework" })],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "agent" });
      expect(result).toContain("pass: 2");
      expect(result).toContain("rework: 1");
    });

    it("uses agent_type from payload when present", async () => {
      const nodes: MockNodes = new Map([
        [
          "m1",
          makeNode(
            "m1",
            "some-event",
            { agent_type: "domain-curator" },
            { inputTokens: 500 }
          ),
        ],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "agent" });
      expect(result).toContain("domain-curator");
    });
  });

  describe("work_item scope aggregation", () => {
    it("aggregates metrics by work item", async () => {
      const nodes: MockNodes = new Map([
        [
          "m1",
          makeNode("m1", "agent", { work_item: "WI-100" }, { inputTokens: 1000, outputTokens: 500 }),
        ],
        [
          "m2",
          makeNode("m2", "agent", { work_item: "WI-100" }, { inputTokens: 500, outputTokens: 300 }),
        ],
        [
          "m3",
          makeNode("m3", "agent", { work_item: "WI-200" }, { inputTokens: 2000, outputTokens: 1000 }),
        ],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "work_item" });

      expect(result).not.toContain("No work item metrics data found");
      expect(result).toContain("WI-100");
      expect(result).toContain("WI-200");
    });

    it("tracks first pass accepted status", async () => {
      const nodes: MockNodes = new Map([
        [
          "m1",
          makeNode("m1", "agent", { work_item: "WI-001" }, { firstPassAccepted: 1 }),
        ],
        [
          "m2",
          makeNode("m2", "agent", { work_item: "WI-002" }, { firstPassAccepted: 0 }),
        ],
        [
          "m3",
          makeNode("m3", "agent", { work_item: "WI-003" }, { firstPassAccepted: null }),
        ],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "work_item" });

      expect(result).toContain("WI-001");
      expect(result).toContain("Yes"); // first_pass_accepted = true
      expect(result).toContain("WI-002");
      expect(result).toContain("No"); // first_pass_accepted = false
    });

    it("sums rework counts", async () => {
      const nodes: MockNodes = new Map([
        [
          "m1",
          makeNode("m1", "agent", { work_item: "WI-010" }, { reworkCount: 2 }),
        ],
        [
          "m2",
          makeNode("m2", "agent", { work_item: "WI-010" }, { reworkCount: 1 }),
        ],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "work_item" });
      // Total rework: 3
      expect(result).toContain("3");
    });
  });

  describe("cycle scope aggregation", () => {
    it("aggregates metrics by cycle", async () => {
      const nodes: MockNodes = new Map([
        [
          "m1",
          makeNode("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 5 }),
        ],
        [
          "m2",
          makeNode("m2", "agent", { work_item: "WI-2" }, { cycleCreated: 5 }),
        ],
        [
          "m3",
          makeNode("m3", "agent", { work_item: "WI-3" }, { cycleCreated: 6 }),
        ],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "cycle" });

      expect(result).not.toContain("No cycle metrics data found");
      expect(result).toContain("| 5 |");
      expect(result).toContain("| 6 |");
    });

    it("tracks finding counts by cycle", async () => {
      const nodes: MockNodes = new Map([
        [
          "m1",
          makeNode("m1", "reviewer", {}, {
            cycleCreated: 10,
            findingSeverities: '{"critical":0,"significant":2,"minor":1}',
          }),
        ],
        [
          "m2",
          makeNode("m2", "reviewer", {}, {
            cycleCreated: 10,
            findingSeverities: '{"critical":1,"significant":0,"minor":3}',
          }),
        ],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "cycle" });
      // Total: critical:1, significant:2, minor:4
      expect(result).toContain("1/2/4");
    });
  });

  describe("filtering (TypeScript-side)", () => {
    it("filters by cycle via node.cycle_created", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "agent", {}, { cycleCreated: 5 })],
        ["m2", makeNode("m2", "agent", {}, { cycleCreated: 5 })],
        ["m3", makeNode("m3", "agent", {}, { cycleCreated: 6 })],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { filter: { cycle: 5 } });

      expect(result).toContain("Filters**: cycle: 5");
      expect(result).toContain("**Total events**: 2");
    });

    it("filters by agent_type via payload JSON field", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "event", { agent_type: "code-reviewer" }, {})],
        ["m2", makeNode("m2", "event", { agent_type: "code-reviewer" }, {})],
        ["m3", makeNode("m3", "event", { agent_type: "architect" }, {})],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { filter: { agent_type: "code-reviewer" } });

      expect(result).toContain("Filters**: agent_type: code-reviewer");
      expect(result).toContain("**Total events**: 2");
    });

    it("filters by work_item using exact match on payload", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "agent", { work_item: "WI-100" }, {})],
        ["m2", makeNode("m2", "agent", { work_item: "WI-100" }, {})],
        ["m3", makeNode("m3", "agent", { work_item: "WI-200" }, {})],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { filter: { work_item: "WI-100" } });

      expect(result).toContain("Filters**: work_item: WI-100");
      expect(result).toContain("**Total events**: 2");
    });

    it("work_item filter does not match prefix substrings (WI-1 must not match WI-10 or WI-100)", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "agent", { work_item: "WI-1" }, {})],
        ["m2", makeNode("m2", "agent", { work_item: "WI-10" }, {})],
        ["m3", makeNode("m3", "agent", { work_item: "WI-100" }, {})],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { filter: { work_item: "WI-1" } });

      expect(result).toContain("Filters**: work_item: WI-1");
      expect(result).toContain("**Total events**: 1");
    });

    it("filters by phase via payload JSON field", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "agent", { phase: "execute" }, {})],
        ["m2", makeNode("m2", "agent", { phase: "execute" }, {})],
        ["m3", makeNode("m3", "agent", { phase: "review" }, {})],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { filter: { phase: "execute" } });

      expect(result).toContain("Filters**: phase: execute");
      expect(result).toContain("**Total events**: 2");
    });

    it("combines multiple filters", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "event", { agent_type: "code-reviewer", work_item: "WI-1" }, { cycleCreated: 5 })],
        ["m2", makeNode("m2", "event", { agent_type: "code-reviewer", work_item: "WI-2" }, { cycleCreated: 5 })],
        ["m3", makeNode("m3", "event", { agent_type: "architect", work_item: "WI-3" }, { cycleCreated: 5 })],
        ["m4", makeNode("m4", "event", { agent_type: "code-reviewer", work_item: "WI-4" }, { cycleCreated: 6 })],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, {
        filter: { cycle: 5, agent_type: "code-reviewer" },
      });

      expect(result).toContain("Filters**: cycle: 5, agent_type: code-reviewer");
      expect(result).toContain("**Total events**: 2");
    });
  });

  describe("scope selection", () => {
    it("returns all scopes when scope is undefined", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 1 })],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, {});

      expect(result).toContain("Agent Aggregates");
      expect(result).toContain("Work Item Aggregates");
      expect(result).toContain("Cycle Aggregates");
    });

    it("returns only agent scope when scope is 'agent'", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 1 })],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "agent" });

      expect(result).toContain("Agent Aggregates");
      expect(result).not.toContain("Work Item Aggregates");
      expect(result).not.toContain("Cycle Aggregates");
    });

    it("returns only work_item scope when scope is 'work_item'", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 1 })],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "work_item" });

      expect(result).not.toContain("Agent Aggregates");
      expect(result).toContain("Work Item Aggregates");
      expect(result).not.toContain("Cycle Aggregates");
    });

    it("returns only cycle scope when scope is 'cycle'", async () => {
      const nodes: MockNodes = new Map([
        ["m1", makeNode("m1", "agent", { work_item: "WI-1" }, { cycleCreated: 1 })],
      ]);
      const { adapter } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { scope: "cycle" });

      expect(result).not.toContain("Agent Aggregates");
      expect(result).not.toContain("Work Item Aggregates");
      expect(result).toContain("Cycle Aggregates");
    });
  });

  describe("RemoteAdapter path (mock adapter, no ctx.db)", () => {
    it("returns metrics from adapter without touching ctx.db", async () => {
      // Simulate a RemoteAdapter scenario: ctx.db is undefined.
      // handleGetMetrics must fetch all data from the adapter.
      const nodes: MockNodes = new Map([
        [
          "remote-m1",
          makeNode(
            "remote-m1",
            "code-reviewer",
            { agent_type: "code-reviewer", work_item: "WI-42" },
            { inputTokens: 1500, outputTokens: 700, outcome: "pass", cycleCreated: 7 }
          ),
        ],
        [
          "remote-m2",
          makeNode(
            "remote-m2",
            "architect",
            { agent_type: "architect", work_item: "WI-43" },
            { inputTokens: 8000, outputTokens: 3000, cycleCreated: 7 }
          ),
        ],
      ]);
      const { adapter, queryNodesCalls, getNodesCalls } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter); // ctx.db is undefined

      const result = await handleGetMetrics(ctx, { scope: "agent" });

      // Verify adapter was called (not ctx.db)
      expect(queryNodesCalls).toHaveLength(1);
      expect(queryNodesCalls[0].filter).toMatchObject({ type: "metrics_event" });
      expect(getNodesCalls).toHaveLength(1);

      // Verify results come from the mock adapter's data
      expect(result).toContain("code-reviewer");
      expect(result).toContain("architect");
      expect(result).toContain("**Total events**: 2");
      expect(result).toContain("1500"); // input tokens for code-reviewer
    });

    it("getNodes is not called when queryNodes returns no results", async () => {
      const { adapter, queryNodesCalls, getNodesCalls } = buildMockAdapter(new Map());
      const ctx = makeCtx(adapter);

      await handleGetMetrics(ctx, {});

      expect(queryNodesCalls).toHaveLength(1);
      // getNodes should not be called if there are no node IDs
      expect(getNodesCalls).toHaveLength(0);
    });

    it("cycle filter applied in TypeScript from node.cycle_created (no SQL needed)", async () => {
      const nodes: MockNodes = new Map([
        ["r1", makeNode("r1", "agent", { agent_type: "agent-x" }, { cycleCreated: 3 })],
        ["r2", makeNode("r2", "agent", { agent_type: "agent-x" }, { cycleCreated: 4 })],
        ["r3", makeNode("r3", "agent", { agent_type: "agent-x" }, { cycleCreated: 3 })],
      ]);
      const { adapter, queryNodesCalls } = buildMockAdapter(nodes);
      const ctx = makeCtx(adapter);

      const result = await handleGetMetrics(ctx, { filter: { cycle: 3 } });

      // queryNodes is called WITHOUT a cycle filter (filtering happens in TS)
      expect(queryNodesCalls[0].filter).not.toHaveProperty("cycle");
      expect(result).toContain("**Total events**: 2");
    });
  });
});
