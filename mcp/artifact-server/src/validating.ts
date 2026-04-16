// validating.ts — ValidatingAdapter decorator with comprehensive input validation
//
// Wraps any StorageAdapter and validates all inputs before delegating to the
// inner adapter. Throws ValidationError for any invalid input.

import {
  StorageAdapter,
  Node,
  NodeFilter,
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
  ALL_NODE_TYPES,
  ALL_EDGE_TYPES,
  ValidationError,
  ImmutableFieldError,
  ToolUsageFilter,
  ToolUsageRow,
} from "./adapter.js";
import type { EdgeType } from "./schema.js";

// ---------------------------------------------------------------------------
// CYCLE_SCOPED_TYPES — node types that require a cycle parameter
// ---------------------------------------------------------------------------

/**
 * Node types that require a cycle parameter in putNode / nextId.
 * Exported so callers can avoid re-defining this set.
 */
export const CYCLE_SCOPED_TYPES = new Set<NodeType>([
  "finding",
  "decision_log",
  "cycle_summary",
  "review_manifest",
  "review_output",
  "proxy_human_decision",
]);

// ---------------------------------------------------------------------------
// ValidatingAdapter
// ---------------------------------------------------------------------------

export class ValidatingAdapter implements StorageAdapter {
  constructor(private readonly inner: StorageAdapter) {}

  // -------------------------------------------------------------------------
  // Private validation helpers
  // -------------------------------------------------------------------------

  private validateId(id: unknown, field: string): void {
    if (typeof id !== "string" || id.trim() === "") {
      throw new ValidationError(
        `${field} must be a non-empty string`,
        "INVALID_NODE_ID",
        { field, value: id }
      );
    }
  }

  private validateNodeType(type: unknown): void {
    if (!ALL_NODE_TYPES.includes(type as NodeType)) {
      throw new ValidationError(
        `Invalid NodeType: ${String(type)}`,
        "INVALID_NODE_TYPE",
        { value: type }
      );
    }
  }

  private validateEdgeType(type: unknown, field = "edge_type"): void {
    if (!ALL_EDGE_TYPES.includes(type as EdgeType)) {
      throw new ValidationError(
        `Invalid EdgeType: ${String(type)}`,
        "INVALID_EDGE_TYPE",
        { field, value: type }
      );
    }
  }

  private validatePagination(limit: number, offset: number): void {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new ValidationError(
        "Limit must be a non-negative integer",
        "INVALID_LIMIT",
        { limit }
      );
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ValidationError(
        "Offset must be a non-negative integer",
        "INVALID_OFFSET",
        { offset }
      );
    }
  }

  private validatePutNode(input: MutateNodeInput): void {
    // id: non-empty string
    if (typeof input.id !== "string" || input.id.trim() === "") {
      throw new ValidationError(
        "Node id must be a non-empty string",
        "INVALID_NODE_ID",
        { value: input.id }
      );
    }
    // type: valid NodeType
    this.validateNodeType(input.type);
    // properties: non-null, non-array object
    if (input.properties == null || typeof input.properties !== "object" || Array.isArray(input.properties)) {
      throw new ValidationError(
        "Node properties must be provided",
        "MISSING_NODE_PROPERTIES",
        {}
      );
    }
    // cycle-scoped types require cycle
    if (CYCLE_SCOPED_TYPES.has(input.type) && input.cycle === undefined) {
      throw new ValidationError(
        `Cycle parameter required for type "${input.type}"`,
        "MISSING_CYCLE",
        { type: input.type }
      );
    }
  }

  // -------------------------------------------------------------------------
  // Node CRUD
  // -------------------------------------------------------------------------

  async getNode(id: string): Promise<Node | null> {
    this.validateId(id, "Node id");
    return this.inner.getNode(id);
  }

  async getNodes(ids: string[]): Promise<Map<string, Node>> {
    for (const id of ids) {
      this.validateId(id, "Node id");
    }
    return this.inner.getNodes(ids);
  }

  async readNodeContent(id: string): Promise<string> {
    this.validateId(id, "Node id");
    return this.inner.readNodeContent(id);
  }

  async putNode(input: MutateNodeInput): Promise<MutateNodeResult> {
    this.validatePutNode(input);
    return this.inner.putNode(input);
  }

  async patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult> {
    // id: non-empty string
    if (typeof input.id !== "string" || input.id.trim() === "") {
      throw new ValidationError(
        "Node id must be a non-empty string",
        "INVALID_NODE_ID",
        { value: input.id }
      );
    }
    // properties: must be a non-null, non-array object
    if (input.properties == null || typeof input.properties !== "object" || Array.isArray(input.properties)) {
      throw new ValidationError(
        "Node properties must be provided",
        "MISSING_NODE_PROPERTIES",
        {}
      );
    }
    // properties must not contain immutable fields
    const IMMUTABLE = ["id", "type", "cycle_created"];
    for (const field of IMMUTABLE) {
      if (field in input.properties) {
        throw new ImmutableFieldError(field);
      }
    }
    return this.inner.patchNode(input);
  }

  async deleteNode(id: string): Promise<DeleteNodeResult> {
    this.validateId(id, "Node id");
    return this.inner.deleteNode(id);
  }

  // -------------------------------------------------------------------------
  // Edge CRUD
  // -------------------------------------------------------------------------

  async putEdge(edge: Edge): Promise<void> {
    if (!edge.source_id || edge.source_id.trim() === "") {
      throw new ValidationError(
        "Edge source_id required",
        "MISSING_EDGE_SOURCE",
        {}
      );
    }
    if (!edge.target_id || edge.target_id.trim() === "") {
      throw new ValidationError(
        "Edge target_id required",
        "MISSING_EDGE_TARGET",
        {}
      );
    }
    if (!edge.edge_type) {
      throw new ValidationError(
        "Edge type required",
        "MISSING_EDGE_TYPE",
        {}
      );
    }
    this.validateEdgeType(edge.edge_type);
    return this.inner.putEdge(edge);
  }

  async removeEdges(source_id: string, edge_types: EdgeType[]): Promise<void> {
    // source_id: non-empty string
    if (typeof source_id !== "string" || source_id.trim() === "") {
      throw new ValidationError(
        "source_id must be a non-empty string",
        "INVALID_NODE_ID",
        { value: source_id }
      );
    }
    // edge_types: must be an array (may be empty — empty is a no-op)
    if (!Array.isArray(edge_types)) {
      throw new ValidationError(
        "edge_types must be an array",
        "INVALID_EDGE_TYPE",
        { value: edge_types }
      );
    }
    // Empty array is a no-op — return without delegating
    if (edge_types.length === 0) return;
    for (const et of edge_types) {
      this.validateEdgeType(et);
    }
    return this.inner.removeEdges(source_id, edge_types);
  }

  async getEdges(
    id: string,
    direction: "outgoing" | "incoming" | "both"
  ): Promise<Edge[]> {
    this.validateId(id, "Node id");
    const VALID_DIRECTIONS = ["outgoing", "incoming", "both"];
    if (!VALID_DIRECTIONS.includes(direction)) {
      throw new ValidationError(
        `direction must be one of 'outgoing', 'incoming', 'both'`,
        "INVALID_DIRECTION",
        { value: direction }
      );
    }
    return this.inner.getEdges(id, direction);
  }

  // -------------------------------------------------------------------------
  // Graph traversal
  // -------------------------------------------------------------------------

  async traverse(options: TraversalOptions): Promise<TraversalResult> {
    // seed_ids: must be an array
    if (!Array.isArray(options.seed_ids)) {
      throw new ValidationError(
        "seed_ids must be an array",
        "INVALID_SEED_IDS",
        { value: options.seed_ids }
      );
    }
    // seed_ids: must be non-empty
    if (options.seed_ids.length === 0) {
      throw new ValidationError(
        "seed_ids cannot be empty",
        "EMPTY_SEED_IDS",
        {}
      );
    }
    // each seed_id must be a non-empty string
    for (const id of options.seed_ids) {
      if (typeof id !== "string" || id.trim() === "") {
        throw new ValidationError(
          `Each seed_id must be a non-empty string, received ${JSON.stringify(id)}`,
          "INVALID_SEED_ID",
          { value: id }
        );
      }
    }

    // alpha: if provided, must be in (0, 1]
    if (options.alpha !== undefined) {
      if (typeof options.alpha !== "number" || !Number.isFinite(options.alpha) || options.alpha <= 0 || options.alpha > 1) {
        throw new ValidationError(
          `alpha must be a number in (0, 1], received ${options.alpha}`,
          "INVALID_ALPHA",
          { value: options.alpha }
        );
      }
    }

    // max_iterations: if provided, must be a positive integer
    if (options.max_iterations !== undefined) {
      if (!Number.isInteger(options.max_iterations) || options.max_iterations <= 0) {
        throw new ValidationError(
          `max_iterations must be a positive integer, received ${options.max_iterations}`,
          "INVALID_MAX_ITERATIONS",
          { value: options.max_iterations }
        );
      }
    }

    // token_budget: if provided, must be a non-negative integer
    if (options.token_budget !== undefined) {
      if (!Number.isInteger(options.token_budget) || options.token_budget < 0) {
        throw new ValidationError(
          `token_budget must be non-negative, received ${options.token_budget}`,
          "INVALID_TOKEN_BUDGET",
          { value: options.token_budget }
        );
      }
    }

    // convergence_threshold: if provided, must be a positive number
    if (options.convergence_threshold !== undefined) {
      if (typeof options.convergence_threshold !== "number" || !Number.isFinite(options.convergence_threshold) || options.convergence_threshold <= 0) {
        throw new ValidationError(
          `convergence_threshold must be a positive number, received ${options.convergence_threshold}`,
          "INVALID_CONVERGENCE_THRESHOLD",
          { value: options.convergence_threshold }
        );
      }
    }

    // max_nodes: if provided, must be a non-negative integer
    if (options.max_nodes !== undefined) {
      if (!Number.isInteger(options.max_nodes) || options.max_nodes < 0) {
        throw new ValidationError(
          `max_nodes must be a non-negative integer, received ${options.max_nodes}`,
          "INVALID_MAX_NODES",
          { value: options.max_nodes }
        );
      }
    }

    // edge_type_weights: if provided, must be a plain object with valid keys and numeric values
    if (options.edge_type_weights !== undefined) {
      if (typeof options.edge_type_weights !== "object" || options.edge_type_weights === null || Array.isArray(options.edge_type_weights)) {
        throw new ValidationError(
          "edge_type_weights must be a plain object",
          "INVALID_EDGE_WEIGHTS",
          { value: options.edge_type_weights }
        );
      }
      for (const [key, value] of Object.entries(options.edge_type_weights)) {
        if (!ALL_EDGE_TYPES.includes(key as EdgeType)) {
          throw new ValidationError(
            `Invalid edge type in edge_type_weights: ${key}`,
            "INVALID_EDGE_TYPE",
            { value: key }
          );
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new ValidationError(
            `edge_type_weights values must be non-negative numbers, received ${value} for key "${key}"`,
            "INVALID_EDGE_WEIGHT",
            { key, value }
          );
        }
      }
    }

    // always_include_types: if provided, all values must be valid NodeType
    if (options.always_include_types !== undefined) {
      for (const type of options.always_include_types) {
        if (!ALL_NODE_TYPES.includes(type as NodeType)) {
          throw new ValidationError(
            `Invalid NodeType in always_include_types: ${String(type)}`,
            "INVALID_NODE_TYPE",
            { value: type }
          );
        }
      }
    }

    return this.inner.traverse(options);
  }

  async queryGraph(
    query: GraphQuery,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    this.validatePagination(limit, offset);

    // origin_id: non-empty string
    if (typeof query.origin_id !== "string" || query.origin_id.trim() === "") {
      throw new ValidationError(
        "origin_id must be a non-empty string",
        "INVALID_NODE_ID",
        { value: query.origin_id }
      );
    }

    // depth: if provided, must be a positive integer
    if (query.depth !== undefined) {
      if (!Number.isInteger(query.depth) || query.depth <= 0) {
        throw new ValidationError(
          `depth must be a positive integer, received ${query.depth}`,
          "INVALID_DEPTH",
          { value: query.depth }
        );
      }
    }

    // direction: if provided, must be valid
    if (query.direction !== undefined) {
      const VALID_DIRECTIONS = ["outgoing", "incoming", "both"];
      if (!VALID_DIRECTIONS.includes(query.direction)) {
        throw new ValidationError(
          `direction must be one of 'outgoing', 'incoming', 'both'`,
          "INVALID_DIRECTION",
          { value: query.direction }
        );
      }
    }

    // edge_types: if provided, all must be valid EdgeType
    if (query.edge_types !== undefined) {
      for (const et of query.edge_types) {
        this.validateEdgeType(et);
      }
    }

    return this.inner.queryGraph(query, limit, offset);
  }

  // -------------------------------------------------------------------------
  // Filtered queries
  // -------------------------------------------------------------------------

  async queryNodes(
    filter: NodeFilter,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    this.validatePagination(limit, offset);
    return this.inner.queryNodes(filter, limit, offset);
  }

  async indexFiles(paths: string[]): Promise<void> {
    // paths: must be an array
    if (!Array.isArray(paths)) {
      throw new ValidationError(
        "paths must be an array",
        "INVALID_PATHS",
        { value: paths }
      );
    }
    return this.inner.indexFiles(paths);
  }

  async removeFiles(paths: string[]): Promise<void> {
    // paths: must be an array
    if (!Array.isArray(paths)) {
      throw new ValidationError(
        "paths must be an array",
        "INVALID_PATHS",
        { value: paths }
      );
    }
    return this.inner.removeFiles(paths);
  }

  async nextId(type: NodeType, cycle?: number): Promise<string> {
    // type: valid NodeType
    this.validateNodeType(type);
    // cycle validation is type-specific and handled by the inner adapter
    return this.inner.nextId(type, cycle);
  }

  // -------------------------------------------------------------------------
  // Batch operations
  // -------------------------------------------------------------------------

  async batchMutate(input: BatchMutateInput): Promise<BatchMutateResult> {
    // nodes: non-empty array
    if (!input.nodes || input.nodes.length === 0) {
      throw new ValidationError(
        "Batch mutation requires at least one node",
        "EMPTY_BATCH",
        {}
      );
    }
    // each node: validate fields with batchMutate-specific error codes for missing fields
    for (const node of input.nodes) {
      // id: must be present (MISSING_NODE_ID) and non-empty string (INVALID_NODE_ID)
      if (!("id" in node) || node.id === undefined || node.id === null) {
        throw new ValidationError(
          "Node is missing required 'id' field",
          "MISSING_NODE_ID",
          { node }
        );
      }
      if (typeof node.id !== "string" || node.id.trim() === "") {
        throw new ValidationError(
          "Node id must be a non-empty string",
          "INVALID_NODE_ID",
          { value: node.id }
        );
      }
      // type: must be present (MISSING_NODE_TYPE) and valid (INVALID_NODE_TYPE)
      if (node.type === undefined || node.type === null) {
        throw new ValidationError(
          "Node is missing required 'type' field",
          "MISSING_NODE_TYPE",
          { id: node.id }
        );
      }
      this.validateNodeType(node.type);
      // properties: must be present (MISSING_NODE_PROPERTIES)
      if (node.properties == null || typeof node.properties !== "object" || Array.isArray(node.properties)) {
        throw new ValidationError(
          "Node is missing required 'properties' field",
          "MISSING_NODE_PROPERTIES",
          { id: node.id }
        );
      }
      // cycle-scoped types require cycle
      if (CYCLE_SCOPED_TYPES.has(node.type) && node.cycle === undefined) {
        throw new ValidationError(
          `Cycle parameter required for type "${node.type}"`,
          "MISSING_CYCLE",
          { type: node.type }
        );
      }
    }
    // each edge (if provided) must pass edge validation
    if (input.edges) {
      for (const edge of input.edges) {
        if (!edge.source_id || edge.source_id.trim() === "") {
          throw new ValidationError(
            "Edge source_id required",
            "MISSING_EDGE_SOURCE",
            {}
          );
        }
        if (!edge.target_id || edge.target_id.trim() === "") {
          throw new ValidationError(
            "Edge target_id required",
            "MISSING_EDGE_TARGET",
            {}
          );
        }
        if (!edge.edge_type) {
          throw new ValidationError(
            "Edge type required",
            "MISSING_EDGE_TYPE",
            {}
          );
        }
        this.validateEdgeType(edge.edge_type);
      }
    }
    return this.inner.batchMutate(input);
  }

  // -------------------------------------------------------------------------
  // Aggregation queries
  // -------------------------------------------------------------------------

  async countNodes(
    filter: NodeFilter,
    group_by: "status" | "type" | "domain" | "severity"
  ): Promise<Array<{ key: string; count: number }>> {
    const VALID_GROUP_BY = ["status", "type", "domain", "severity"];
    if (!VALID_GROUP_BY.includes(group_by)) {
      throw new ValidationError(
        `group_by must be one of 'status', 'type', 'domain', 'severity'`,
        "INVALID_GROUP_BY",
        { value: group_by }
      );
    }
    return this.inner.countNodes(filter, group_by);
  }

  async getDomainState(
    domains?: string[]
  ): Promise<
    Map<
      string,
      {
        policies: Array<{ id: string; description: string | null; status: string | null }>;
        decisions: Array<{ id: string; description: string | null; status: string | null }>;
        questions: Array<{ id: string; description: string | null; status: string | null }>;
      }
    >
  > {
    // domains: if provided, must be array of non-empty strings
    if (domains !== undefined) {
      for (const domain of domains) {
        if (typeof domain !== "string" || domain.trim() === "") {
          throw new ValidationError(
            "Each domain must be a non-empty string",
            "INVALID_DOMAIN",
            { value: domain }
          );
        }
      }
    }
    return this.inner.getDomainState(domains);
  }

  async getConvergenceData(cycle: number): Promise<{
    findings_by_severity: Record<string, number>;
    cycle_summary_content: string | null;
  }> {
    // cycle: positive integer
    if (!Number.isInteger(cycle) || cycle <= 0) {
      throw new ValidationError(
        `cycle must be a positive integer, received ${cycle}`,
        "INVALID_CYCLE",
        { value: cycle }
      );
    }
    return this.inner.getConvergenceData(cycle);
  }

  async getToolUsage(filter?: ToolUsageFilter): Promise<ToolUsageRow[]> {
    const rows = await this.inner.getToolUsage(filter);
    // Validate output shape: each row must have required fields with correct types.
    // This catches malformed adapter implementations before they propagate.
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (typeof row.id !== "number") {
        throw new ValidationError(
          `getToolUsage row[${i}].id must be a number, got ${typeof row.id}`,
          "INVALID_TOOL_USAGE_ROW",
          { index: i, field: "id", value: row.id }
        );
      }
      if (typeof row.tool_name !== "string") {
        throw new ValidationError(
          `getToolUsage row[${i}].tool_name must be a string, got ${typeof row.tool_name}`,
          "INVALID_TOOL_USAGE_ROW",
          { index: i, field: "tool_name", value: row.tool_name }
        );
      }
      if (typeof row.timestamp !== "string") {
        throw new ValidationError(
          `getToolUsage row[${i}].timestamp must be a string, got ${typeof row.timestamp}`,
          "INVALID_TOOL_USAGE_ROW",
          { index: i, field: "timestamp", value: row.timestamp }
        );
      }
    }
    return rows;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    return this.inner.initialize();
  }

  async shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  async archiveCycle(cycle: number): Promise<string> {
    // cycle: positive integer
    if (!Number.isInteger(cycle) || cycle <= 0) {
      throw new ValidationError(
        `cycle must be a positive integer, received ${cycle}`,
        "INVALID_CYCLE",
        { value: cycle }
      );
    }
    return this.inner.archiveCycle(cycle);
  }

  async appendJournalEntry(args: {
    skill: string;
    date: string;
    entryType: string;
    body: string;
    cycle: number;
  }): Promise<string> {
    // skill: non-empty string
    if (typeof args.skill !== "string" || args.skill.trim() === "") {
      throw new ValidationError(
        "skill must be a non-empty string",
        "MISSING_JOURNAL_FIELD",
        { field: "skill", value: args.skill }
      );
    }
    // date: non-empty string
    if (typeof args.date !== "string" || args.date.trim() === "") {
      throw new ValidationError(
        "date must be a non-empty string",
        "MISSING_JOURNAL_FIELD",
        { field: "date", value: args.date }
      );
    }
    // entryType: non-empty string
    if (typeof args.entryType !== "string" || args.entryType.trim() === "") {
      throw new ValidationError(
        "entryType must be a non-empty string",
        "MISSING_JOURNAL_FIELD",
        { field: "entryType", value: args.entryType }
      );
    }
    // body: non-empty string
    if (typeof args.body !== "string" || args.body.trim() === "") {
      throw new ValidationError(
        "body must be a non-empty string",
        "MISSING_JOURNAL_FIELD",
        { field: "body", value: args.body }
      );
    }
    // cycle: positive integer
    if (!Number.isInteger(args.cycle) || args.cycle <= 0) {
      throw new ValidationError(
        `cycle must be a positive integer, received ${args.cycle}`,
        "INVALID_CYCLE",
        { value: args.cycle }
      );
    }
    return this.inner.appendJournalEntry(args);
  }
}
