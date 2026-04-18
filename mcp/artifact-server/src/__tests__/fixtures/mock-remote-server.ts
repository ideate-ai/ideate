/**
 * mock-remote-server.ts — In-process mock GraphQL server for RemoteAdapter CI tests.
 *
 * Implements the GraphQL operation surface used by RemoteAdapter (dispatched by
 * operation name, not a real GraphQL engine). Maintains an in-memory graph
 * (nodes Map + edges Array) matching the StorageAdapter contract surface.
 *
 * Usage:
 *   const server = await startMockServer();
 *   // server.url  — e.g. "http://127.0.0.1:PORT/graphql"
 *   // server.close() — stops the HTTP server and resolves when closed
 */

import http from "http";
import crypto from "crypto";

// ---------------------------------------------------------------------------
// Internal storage types
// ---------------------------------------------------------------------------

interface StoredNode {
  artifactId: string;
  type: string; // UPPER_SNAKE_CASE GraphQL enum
  status: string | null;
  cycleCreated: number | null;
  cycleModified: number | null;
  contentHash: string;
  tokenCount: number | null;
  /** Serialized JSON of properties (includes all non-meta fields). */
  content: string;
  /** The raw cycle value from putNode (for cycle-scoped types). */
  cycle?: number;
}

interface StoredEdge {
  sourceId: string;
  targetId: string;
  edgeType: string; // UPPER_SNAKE_CASE
  properties: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ID generation helpers
// ---------------------------------------------------------------------------

const TYPE_PREFIX_MAP: Record<string, { prefix: string; padWidth: number }> = {
  WORK_ITEM: { prefix: "WI-", padWidth: 3 },
  GUIDING_PRINCIPLE: { prefix: "GP-", padWidth: 2 },
  CONSTRAINT: { prefix: "C-", padWidth: 2 },
  DOMAIN_POLICY: { prefix: "P-", padWidth: 2 },
  DOMAIN_DECISION: { prefix: "D-", padWidth: 2 },
  DOMAIN_QUESTION: { prefix: "Q-", padWidth: 2 },
  PROXY_HUMAN_DECISION: { prefix: "PHD-", padWidth: 2 },
  PROJECT: { prefix: "PR-", padWidth: 3 },
  PHASE: { prefix: "PH-", padWidth: 3 },
  MODULE_SPEC: { prefix: "MS-", padWidth: 3 },
  RESEARCH_FINDING: { prefix: "RF-", padWidth: 3 },
  DOMAIN_INDEX: { prefix: "DI-", padWidth: 3 },
};

const CYCLE_SCOPED_TYPES = new Set([
  "FINDING",
  "JOURNAL_ENTRY",
  "DECISION_LOG",
  "CYCLE_SUMMARY",
  "REVIEW_MANIFEST",
  "REVIEW_OUTPUT",
  "PROXY_HUMAN_DECISION",
]);

const CYCLE_PREFIX_MAP: Record<string, { prefix: string; padWidth: number }> = {
  FINDING: { prefix: "F-", padWidth: 3 },
  JOURNAL_ENTRY: { prefix: "J-", padWidth: 3 },
  DECISION_LOG: { prefix: "DL-", padWidth: 3 },
  CYCLE_SUMMARY: { prefix: "CS-", padWidth: 3 },
  REVIEW_MANIFEST: { prefix: "RM-", padWidth: 3 },
  REVIEW_OUTPUT: { prefix: "RO-", padWidth: 3 },
};

function contentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 8);
}

// NOTE: This local estimateTokens intentionally uses Math.ceil (vs Math.floor in
// token-utils.ts) and is NOT imported from token-utils.  This is deliberate
// test-fixture isolation: the mock server is a self-contained in-process stub
// with no production-code dependencies.  Token counts returned by the mock are
// approximations used only to satisfy the RemoteAdapter contract surface in CI;
// they are never asserted against exact values in tests.
function estimateTokens(content: string): number {
  // Rough approximation: 1 token per 4 characters
  return Math.ceil(content.length / 4);
}

// ---------------------------------------------------------------------------
// In-memory graph store
// ---------------------------------------------------------------------------

class InMemoryGraph {
  nodes = new Map<string, StoredNode>();
  edges: StoredEdge[] = [];
  /** Journal entry counters per cycle: cycle -> next sequence number */
  journalCounters = new Map<number, number>();

  putNode(
    id: string,
    type: string,
    properties: Record<string, unknown>,
    cycle?: number
  ): "CREATED" | "UPDATED" {
    const existing = this.nodes.get(id);
    const content = JSON.stringify(properties);
    const hash = contentHash(content);
    const tokens = estimateTokens(content);

    // Extract status from properties if present
    const rawStatus = properties.status as string | undefined;
    const status = rawStatus ? rawStatus.toUpperCase() : null;

    if (existing) {
      // Update preserves cycleCreated; updates cycleModified
      this.nodes.set(id, {
        ...existing,
        type,
        status,
        cycleModified: cycle ?? existing.cycleModified,
        contentHash: hash,
        tokenCount: tokens,
        content,
        cycle,
      });
      return "UPDATED";
    } else {
      this.nodes.set(id, {
        artifactId: id,
        type,
        status,
        cycleCreated: cycle ?? null,
        cycleModified: cycle ?? null,
        contentHash: hash,
        tokenCount: tokens,
        content,
        cycle,
      });
      return "CREATED";
    }
  }

  patchNode(
    id: string,
    properties: Record<string, unknown>
  ): "UPDATED" | "NOT_FOUND" {
    const existing = this.nodes.get(id);
    if (!existing) return "NOT_FOUND";

    const currentProps = JSON.parse(existing.content) as Record<string, unknown>;
    const merged = { ...currentProps, ...properties };
    const content = JSON.stringify(merged);
    const hash = contentHash(content);
    const tokens = estimateTokens(content);
    const rawStatus = merged.status as string | undefined;
    const status = rawStatus ? rawStatus.toUpperCase() : existing.status;

    this.nodes.set(id, {
      ...existing,
      status,
      contentHash: hash,
      tokenCount: tokens,
      content,
    });
    return "UPDATED";
  }

  deleteNode(id: string): "DELETED" | "NOT_FOUND" {
    if (!this.nodes.has(id)) return "NOT_FOUND";
    this.nodes.delete(id);
    // Remove all edges sourced from or targeting this node
    this.edges = this.edges.filter(
      (e) => e.sourceId !== id && e.targetId !== id
    );
    return "DELETED";
  }

  putEdge(edge: StoredEdge): void {
    // Idempotent: replace if exact (source, target, type) triple exists
    const idx = this.edges.findIndex(
      (e) =>
        e.sourceId === edge.sourceId &&
        e.targetId === edge.targetId &&
        e.edgeType === edge.edgeType
    );
    if (idx >= 0) {
      this.edges[idx] = edge;
    } else {
      this.edges.push(edge);
    }
  }

  removeEdges(sourceId: string, edgeTypes: string[]): void {
    if (edgeTypes.length === 0) return;
    const typeSet = new Set(edgeTypes);
    this.edges = this.edges.filter(
      (e) => !(e.sourceId === sourceId && typeSet.has(e.edgeType))
    );
  }

  getEdges(
    id: string,
    direction: string
  ): StoredEdge[] {
    const dir = direction.toUpperCase();
    return this.edges.filter((e) => {
      if (dir === "OUTGOING") return e.sourceId === id;
      if (dir === "INCOMING") return e.targetId === id;
      return e.sourceId === id || e.targetId === id;
    });
  }

  nextId(type: string, cycle?: number): string {
    if (CYCLE_SCOPED_TYPES.has(type) && cycle !== undefined) {
      const mapping = CYCLE_PREFIX_MAP[type];
      if (mapping) {
        const paddedCycle = String(cycle).padStart(3, "0");
        const prefix = mapping.prefix + paddedCycle + "-";
        let maxNum = 0;
        for (const id of this.nodes.keys()) {
          if (id.startsWith(prefix)) {
            const rest = id.slice(prefix.length);
            const num = parseInt(rest, 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
          }
        }
        return prefix + String(maxNum + 1).padStart(mapping.padWidth, "0");
      }
    }

    const mapping = TYPE_PREFIX_MAP[type];
    if (mapping) {
      const prefix = mapping.prefix;
      let maxNum = 0;
      for (const id of this.nodes.keys()) {
        if (id.startsWith(prefix)) {
          const rest = id.slice(prefix.length);
          // Skip cycle-scoped IDs (they have another dash)
          if (!rest.includes("-")) {
            const num = parseInt(rest, 10);
            if (!isNaN(num) && num > maxNum) maxNum = num;
          }
        }
      }
      return prefix + String(maxNum + 1).padStart(mapping.padWidth, "0");
    }

    // Fallback: generic prefix
    return type.substring(0, 2).toUpperCase() + "-001";
  }

  appendJournalEntry(args: {
    skill: string;
    date: string;
    entryType: string;
    body: string;
    cycle: number;
  }): string {
    const id = this.nextId("JOURNAL_ENTRY", args.cycle);
    this.putNode(
      id,
      "JOURNAL_ENTRY",
      {
        phase: args.skill,
        title: args.entryType,
        content: args.body,
        date: args.date,
      },
      args.cycle
    );
    return id;
  }

  queryNodes(filter: Record<string, unknown>, first: number, offset: number): {
    edges: Array<{ node: StoredNode }>;
    pageInfo: { totalCount: number };
  } {
    let nodes = Array.from(this.nodes.values());

    if (filter.type) {
      nodes = nodes.filter((n) => n.type === filter.type);
    }
    if (filter.status) {
      nodes = nodes.filter(
        (n) => n.status === (filter.status as string).toUpperCase()
      );
    }
    if (filter.statusNotIn) {
      const excluded = new Set(
        (filter.statusNotIn as string[]).map((s) => s.toUpperCase())
      );
      nodes = nodes.filter((n) => !excluded.has(n.status ?? ""));
    }
    if (filter.cycle !== undefined) {
      nodes = nodes.filter((n) => n.cycle === filter.cycle);
    }
    if (filter.domain !== undefined) {
      nodes = nodes.filter((n) => {
        try {
          const props = JSON.parse(n.content) as Record<string, unknown>;
          return props.domain === filter.domain;
        } catch {
          return false;
        }
      });
    }
    if (filter.severity !== undefined) {
      nodes = nodes.filter((n) => {
        try {
          const props = JSON.parse(n.content) as Record<string, unknown>;
          return props.severity === filter.severity;
        } catch {
          return false;
        }
      });
    }
    if (filter.phase !== undefined) {
      nodes = nodes.filter((n) => {
        try {
          const props = JSON.parse(n.content) as Record<string, unknown>;
          return props.phase === filter.phase;
        } catch {
          return false;
        }
      });
    }
    if (filter.workItem !== undefined) {
      nodes = nodes.filter((n) => {
        try {
          const props = JSON.parse(n.content) as Record<string, unknown>;
          return props.work_item === filter.workItem;
        } catch {
          return false;
        }
      });
    }

    // Sort by artifactId for stable ordering
    nodes.sort((a, b) => a.artifactId.localeCompare(b.artifactId));

    const total = nodes.length;
    const sliced = nodes.slice(offset, offset + first);

    return {
      edges: sliced.map((n) => ({ node: n })),
      pageInfo: { totalCount: total },
    };
  }

  countNodes(
    filter: Record<string, unknown>,
    groupBy: string
  ): Array<{ key: string; count: number }> {
    let nodes = Array.from(this.nodes.values());

    if (filter.type) {
      nodes = nodes.filter((n) => n.type === filter.type);
    }
    if (filter.domain !== undefined) {
      nodes = nodes.filter((n) => {
        try {
          const props = JSON.parse(n.content) as Record<string, unknown>;
          return props.domain === filter.domain;
        } catch {
          return false;
        }
      });
    }
    if (filter.cycle !== undefined) {
      nodes = nodes.filter((n) => n.cycle === filter.cycle);
    }

    const counts = new Map<string, number>();

    for (const node of nodes) {
      let key: string | null = null;
      if (groupBy === "TYPE") {
        key = node.type.toLowerCase();
      } else if (groupBy === "STATUS") {
        // Skip nodes without status (they'll be counted separately)
        if (node.status !== null) {
          key = node.status;
        }
      } else if (groupBy === "DOMAIN") {
        try {
          const props = JSON.parse(node.content) as Record<string, unknown>;
          key = typeof props.domain === "string" ? props.domain : null;
        } catch {
          key = null;
        }
      } else if (groupBy === "SEVERITY") {
        try {
          const props = JSON.parse(node.content) as Record<string, unknown>;
          key = typeof props.severity === "string" ? props.severity : null;
        } catch {
          key = null;
        }
      }

      if (key !== null) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries()).map(([key, count]) => ({ key, count }));
  }

  getDomainState(
    domains?: string[]
  ): Array<{
    domain: string;
    policies: Array<{ id: string; description: string | null; status: string | null }>;
    decisions: Array<{ id: string; description: string | null; status: string | null }>;
    questions: Array<{ id: string; description: string | null; status: string | null }>;
  }> {
    const domainMap = new Map<
      string,
      {
        policies: Array<{ id: string; description: string | null; status: string | null }>;
        decisions: Array<{ id: string; description: string | null; status: string | null }>;
        questions: Array<{ id: string; description: string | null; status: string | null }>;
      }
    >();

    const ensureDomain = (d: string) => {
      if (!domainMap.has(d)) {
        domainMap.set(d, { policies: [], decisions: [], questions: [] });
      }
      return domainMap.get(d)!;
    };

    for (const node of this.nodes.values()) {
      let props: Record<string, unknown>;
      try {
        props = JSON.parse(node.content) as Record<string, unknown>;
      } catch {
        continue;
      }

      const domain = typeof props.domain === "string" ? props.domain : null;
      if (!domain) continue;
      if (domains && !domains.includes(domain)) continue;

      const id = node.artifactId;
      const description = typeof props.description === "string" ? props.description : null;
      // Status from node metadata (lowercased from storage)
      const statusRaw = node.status ? node.status.toLowerCase() : null;

      if (node.type === "DOMAIN_POLICY") {
        // Include active or null status; exclude deprecated/superseded
        if (statusRaw === "deprecated" || statusRaw === "superseded") continue;
        ensureDomain(domain).policies.push({ id, description, status: statusRaw });
      } else if (node.type === "DOMAIN_DECISION") {
        // Include all (including null status) except explicitly excluded statuses
        ensureDomain(domain).decisions.push({ id, description, status: statusRaw });
      } else if (node.type === "DOMAIN_QUESTION") {
        // Only include 'open' status questions
        if (statusRaw !== "open") continue;
        ensureDomain(domain).questions.push({ id, description, status: statusRaw });
      }
    }

    const result = Array.from(domainMap.entries()).map(([domain, state]) => ({
      domain,
      ...state,
    }));

    if (domains) {
      return result.filter((r) => domains.includes(r.domain));
    }
    return result;
  }

  queryGraph(
    query: Record<string, unknown>,
    first: number,
    offset: number
  ): { nodes: Array<{ node: StoredNode; summary: string; edgeType: string | null; direction: string | null; depth: number | null }>; totalCount: number } {
    const originId = query.originId as string;
    const depth = (query.depth as number | undefined) ?? 1;
    const direction = (query.direction as string | undefined) ?? "BOTH";

    const visited = new Set<string>();
    const result: Array<{ node: StoredNode; summary: string; edgeType: string | null; direction: string | null; depth: number | null }> = [];

    // BFS from origin. depth=1 means direct neighbors; origin itself is not included.
    const queue: Array<{ id: string; currentDepth: number; edgeType: string | null; dir: string | null }> = [
      { id: originId, currentDepth: 0, edgeType: null, dir: null },
    ];
    visited.add(originId);

    while (queue.length > 0) {
      const { id, currentDepth, edgeType, dir } = queue.shift()!;

      // Add to result (skip the origin node itself)
      if (id !== originId) {
        const node = this.nodes.get(id);
        if (node) {
          result.push({ node, summary: "", edgeType, direction: dir, depth: currentDepth });
        }
      }

      // Expand neighbors if we haven't reached max depth
      if (currentDepth < depth) {
        const edges = this.getEdges(id, direction);
        for (const edge of edges) {
          const nextId = edge.sourceId === id ? edge.targetId : edge.sourceId;
          const nextDir = edge.sourceId === id ? "OUTGOING" : "INCOMING";
          if (!visited.has(nextId)) {
            visited.add(nextId);
            queue.push({ id: nextId, currentDepth: currentDepth + 1, edgeType: edge.edgeType, dir: nextDir });
          }
        }
      }
    }

    const totalCount = result.length;
    const sliced = result.slice(offset, offset + first);
    return { nodes: sliced, totalCount };
  }

  /** Detect cycles in a depends_on edge set */
  hasCycle(
    nodes: Array<{ id: string; depends?: string[] }>
  ): boolean {
    const deps = new Map<string, string[]>();
    for (const n of nodes) {
      deps.set(n.id, n.depends ?? []);
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (id: string): boolean => {
      if (inStack.has(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      inStack.add(id);
      for (const dep of deps.get(id) ?? []) {
        if (dfs(dep)) return true;
      }
      inStack.delete(id);
      return false;
    };

    for (const id of deps.keys()) {
      if (dfs(id)) return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// GraphQL operation dispatcher
// ---------------------------------------------------------------------------

function extractOperationName(queryStr: string): string | null {
  // Match: query OperationName / mutation OperationName
  const match = /(?:query|mutation)\s+(\w+)/.exec(queryStr);
  return match ? match[1] : null;
}

function gqlOk<T>(data: T): string {
  return JSON.stringify({ data });
}

function gqlError(message: string, code: string, details: Record<string, unknown> = {}): string {
  return JSON.stringify({
    errors: [
      {
        message,
        extensions: { code, ...details },
      },
    ],
  });
}

function nodeToGql(node: StoredNode): Record<string, unknown> {
  return {
    artifactId: node.artifactId,
    type: node.type,
    status: node.status,
    cycleCreated: node.cycleCreated,
    cycleModified: node.cycleModified,
    contentHash: node.contentHash,
    tokenCount: node.tokenCount,
    content: node.content,
  };
}

function dispatch(
  graph: InMemoryGraph,
  operationName: string,
  variables: Record<string, unknown>
): string {
  switch (operationName) {
    // -------------------------------------------------------------------------
    // Lifecycle / ping
    // -------------------------------------------------------------------------
    case "Ping": {
      return gqlOk({ nextId: "WI-001" });
    }

    // -------------------------------------------------------------------------
    // Domain index (used by fetchCurrentCycle)
    // -------------------------------------------------------------------------
    case "GetDomainIndex": {
      const id = variables.codebaseId as string | undefined ?? "domain_index";
      const node = graph.nodes.get("domain_index") ?? graph.nodes.get(id);
      if (!node) {
        return gqlOk({ artifact: null });
      }
      return gqlOk({ artifact: { content: node.content } });
    }

    // -------------------------------------------------------------------------
    // Node reads
    // -------------------------------------------------------------------------
    case "GetNode": {
      const id = variables.id as string;
      const node = graph.nodes.get(id);
      if (!node) return gqlOk({ artifact: null });
      return gqlOk({ artifact: nodeToGql(node) });
    }

    case "GetNodes": {
      const ids = variables.ids as string[];
      const artifacts = ids
        .map((id) => graph.nodes.get(id))
        .filter(Boolean)
        .map((n) => nodeToGql(n!));
      return gqlOk({ artifacts });
    }

    case "ReadNodeContent": {
      const id = variables.id as string;
      const node = graph.nodes.get(id);
      if (!node) return gqlOk({ artifact: null });
      return gqlOk({ artifact: { content: node.content } });
    }

    // -------------------------------------------------------------------------
    // Node mutations
    // -------------------------------------------------------------------------
    case "PutNode": {
      const input = variables.input as {
        id: string;
        type: string;
        properties: Record<string, unknown>;
        cycle?: number;
      };
      const status = graph.putNode(input.id, input.type, input.properties, input.cycle);
      return gqlOk({ putNode: { id: input.id, status } });
    }

    case "PatchNode": {
      const input = variables.input as {
        id: string;
        properties: Record<string, unknown>;
      };

      // Reject immutable fields
      const immutableFields = ["id", "type", "cycle_created"];
      for (const field of immutableFields) {
        if (field in input.properties) {
          return gqlError(
            `Field '${field}' is immutable and cannot be patched`,
            "IMMUTABLE_FIELD",
            { field }
          );
        }
      }

      const result = graph.patchNode(input.id, input.properties);
      return gqlOk({
        patchNode: {
          id: input.id,
          status: result,
        },
      });
    }

    case "DeleteNode": {
      const id = variables.id as string;
      const status = graph.deleteNode(id);
      return gqlOk({ deleteNode: { id, status } });
    }

    // -------------------------------------------------------------------------
    // Edge mutations
    // -------------------------------------------------------------------------
    case "PutEdge": {
      const input = variables.input as {
        sourceId: string;
        targetId: string;
        edgeType: string;
        properties: Record<string, unknown>;
      };
      graph.putEdge({
        sourceId: input.sourceId,
        targetId: input.targetId,
        edgeType: input.edgeType,
        properties: input.properties ?? {},
      });
      return gqlOk({ putEdge: true });
    }

    case "RemoveEdges": {
      const sourceId = variables.sourceId as string;
      const edgeTypes = variables.edgeTypes as string[];
      graph.removeEdges(sourceId, edgeTypes);
      return gqlOk({ removeEdges: true });
    }

    // -------------------------------------------------------------------------
    // Edge reads
    // -------------------------------------------------------------------------
    case "GetEdges": {
      const id = variables.id as string;
      const direction = variables.direction as string;
      const edges = graph.getEdges(id, direction);
      const node = graph.nodes.get(id);
      if (!node) return gqlOk({ artifact: null });
      return gqlOk({
        artifact: {
          edges: edges.map((e) => ({
            sourceId: e.sourceId,
            targetId: e.targetId,
            edgeType: e.edgeType,
            properties: e.properties,
          })),
        },
      });
    }

    // -------------------------------------------------------------------------
    // Graph traversal (stub — returns seed node only)
    // -------------------------------------------------------------------------
    case "AssembleContext": {
      const input = variables.input as Record<string, unknown>;
      const seedIds = input.seedIds as string[];

      const rankedNodes = seedIds
        .map((id) => graph.nodes.get(id))
        .filter(Boolean)
        .map((n) => ({
          node: nodeToGql(n!),
          score: 1.0,
          content: n!.content,
        }));

      const totalTokens = rankedNodes.reduce(
        (sum, rn) => sum + ((rn.node.tokenCount as number | null) ?? 0),
        0
      );

      return gqlOk({
        assembleContext: {
          rankedNodes,
          totalTokens,
          pprScores: seedIds.map((id) => ({ id, score: 1.0 })),
        },
      });
    }

    // -------------------------------------------------------------------------
    // Graph query
    // -------------------------------------------------------------------------
    case "GraphQuery": {
      const query = variables.query as Record<string, unknown>;
      const first = (variables.first as number | undefined) ?? 100;
      // Decode cursor to offset
      let offset = 0;
      if (variables.after) {
        try {
          offset = parseInt(Buffer.from(variables.after as string, "base64").toString("utf8"), 10) + 1;
        } catch {
          offset = 0;
        }
      }
      const result = graph.queryGraph(query, first, offset);
      return gqlOk({
        graphQuery: {
          nodes: result.nodes.map((n) => ({
            node: nodeToGql(n.node),
            summary: n.summary,
            edgeType: n.edgeType,
            direction: n.direction,
            depth: n.depth,
          })),
          totalCount: result.totalCount,
        },
      });
    }

    // -------------------------------------------------------------------------
    // QueryNodes (filtered artifact query)
    // -------------------------------------------------------------------------
    case "QueryNodes": {
      const filter = (variables.filter as Record<string, unknown> | undefined) ?? {};
      const first = (variables.first as number | undefined) ?? 100;
      const offset = (variables.offset as number | undefined) ?? 0;
      const result = graph.queryNodes(filter, first, offset);
      return gqlOk({
        artifactQuery: {
          edges: result.edges.map((e) => ({ node: nodeToGql(e.node) })),
          pageInfo: { totalCount: result.pageInfo.totalCount },
        },
      });
    }

    // -------------------------------------------------------------------------
    // ID generation
    // -------------------------------------------------------------------------
    case "NextId": {
      const type = variables.type as string;
      const cycle = variables.cycle as number | undefined;
      const id = graph.nextId(type, cycle);
      return gqlOk({ nextId: id });
    }

    // -------------------------------------------------------------------------
    // Batch mutate
    // -------------------------------------------------------------------------
    case "BatchMutate": {
      const input = variables.input as {
        nodes: Array<{ id: string; type: string; properties: Record<string, unknown>; cycle?: number }>;
        edges?: Array<{ sourceId: string; targetId: string; edgeType: string; properties: Record<string, unknown> }>;
      };

      if (!input.nodes || input.nodes.length === 0) {
        return gqlError("Batch must contain at least one node", "EMPTY_BATCH");
      }

      // Validate each node
      for (const node of input.nodes) {
        if (!node.id) {
          return gqlError("Node is missing id", "MISSING_NODE_ID");
        }
        if (!node.type) {
          return gqlError("Node is missing type", "MISSING_NODE_TYPE");
        }
        if (!node.properties) {
          return gqlError(`Node ${node.id} is missing properties`, "MISSING_NODE_PROPERTIES");
        }
        // Validate type
        const validTypes = new Set([
          "WORK_ITEM", "FINDING", "DOMAIN_POLICY", "DOMAIN_DECISION", "DOMAIN_QUESTION",
          "GUIDING_PRINCIPLE", "CONSTRAINT", "MODULE_SPEC", "RESEARCH_FINDING",
          "JOURNAL_ENTRY", "INTERVIEW_QUESTION", "PROXY_HUMAN_DECISION", "PROJECT", "PHASE",
          "DECISION_LOG", "CYCLE_SUMMARY", "REVIEW_MANIFEST", "REVIEW_OUTPUT",
          "ARCHITECTURE", "OVERVIEW", "EXECUTION_STRATEGY", "GUIDING_PRINCIPLES",
          "CONSTRAINTS", "RESEARCH", "INTERVIEW", "DOMAIN_INDEX", "AUTOPILOT_STATE",
        ]);
        if (!validTypes.has(node.type)) {
          return gqlError(`Invalid node type: ${node.type}`, "INVALID_NODE_TYPE");
        }
      }

      // Validate edges
      for (const edge of input.edges ?? []) {
        if (!edge.sourceId) {
          return gqlError("Edge is missing source_id", "MISSING_EDGE_SOURCE");
        }
        if (!edge.targetId) {
          return gqlError("Edge is missing target_id", "MISSING_EDGE_TARGET");
        }
        if (!edge.edgeType) {
          return gqlError("Edge is missing edge_type", "MISSING_EDGE_TYPE");
        }
        const validEdgeTypes = new Set([
          "DEPENDS_ON", "BLOCKS", "RELATES_TO", "ASSIGNED_TO", "IMPLEMENTS",
          "SUPERSEDES", "DERIVED_FROM", "TAGGED_WITH", "PART_OF",
        ]);
        if (!validEdgeTypes.has(edge.edgeType)) {
          return gqlError(`Invalid edge type: ${edge.edgeType}`, "INVALID_EDGE_TYPE");
        }
      }

      // Cycle detection on depends_on edges (within the batch)
      const batchNodes = input.nodes.map((n) => {
        const depends = n.properties.depends as string[] | undefined;
        return { id: n.id, depends: depends ?? [] };
      });

      if (graph.hasCycle(batchNodes)) {
        return gqlOk({
          batchMutate: {
            results: [],
            errors: [{ id: null, error: "Dependency cycle detected", code: "CYCLE_DETECTED" }],
          },
        });
      }

      // Persist nodes
      const results = input.nodes.map((n) => {
        const status = graph.putNode(n.id, n.type, n.properties, n.cycle);
        return { id: n.id, status };
      });

      // Persist edges
      for (const edge of input.edges ?? []) {
        graph.putEdge({
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          edgeType: edge.edgeType,
          properties: edge.properties ?? {},
        });
      }

      return gqlOk({
        batchMutate: {
          results,
          errors: [],
        },
      });
    }

    // -------------------------------------------------------------------------
    // Count nodes
    // -------------------------------------------------------------------------
    case "CountNodes": {
      const filter = (variables.filter as Record<string, unknown> | undefined) ?? {};
      const groupBy = variables.groupBy as string;
      const counts = graph.countNodes(filter, groupBy);
      return gqlOk({ nodeCounts: counts });
    }

    case "CountFindingsBySeverity": {
      const filter = (variables.filter as Record<string, unknown> | undefined) ?? {};
      const result = graph.queryNodes(filter, 10000, 0);
      return gqlOk({
        artifactQuery: {
          edges: result.edges.map((e) => ({ node: nodeToGql(e.node) })),
        },
      });
    }

    case "GetAllNodesForStatusCount": {
      const filter = (variables.filter as Record<string, unknown> | undefined) ?? {};
      const result = graph.queryNodes(filter, 10000, 0);
      return gqlOk({
        artifactQuery: {
          edges: result.edges.map((e) => ({ node: { status: e.node.status } })),
        },
      });
    }

    // -------------------------------------------------------------------------
    // Domain state
    // -------------------------------------------------------------------------
    case "DomainState": {
      const domains = variables.domains as string[] | undefined;
      const state = graph.getDomainState(domains);
      return gqlOk({ domainState: state });
    }

    // -------------------------------------------------------------------------
    // Convergence status
    // -------------------------------------------------------------------------
    case "ConvergenceStatus": {
      return gqlOk({
        convergenceStatus: {
          cycleSummaryContent: null,
        },
      });
    }

    case "FindingsByCycle": {
      const filter = (variables.filter as Record<string, unknown> | undefined) ?? {};
      const result = graph.queryNodes(filter, 10000, 0);
      return gqlOk({
        artifactQuery: {
          edges: result.edges.map((e) => ({ node: nodeToGql(e.node) })),
        },
      });
    }

    // -------------------------------------------------------------------------
    // Archive cycle
    // -------------------------------------------------------------------------
    case "ArchiveCycle": {
      return gqlOk({ archiveCycle: "0 artifacts archived in cycle " + variables.cycleNumber });
    }

    // -------------------------------------------------------------------------
    // Append journal entry
    // -------------------------------------------------------------------------
    case "AppendJournal": {
      const input = variables.input as {
        skill: string;
        date: string;
        entryType: string;
        body: string;
        cycle: number;
      };
      const id = graph.appendJournalEntry(input);
      return gqlOk({ appendJournal: { id, status: "CREATED" } });
    }

    // -------------------------------------------------------------------------
    // Test-only: reset all graph state between tests
    // -------------------------------------------------------------------------
    case "ResetGraph": {
      graph.nodes.clear();
      graph.edges = [];
      graph.journalCounters.clear();
      return gqlOk({ resetGraph: true });
    }

    default:
      return gqlError(`Unknown operation: ${operationName}`, "UNKNOWN_OPERATION");
  }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface MockServerHandle {
  url: string;
  close: () => Promise<void>;
}

export async function startMockServer(
  opts: { port?: number } = {}
): Promise<MockServerHandle> {
  const graph = new InMemoryGraph();

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end("Method Not Allowed");
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: { query: string; variables?: Record<string, unknown> };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(gqlError("Invalid JSON body", "PARSE_ERROR"));
        return;
      }

      const operationName = extractOperationName(body.query ?? "");
      if (!operationName) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(gqlError("Could not determine operation name", "UNKNOWN_OPERATION"));
        return;
      }

      let responseBody: string;
      try {
        responseBody = dispatch(graph, operationName, body.variables ?? {});
      } catch (err) {
        responseBody = gqlError(
          err instanceof Error ? err.message : String(err),
          "INTERNAL_ERROR"
        );
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(responseBody);
    });
  });

  const port = opts.port ?? 0; // 0 = random available port
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/graphql`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
