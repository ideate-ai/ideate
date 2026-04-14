// adapters/remote/index.ts -- RemoteAdapter: StorageAdapter backed by ideate-server GraphQL API
//
// Delegates all storage operations to a remote ideate-server instance via
// GraphQL queries and mutations. Uses built-in fetch (Node 22) with no
// external dependencies.
//
// Enum case mapping: the StorageAdapter uses lower_snake_case string unions
// (e.g. "work_item", "depends_on") while GraphQL uses UPPER_SNAKE_CASE enums
// (e.g. WORK_ITEM, DEPENDS_ON). Helper functions handle the conversion.

import type {
  StorageAdapter,
  Node,
  NodeMeta,
  NodeType,
  Edge,
  EdgeType,
  TraversalOptions,
  TraversalResult,
  GraphQuery,
  QueryResult,
  NodeFilter,
  MutateNodeInput,
  MutateNodeResult,
  UpdateNodeInput,
  UpdateNodeResult,
  DeleteNodeResult,
  BatchMutateInput,
  BatchMutateResult,
  AdapterConfig,
} from "../../adapter.js";

import { ConnectionError, ValidationError, StorageAdapterError } from "../../adapter.js";
import { GraphQLClient } from "./client.js";
import { log } from "../../logger.js";

// ---------------------------------------------------------------------------
// Enum case mapping helpers
// ---------------------------------------------------------------------------

/** Convert a lower_snake_case adapter value to UPPER_SNAKE_CASE GraphQL enum. */
function toGraphQLEnum(value: string): string {
  return value.toUpperCase();
}

/** Convert an UPPER_SNAKE_CASE GraphQL enum to lower_snake_case adapter value. */
function fromGraphQLEnum(value: string): string {
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// Extension table column allowlists — matches LocalAdapter's SQLite schema.
// Only these fields are returned in Node.properties, keeping responses lean.
// ---------------------------------------------------------------------------

const EXTENSION_COLUMNS: Record<string, string[]> = {
  work_item: ["title", "complexity", "scope", "depends", "blocks", "criteria", "module", "domain", "phase", "notes", "work_item_type", "resolution"],
  finding: ["severity", "work_item", "file_refs", "verdict", "cycle", "reviewer", "description", "suggestion", "addressed_by", "title"],
  domain_policy: ["domain", "derived_from", "established", "amended", "amended_by", "description"],
  domain_decision: ["domain", "cycle", "supersedes", "description", "rationale", "title", "source"],
  domain_question: ["domain", "impact", "source", "resolution", "resolved_in", "description", "addressed_by"],
  guiding_principle: ["name", "description", "amendment_history"],
  constraint: ["category", "description"],
  module_spec: ["name", "scope", "provides", "requires", "boundary_rules"],
  research_finding: ["topic", "date", "content", "sources"],
  journal_entry: ["phase", "date", "title", "work_item", "content"],
  metrics_event: ["event_name", "timestamp", "payload", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "outcome", "finding_count", "finding_severities", "first_pass_accepted", "rework_count", "work_item_total_tokens", "cycle_total_tokens", "cycle_total_cost_estimate", "convergence_cycles", "context_artifact_ids"],
  interview_question: ["interview_id", "question", "answer", "domain", "seq"],
  proxy_human_decision: ["cycle", "trigger", "triggered_by", "decision", "rationale", "timestamp", "status"],
  project: ["name", "description", "intent", "scope_boundary", "success_criteria", "appetite", "steering", "horizon", "status", "current_phase_id"],
  phase: ["name", "description", "project", "phase_type", "intent", "steering", "status", "work_items", "completed_date"],
  // Document types (decision_log, cycle_summary, review_output, etc.)
  decision_log: ["title", "cycle", "content"],
  cycle_summary: ["title", "cycle", "content"],
  review_output: ["title", "cycle", "content"],
  review_manifest: ["title", "cycle", "content"],
  architecture: ["title", "cycle", "content"],
  overview: ["title", "cycle", "content"],
  execution_strategy: ["title", "cycle", "content"],
  guiding_principles: ["title", "cycle", "content"],
  constraints: ["title", "cycle", "content"],
  research: ["title", "cycle", "content"],
  interview: ["title", "cycle", "content"],
  domain_index: ["title", "cycle", "content"],
};

// ---------------------------------------------------------------------------
// Field fallback mappings — mirrors buildExtensionRow logic in indexer.ts.
// When the content blob has field A but not field B, map A → B.
// ---------------------------------------------------------------------------

const FIELD_FALLBACKS: Record<string, Record<string, string[]>> = {
  guiding_principle: {
    name: ["title"],          // doc.name ?? doc.title
    description: ["body"],    // doc.description ?? doc.body
  },
  phase: {
    name: ["title"],          // doc.name ?? doc.title
    project: ["project_id"], // doc.project ?? doc.project_id
  },
  metrics_event: {
    // T-13: indexer uses ?? '' chain; we apply same fallback here for putNode parity
    // event_name: null + agent_type: "reviewer" => "reviewer"
    // event_name: null + agent_type: null => "" (empty string per SQLite NOT NULL)
    event_name: ["agent_type", ""],
  },
  journal_entry: {
    // Server stores skill/entry_type/body; LocalAdapter expects phase/title/content
    phase: ["skill"],
    title: ["entry_type"],
    content: ["body"],
  },
};

// ---------------------------------------------------------------------------
// Default values for fields — mirrors server-side defaults in LocalAdapter
// Applied when the field is null or undefined to ensure adapter parity
// ---------------------------------------------------------------------------

const DEFAULT_VALUES: Record<string, Record<string, unknown>> = {
  work_item: {
    work_item_type: "feature",
  },
};

// ---------------------------------------------------------------------------
// Response type helpers — shape of data returned by GraphQL queries
// ---------------------------------------------------------------------------

/** ArtifactNode fields common across all GraphQL node types. */
interface GqlArtifactNode {
  artifactId: string;
  type: string;
  status: string | null;
  cycleCreated: number | null;
  cycleModified: number | null;
  contentHash: string;
  tokenCount: number | null;
  content?: string | null;
  // Properties come as a JSON blob when we request them
  [key: string]: unknown;
}

/** Reverse mapping for putNode-created nodes: server field names → local field names.
 *  When putNode writes directly to the server, properties are stored as-is without
 *  the FIELD_FALLBACKS transform. On read, we need to reverse-map server field names
 *  back to local field names for the properties to match.
 */
const FIELD_REVERSE_MAPPINGS: Record<string, Record<string, string>> = {
  journal_entry: {
    // Server stores: skill, entry_type, body
    // Local expects: phase, title, content
    skill: "phase",
    entry_type: "title",
    body: "content",
  },
};

/** Map a GraphQL ArtifactNode response to a StorageAdapter Node. */
function mapGqlNodeToNode(gql: GqlArtifactNode): Node {
  // Extract known metadata fields
  const {
    artifactId,
    type,
    status,
    cycleCreated,
    cycleModified,
    contentHash,
    tokenCount,
    content,
    id: _dbId,
    orgId: _orgId,
    codebaseId: _codebaseId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    __typename: _typename,
    edges: _edges,
  } = gql;

  // Reconstruct properties from the serialized content field, filtered to
  // only the columns that exist in the corresponding SQLite extension table.
  // This matches LocalAdapter behavior and reduces token usage in MCP responses.
  let properties: Record<string, unknown> = {};
  if (typeof content === "string" && content.length > 0) {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const artifactType = fromGraphQLEnum(type);
        const allowed = EXTENSION_COLUMNS[artifactType];

        // Start with a copy of parsed content for processing
        let contentObj: Record<string, unknown> = { ...parsed };

        // Apply reverse mappings for putNode-created nodes (server field names → local)
        const reverseMappings = FIELD_REVERSE_MAPPINGS[artifactType];
        if (reverseMappings) {
          for (const [serverField, localField] of Object.entries(reverseMappings)) {
            if (serverField in contentObj && !(localField in contentObj)) {
              contentObj[localField] = contentObj[serverField];
              // Keep the server field too — the allowed list will filter appropriately
            }
          }
        }

        if (allowed) {
          // Apply indexer field-name fallbacks (matches buildExtensionRow in indexer.ts)
          // T-13: handles ?? '' pattern for NOT NULL columns (e.g., metrics_events.event_name)
          const fallbacks = FIELD_FALLBACKS[artifactType];
          if (fallbacks) {
            for (const [target, sources] of Object.entries(fallbacks)) {
              // Match indexer's toStrOrNull(x) ?? toStrOrNull(y) ?? ... pattern:
              // if target is absent, undefined, or null, try fallback sources
              if (contentObj[target] === undefined || contentObj[target] === null) {
                let fallbackApplied = false;
                for (const src of sources) {
                  // T-13: empty string literal means "use empty string as final fallback"
                  if (src === "") {
                    contentObj[target] = "";
                    fallbackApplied = true;
                    break;
                  }
                  if (src in contentObj && contentObj[src] !== undefined && contentObj[src] !== null) {
                    contentObj[target] = contentObj[src];
                    fallbackApplied = true;
                    break;
                  }
                }
                // Ensure target exists even if no fallback was found (shouldn't happen with ["", ...])
                if (!fallbackApplied && !(target in contentObj)) {
                  contentObj[target] = null;
                }
              }
            }
          }

          // Apply default values for type-specific fields (matching server-side behavior)
          const defaults = DEFAULT_VALUES[artifactType];
          if (defaults) {
            for (const [key, defaultValue] of Object.entries(defaults)) {
              if (contentObj[key] === undefined || contentObj[key] === null) {
                contentObj[key] = defaultValue;
              }
            }
          }

          for (const key of allowed) {
            if (key in contentObj) {
              const val = contentObj[key];
              // Stringify arrays/objects to match LocalAdapter's SQLite text columns
              if (val !== null && typeof val === "object") {
                properties[key] = JSON.stringify(val);
              } else {
                properties[key] = val;
              }
            } else {
              // Absent fields default to null (matching LocalAdapter's SQLite NULL)
              properties[key] = null;
            }
          }

          // Compute derived fields that the indexer builds from raw YAML
          if (artifactType === "metrics_event" && properties["payload"] === null) {
            // indexer.ts computes payload from top-level fields
            const payloadFields = ["agent_type", "skill", "phase", "work_item", "model", "wall_clock_ms", "turns_used", "cycle"];
            const computed: Record<string, unknown> = {};
            for (const f of payloadFields) {
              if (f in contentObj && contentObj[f] !== undefined && contentObj[f] !== null) {
                computed[f] = contentObj[f];
              }
            }
            properties["payload"] = Object.keys(computed).length > 0 ? JSON.stringify(computed) : null;
          }
        } else {
          // Unknown type — pass through non-metadata fields
          const METADATA_KEYS = new Set([
            "id", "type", "status", "cycle_created", "cycle_modified",
            "content_hash", "token_count", "content",
          ]);
          for (const [k, v] of Object.entries(contentObj)) {
            if (!METADATA_KEYS.has(k)) {
              properties[k] = v;
            }
          }
        }
      }
    } catch {
      // Decision: throw explicit error (not silent catch or log-only).
      // This ensures RemoteAdapter matches LocalAdapter behavior where
      // malformed content is treated as a hard failure, surfacing data
      // integrity issues immediately rather than silently returning
      // empty properties that could mask corruption.
      throw new StorageAdapterError(
        `Failed to parse content for node ${artifactId}: invalid JSON`,
        "PARSE_ERROR",
        { nodeId: artifactId, content: content.substring(0, 1000) }
      );
    }
  }

  return {
    id: artifactId,
    type: fromGraphQLEnum(type) as NodeType,
    status: status ? fromGraphQLEnum(status) : null,
    cycle_created: cycleCreated,
    cycle_modified: cycleModified,
    content_hash: contentHash,
    token_count: tokenCount,
    properties,
  };
}

/** Map a GraphQL ArtifactNode response to a StorageAdapter NodeMeta. */
function mapGqlNodeToMeta(gql: GqlArtifactNode): NodeMeta {
  return {
    id: gql.artifactId,
    type: fromGraphQLEnum(gql.type) as NodeType,
    status: gql.status ? fromGraphQLEnum(gql.status) : null,
    cycle_created: gql.cycleCreated,
    cycle_modified: gql.cycleModified,
    content_hash: gql.contentHash,
    token_count: gql.tokenCount,
  };
}

/** Map a GraphQL Edge response to a StorageAdapter Edge. */
function mapGqlEdge(gql: {
  sourceId: string;
  targetId: string;
  edgeType: string;
  properties?: unknown;
}): Edge {
  return {
    source_id: gql.sourceId,
    target_id: gql.targetId,
    edge_type: fromGraphQLEnum(gql.edgeType) as EdgeType,
    properties: (gql.properties as Record<string, unknown>) ?? {},
  };
}

// ---------------------------------------------------------------------------
// GraphQL document fragments
// ---------------------------------------------------------------------------

const ARTIFACT_NODE_FIELDS = `
  artifactId
  type
  status
  cycleCreated
  cycleModified
  contentHash
  tokenCount
`;

const ARTIFACT_NODE_FIELDS_WITH_CONTENT = `
  ${ARTIFACT_NODE_FIELDS}
  content
`;

// ---------------------------------------------------------------------------
// NodeFilter -> NodeFilterInput mapping
// ---------------------------------------------------------------------------

function buildFilterInput(
  filter: NodeFilter
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (filter.type) input.type = toGraphQLEnum(filter.type);
  if (filter.status) input.status = filter.status;
  if (filter.domain) input.domain = filter.domain;
  if (filter.cycle !== undefined) input.cycle = filter.cycle;
  if (filter.severity) input.severity = filter.severity;
  if (filter.phase) input.phase = filter.phase;
  if (filter.work_item) input.workItem = filter.work_item;
  if (filter.work_item_type) input.workItemType = filter.work_item_type;

  // D-134/P-62: Add implicit status exclusion for work_item queries without explicit status filter.
  // This ensures RemoteAdapter matches LocalAdapter behavior per D-131.
  // When querying work_items (by type or cross-type) without status filter, exclude done/obsolete.
  if (!filter.status && (filter.type === "work_item" || !filter.type)) {
    input.statusNotIn = ["DONE", "OBSOLETE"];
  }

  return input;
}

// ---------------------------------------------------------------------------
// RemoteAdapter
// ---------------------------------------------------------------------------

export class RemoteAdapter implements StorageAdapter {
  private client: GraphQLClient;
  private endpoint: string;
  private codebaseId: string;
  private currentCycle: number | null = null;

  constructor(config: NonNullable<AdapterConfig["remote"]>) {
    const headers: Record<string, string> = {};

    // AC-9: Auth token passed as Bearer header when configured
    // AC-10: Dev mode — no auth header when auth_token is null
    if (config.auth_token) {
      headers["Authorization"] = `Bearer ${config.auth_token}`;
    }

    // Pass org_id as a header for server-side scoping (when not using JWT)
    headers["X-Org-Id"] = config.org_id;
    headers["X-Codebase-Id"] = config.codebase_id;

    this.client = new GraphQLClient(config.endpoint, headers, config.tokenProvider);
    this.endpoint = config.endpoint;
    this.codebaseId = config.codebase_id;
  }

  /**
   * Fetch the current cycle from the domain_index artifact.
   * Caches the result for subsequent calls.
   *
   * Error handling:
   * - JSON parse errors throw StorageAdapterError (PARSE_ERROR)
   * - GraphQL/network errors throw plain Error (not ValidationError) with context
   * - Missing/empty domain_index returns null (no cycle data yet)
   */
  private async fetchCurrentCycle(): Promise<number | null> {
    if (this.currentCycle !== null) {
      return this.currentCycle;
    }

    try {
      const data = await this.client.query<{
        artifact: { content: string | null } | null;
      }>(
        `query GetDomainIndex($codebaseId: ID) {
          artifact(id: "domain_index", codebaseId: $codebaseId) {
            content
          }
        }`,
        { codebaseId: this.codebaseId }
      );

      if (data.artifact?.content) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data.artifact.content) as Record<string, unknown>;
        } catch {
          throw new StorageAdapterError(
            "Failed to parse domain_index content as JSON",
            "PARSE_ERROR",
            { artifactId: "domain_index", field: "content" }
          );
        }
        const cycle = typeof parsed.current_cycle === "number" ? parsed.current_cycle : null;
        this.currentCycle = cycle;
        return cycle;
      }
    } catch (err) {
      // DECISION (WI-656): Remove silent fallback to cycle 1
      // Rationale: Silent fallbacks hide errors and make debugging difficult.
      // Explicit errors allow callers to handle failures appropriately per P-58/P-002.
      // Re-throw StorageAdapterError (e.g., PARSE_ERROR) for proper handling upstream
      if (err instanceof StorageAdapterError) {
        throw err;
      }
      // Wrap other errors (GraphQL errors, network issues) with a plain Error
      throw new Error("Failed to fetch current cycle: " + String(err));
    }
    // No artifact or empty content - return null (no cycle data yet)
    return null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // Validate connection by issuing a lightweight query
    try {
      await this.client.query<{ nextId: string }>(
        `query Ping { nextId(type: WORK_ITEM) }`
      );
    } catch (err) {
      if (err instanceof ConnectionError) {
        throw err;
      }
      // Handle authentication failures (401) - convert to ConnectionError
      if (err instanceof Error && err.message.includes("401")) {
        throw new ConnectionError(
          `Authentication failed: GraphQL endpoint ${this.endpoint} returned 401 Unauthorized`
        );
      }
      throw new ConnectionError(
        `Failed to initialize remote adapter: could not reach GraphQL endpoint ${this.endpoint}`,
        err instanceof Error ? err : undefined
      );
    }
  }

  async shutdown(): Promise<void> {
    // No persistent connection to close with fetch-based client
  }

  // -------------------------------------------------------------------------
  // Node CRUD
  // -------------------------------------------------------------------------

  async getNode(id: string): Promise<Node | null> {
    const data = await this.client.query<{
      artifact: GqlArtifactNode | null;
    }>(
      `query GetNode($id: ID!, $codebaseId: ID) {
        artifact(id: $id, codebaseId: $codebaseId) {
          ${ARTIFACT_NODE_FIELDS_WITH_CONTENT}
        }
      }`,
      { id, codebaseId: this.codebaseId }
    );

    if (!data.artifact) return null;
    const node = mapGqlNodeToNode(data.artifact);

    // Apply current cycle as cycle_modified default (matches LocalAdapter behavior)
    if (node.cycle_modified === null) {
      node.cycle_modified = await this.fetchCurrentCycle();
    }

    return node;
  }

  async getNodes(ids: string[]): Promise<Map<string, Node>> {
    if (ids.length === 0) return new Map();

    const data = await this.client.query<{
      artifacts: GqlArtifactNode[];
    }>(
      `query GetNodes($ids: [ID!]!, $codebaseId: ID) {
        artifacts(ids: $ids, codebaseId: $codebaseId) {
          ${ARTIFACT_NODE_FIELDS_WITH_CONTENT}
        }
      }`,
      { ids, codebaseId: this.codebaseId }
    );

    const result = new Map<string, Node>();
    const currentCycle = await this.fetchCurrentCycle();
    for (const gql of data.artifacts) {
      const node = mapGqlNodeToNode(gql);
      // Apply current cycle as cycle_modified default (matches LocalAdapter behavior)
      if (node.cycle_modified === null) {
        node.cycle_modified = currentCycle;
      }
      result.set(node.id, node);
    }
    return result;
  }

  async readNodeContent(id: string): Promise<string> {
    const data = await this.client.query<{
      artifact: { content: string | null } | null;
    }>(
      `query ReadNodeContent($id: ID!, $codebaseId: ID) {
        artifact(id: $id, codebaseId: $codebaseId) {
          content
        }
      }`,
      { id, codebaseId: this.codebaseId }
    );

    return data.artifact?.content ?? "";
  }

  async putNode(input: MutateNodeInput): Promise<MutateNodeResult> {
    let data: { putNode: { id: string; status: string } };
    try {
      // Fetch current cycle and include cycle_modified in properties (matches LocalAdapter behavior)
      const currentCycle = await this.fetchCurrentCycle();
      const propertiesWithCycle = {
        ...input.properties,
        ...(currentCycle !== null ? { cycle_modified: currentCycle } : {}),
      };
      data = await this.client.mutate<{
        putNode: { id: string; status: string };
      }>(
        `mutation PutNode($input: MutateNodeInput!) {
          putNode(input: $input) {
            id
            status
          }
        }`,
        {
          input: {
            id: input.id,
            type: toGraphQLEnum(input.type),
            properties: propertiesWithCycle,
            cycle: input.cycle,
            codebaseId: this.codebaseId,
          },
        }
      );
    } catch (err) {
      if (err instanceof StorageAdapterError) {
        throw err;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Transport error in putNode: ${errorMessage}`,
        "TRANSACTION_FAILED",
        { id: input.id }
      );
    }

    return {
      id: data.putNode.id,
      status: fromGraphQLEnum(data.putNode.status) as "created" | "updated",
    };
  }

  async patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult> {
    let data: { patchNode: { id: string; status: string } };
    try {
      // Fetch current cycle and include cycle_modified in properties (matches LocalAdapter behavior)
      const currentCycle = await this.fetchCurrentCycle();
      const propertiesWithCycle = {
        ...input.properties,
        ...(currentCycle !== null ? { cycle_modified: currentCycle } : {}),
      };
      data = await this.client.mutate<{
        patchNode: { id: string; status: string };
      }>(
        `mutation PatchNode($input: UpdateNodeInput!) {
          patchNode(input: $input) {
            id
            status
          }
        }`,
        {
          input: {
            id: input.id,
            properties: propertiesWithCycle,
          },
        }
      );
    } catch (err) {
      if (err instanceof StorageAdapterError) {
        throw err;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Transport error in patchNode: ${errorMessage}`,
        "TRANSACTION_FAILED",
        { id: input.id }
      );
    }

    return {
      id: data.patchNode.id,
      status: fromGraphQLEnum(data.patchNode.status) as "updated" | "not_found",
    };
  }

  async deleteNode(id: string): Promise<DeleteNodeResult> {
    let data: { deleteNode: { id: string; status: string } };
    try {
      data = await this.client.mutate<{
        deleteNode: { id: string; status: string };
      }>(
        `mutation DeleteNode($id: ID!) {
          deleteNode(id: $id) {
            id
            status
          }
        }`,
        { id }
      );
    } catch (err) {
      if (err instanceof StorageAdapterError) {
        throw err;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Transport error in deleteNode: ${errorMessage}`,
        "TRANSACTION_FAILED",
        { id }
      );
    }

    return {
      id: data.deleteNode.id,
      status: fromGraphQLEnum(data.deleteNode.status) as "deleted" | "not_found",
    };
  }

  // -------------------------------------------------------------------------
  // Edge CRUD
  // -------------------------------------------------------------------------

  async putEdge(edge: Edge): Promise<void> {
    try {
      await this.client.mutate<{ putEdge: boolean }>(
        `mutation PutEdge($input: EdgeInput!) {
          putEdge(input: $input)
        }`,
        {
          input: {
            sourceId: edge.source_id,
            targetId: edge.target_id,
            edgeType: toGraphQLEnum(edge.edge_type),
            properties: edge.properties,
          },
        }
      );
    } catch (err) {
      if (err instanceof StorageAdapterError) {
        throw err;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Transport error in putEdge: ${errorMessage}`,
        "TRANSACTION_FAILED",
        { source_id: edge.source_id, target_id: edge.target_id, edge_type: edge.edge_type }
      );
    }
  }

  async removeEdges(
    source_id: string,
    edge_types: EdgeType[]
  ): Promise<void> {
    if (edge_types.length === 0) return;
    try {
      await this.client.mutate<{ removeEdges: boolean }>(
        `mutation RemoveEdges($sourceId: ID!, $edgeTypes: [EdgeType!]!) {
          removeEdges(sourceId: $sourceId, edgeTypes: $edgeTypes)
        }`,
        {
          sourceId: source_id,
          edgeTypes: edge_types.map(toGraphQLEnum),
        }
      );
    } catch (err) {
      if (err instanceof StorageAdapterError) {
        throw err;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Transport error in removeEdges: ${errorMessage}`,
        "TRANSACTION_FAILED",
        { source_id, edge_types }
      );
    }
  }

  async getEdges(
    id: string,
    direction: "outgoing" | "incoming" | "both"
  ): Promise<Edge[]> {
    const data = await this.client.query<{
      artifact: {
        edges: Array<{
          sourceId: string;
          targetId: string;
          edgeType: string;
          properties: unknown;
        }>;
      } | null;
    }>(
      `query GetEdges($id: ID!, $direction: EdgeDirection!, $codebaseId: ID) {
        artifact(id: $id, codebaseId: $codebaseId) {
          edges(direction: $direction) {
            sourceId
            targetId
            edgeType
            properties
          }
        }
      }`,
      {
        id,
        direction: toGraphQLEnum(direction),
        codebaseId: this.codebaseId,
      }
    );

    if (!data.artifact) return [];
    return data.artifact.edges.map(mapGqlEdge);
  }

  // -------------------------------------------------------------------------
  // Graph traversal
  // -------------------------------------------------------------------------

  // AC-6: traverse mapped to assembleContext query with PPR delegation to server
  async traverse(options: TraversalOptions): Promise<TraversalResult> {
    const input: Record<string, unknown> = {
      seedIds: options.seed_ids,
    };
    if (options.alpha !== undefined) input.alpha = options.alpha;
    if (options.max_iterations !== undefined) input.maxIterations = options.max_iterations;
    if (options.convergence_threshold !== undefined)
      input.convergenceThreshold = options.convergence_threshold;
    if (options.edge_type_weights !== undefined) {
      // Convert edge type weight keys to UPPER_SNAKE_CASE for GraphQL
      const mapped: Record<string, number> = {};
      for (const [key, value] of Object.entries(options.edge_type_weights)) {
        mapped[toGraphQLEnum(key)] = value;
      }
      input.edgeTypeWeights = mapped;
    }
    if (options.token_budget !== undefined) input.tokenBudget = options.token_budget;
    if (options.always_include_types !== undefined)
      input.alwaysIncludeTypes = options.always_include_types.map(toGraphQLEnum);
    if (options.max_nodes !== undefined) input.maxNodes = options.max_nodes;

    const data = await this.client.query<{
      assembleContext: {
        rankedNodes: Array<{
          node: GqlArtifactNode;
          score: number;
          content: string;
        }>;
        totalTokens: number;
        pprScores: Array<{ id: string; score: number }>;
      };
    }>(
      `query AssembleContext($input: TraversalInput!) {
        assembleContext(input: $input) {
          rankedNodes {
            node {
              ${ARTIFACT_NODE_FIELDS}
            }
            score
            content
          }
          totalTokens
          pprScores {
            id
            score
          }
        }
      }`,
      { input }
    );

    let rankedNodes = data.assembleContext.rankedNodes.map((rn) => ({
      node: mapGqlNodeToNode(rn.node),
      score: rn.score,
      content: rn.content,
    }));

    // Apply max_nodes as a result-count cap per adapter contract
    if (options.max_nodes != null && options.max_nodes > 0 && rankedNodes.length > options.max_nodes) {
      rankedNodes = rankedNodes.slice(0, options.max_nodes);
    }

    // Apply token_budget enforcement client-side (WI-639, WI-787)
    // Matches LocalAdapter behavior in context.ts:
    //   - Seeds are always included (even if they exceed budget)
    //   - Non-seed ranked nodes (including always_include_types) are
    //     budget-gated: dropped when they would bust the budget
    //   - token_budget=0 means zero budget (only seeds are force-included)
    //   - truncated_types records NodeTypes dropped from always_include_types
    //     so callers can detect incomplete context (WI-787)
    let totalTokens = data.assembleContext.totalTokens;
    let budgetExhausted = false;
    const truncatedTypeSet = new Set<NodeType>();
    const alwaysIncludeTypeSet = new Set<NodeType>(
      options.always_include_types ?? []
    );

    if (options.token_budget !== undefined && options.token_budget >= 0) {
      const budget = options.token_budget;
      const seedSet = new Set(options.seed_ids);
      let accumulatedTokens = 0;
      const withinBudget: typeof rankedNodes = [];

      for (const rn of rankedNodes) {
        const nodeTokens = rn.node.token_count ?? 0;
        const isSeed = seedSet.has(rn.node.id);

        if (isSeed) {
          // Seeds are always included (force-include, even if exceeds budget)
          accumulatedTokens += nodeTokens;
          withinBudget.push(rn);
        } else if (accumulatedTokens + nodeTokens <= budget) {
          // Non-seeds: include if within budget
          accumulatedTokens += nodeTokens;
          withinBudget.push(rn);
        } else {
          // Budget exhausted for non-seeds - skip. Track which always-include
          // types were truncated so callers can signal incomplete context.
          budgetExhausted = true;
          const nodeType = rn.node.type as NodeType;
          if (alwaysIncludeTypeSet.has(nodeType)) {
            truncatedTypeSet.add(nodeType);
          }
          continue;
        }
      }

      rankedNodes = withinBudget;
      totalTokens = accumulatedTokens;
    }

    const result: TraversalResult = {
      ranked_nodes: rankedNodes,
      total_tokens: totalTokens,
      ppr_scores: data.assembleContext.pprScores,
    };
    if (budgetExhausted) result.budget_exhausted = true;
    if (truncatedTypeSet.size > 0) {
      result.truncated_types = Array.from(truncatedTypeSet);
    }
    return result;
  }

  async queryGraph(
    query: GraphQuery,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    const gqlQuery: Record<string, unknown> = {
      originId: query.origin_id,
    };
    if (query.depth !== undefined) gqlQuery.depth = query.depth;
    if (query.direction) gqlQuery.direction = toGraphQLEnum(query.direction);
    if (query.edge_types)
      gqlQuery.edgeTypes = query.edge_types.map(toGraphQLEnum);
    if (query.type_filter) gqlQuery.typeFilter = toGraphQLEnum(query.type_filter);
    if (query.filters) gqlQuery.filters = buildFilterInput(query.filters);

    // Build the variables object with proper null handling for optional parameters
    const variables: Record<string, unknown> = {
      query: gqlQuery,
      first: limit,
    };

    // Encode offset as a cursor string for pagination only if offset > 0
    if (offset > 0) {
      variables.after = Buffer.from(String(offset - 1)).toString("base64");
    }

    const data = await this.client.query<{
      graphQuery: {
        nodes: Array<{
          node: GqlArtifactNode;
          summary: string;
          edgeType: string | null;
          direction: string | null;
          depth: number | null;
        }>;
        totalCount: number;
      };
    }>(
      `query GraphQuery($query: GraphQueryInput!, $first: Int, $after: String) {
        graphQuery(query: $query, first: $first, after: $after) {
          nodes {
            node {
              ${ARTIFACT_NODE_FIELDS}
            }
            summary
            edgeType
            direction
            depth
          }
          totalCount
        }
      }`,
      variables
    );

    return {
      nodes: data.graphQuery.nodes.map((n) => ({
        node: mapGqlNodeToMeta(n.node),
        summary: n.summary,
        edge_type: n.edgeType
          ? (fromGraphQLEnum(n.edgeType) as EdgeType)
          : undefined,
        direction: n.direction
          ? (fromGraphQLEnum(n.direction) as "outgoing" | "incoming")
          : undefined,
        depth: n.depth ?? undefined,
      })),
      total_count: data.graphQuery.totalCount,
    };
  }

  // -------------------------------------------------------------------------
  // Filtered queries
  // -------------------------------------------------------------------------

  async queryNodes(
    filter: NodeFilter,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    const data = await this.client.query<{
      artifactQuery: {
        edges: Array<{
          node: GqlArtifactNode & { content?: string };
        }>;
        pageInfo: {
          totalCount: number;
        };
      };
    }>(
      `query QueryNodes($filter: NodeFilterInput, $first: Int, $offset: Int) {
        artifactQuery(filter: $filter, first: $first, offset: $offset) {
          edges {
            node {
              ${ARTIFACT_NODE_FIELDS}
            }
          }
          pageInfo {
            totalCount
          }
        }
      }`,
      {
        filter: buildFilterInput(filter),
        first: limit,
        offset: offset > 0 ? offset : undefined,
      }
    );

    return {
      nodes: data.artifactQuery.edges.map((e) => ({
        node: mapGqlNodeToMeta(e.node),
        summary: "", // Summary is derived server-side in graphQuery; for filter queries we return empty
      })),
      total_count: data.artifactQuery.pageInfo.totalCount,
    };
  }

  async nextId(type: NodeType, cycle?: number): Promise<string> {
    const data = await this.client.query<{ nextId: string }>(
      `query NextId($type: NodeType!, $cycle: Int) {
        nextId(type: $type, cycle: $cycle)
      }`,
      {
        type: toGraphQLEnum(type),
        cycle,
      }
    );

    return data.nextId;
  }

  // -------------------------------------------------------------------------
  // Batch operations
  // -------------------------------------------------------------------------

  async batchMutate(input: BatchMutateInput): Promise<BatchMutateResult> {
    const gqlInput: Record<string, unknown> = {
      nodes: input.nodes.map((n) => ({
        id: n.id,
        type: toGraphQLEnum(n.type),
        properties: n.properties,
        cycle: n.cycle,
        codebaseId: this.codebaseId,
      })),
    };

    if (input.edges) {
      gqlInput.edges = input.edges.map((e) => ({
        sourceId: e.source_id,
        targetId: e.target_id,
        edgeType: toGraphQLEnum(e.edge_type),
        properties: e.properties,
      }));
    }

    const data = await this.client.mutate<{
      batchMutate: {
        results: Array<{ id: string; status: string }>;
        errors: Array<{ id: string | null; error: string; code: string }>;
      };
    }>(
      `mutation BatchMutate($input: BatchMutateInput!) {
        batchMutate(input: $input) {
          results {
            id
            status
          }
          errors {
            id
            error
            code
          }
        }
      }`,
      { input: gqlInput }
    );

    return {
      results: data.batchMutate.results.map((r) => ({
        id: r.id,
        status: fromGraphQLEnum(r.status) as "created" | "updated",
      })),
      errors: data.batchMutate.errors.map((e) => ({
        id: e.id ?? "",
        error: e.error,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Aggregation queries
  // -------------------------------------------------------------------------

  async countNodes(
    filter: NodeFilter,
    group_by: "status" | "type" | "domain" | "severity"
  ): Promise<Array<{ key: string; count: number }>> {
    const data = await this.client.query<{
      nodeCounts: Array<{ key: string; count: number }>;
    }>(
      `query CountNodes($filter: NodeFilterInput, $groupBy: GroupByDimension!) {
        nodeCounts(filter: $filter, groupBy: $groupBy) {
          key
          count
        }
      }`,
      {
        filter: buildFilterInput(filter),
        groupBy: toGraphQLEnum(group_by),
      }
    );

    // Normalize status keys to lowercase to match LocalAdapter behavior.
    // GraphQL returns UPPER_SNAKE_CASE enum values (e.g., DONE, OBSOLETE),
    // but LocalAdapter uses lowercase (e.g., done, obsolete).
    if (group_by === "status") {
      const result = data.nodeCounts.map((item) => ({
        key: fromGraphQLEnum(item.key),
        count: item.count,
      }));

      // The server excludes nodes without status (WHERE rawKey IS NOT NULL).
      // LocalAdapter groups these as "unknown", so we need to query for them
      // separately and add to the result.
      const unknownCount = await this._countNodesWithoutStatus(filter);
      if (unknownCount > 0) {
        result.push({ key: "unknown", count: unknownCount });
      }

      return result;
    }

    return data.nodeCounts;
  }

  /**
   * Count nodes that don't have a status property set.
   * The server's nodeCounts query excludes these (WHERE rawKey IS NOT NULL),
   * but LocalAdapter counts them as "unknown".
   */
  private async _countNodesWithoutStatus(filter: NodeFilter): Promise<number> {
    // Query directly using artifactQuery to bypass the implicit statusNotIn filter
    // that buildFilterInput adds for work_item queries. We need all nodes including
    // those with null status to match LocalAdapter behavior.
    try {
      // Build filter input manually to avoid the implicit statusNotIn filter
      const filterInput: Record<string, unknown> = {};
      if (filter.type) filterInput.type = toGraphQLEnum(filter.type);
      if (filter.domain) filterInput.domain = filter.domain;
      if (filter.cycle !== undefined) filterInput.cycle = filter.cycle;
      if (filter.severity) filterInput.severity = filter.severity;
      if (filter.phase) filterInput.phase = filter.phase;

      // Build the query - if no filters, don't pass filter variable
      // Note: codebaseId comes from headers (this.codebaseId), not query variables
      const hasFilters = Object.keys(filterInput).length > 0;
      const query = hasFilters
        ? `query GetAllNodesForStatusCount($filter: NodeFilterInput) {
          artifactQuery(filter: $filter, first: 10000) {
            edges {
              node {
                status
              }
            }
          }
        }`
        : `query GetAllNodesForStatusCount {
          artifactQuery(first: 10000) {
            edges {
              node {
                status
              }
            }
          }
        }`;
      const variables = hasFilters ? { filter: filterInput } : {};

      const data = await this.client.query<{
        artifactQuery: {
          edges: Array<{
            node: {
              status: string | null;
            };
          }>;
        };
      }>(query, variables);

      // Count nodes where status is null
      return data.artifactQuery.edges.filter((edge) => edge.node.status === null).length;
    } catch (err) {
      log.error("remote", "_countNodesWithoutStatus failed", err);
      return 0;
    }
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
    const data = await this.client.query<{
      domainState: Array<{
        domain: string;
        policies: Array<{ id: string; description: string | null; status: string | null }>;
        decisions: Array<{ id: string; description: string | null; status: string | null }>;
        questions: Array<{ id: string; description: string | null; status: string | null }>;
      }>;
    }>(
      `query DomainState($domains: [String!]) {
        domainState(domains: $domains) {
          domain
          policies { id description status }
          decisions { id description status }
          questions { id description status }
        }
      }`,
      { domains }
    );

    const result = new Map<
      string,
      {
        policies: Array<{ id: string; description: string | null; status: string | null }>;
        decisions: Array<{ id: string; description: string | null; status: string | null }>;
        questions: Array<{ id: string; description: string | null; status: string | null }>;
      }
    >();

    for (const ds of data.domainState) {
      result.set(ds.domain, {
        policies: ds.policies,
        decisions: ds.decisions,
        questions: ds.questions,
      });
    }

    return result;
  }

  async getConvergenceData(cycle: number): Promise<{
    findings_by_severity: Record<string, number>;
    cycle_summary_content: string | null;
  }> {
    const data = await this.client.query<{
      convergenceStatus: {
        findingsBySeverity: Array<{ key: string; count: number }>;
        cycleSummaryContent: string | null;
      };
    }>(
      `query ConvergenceStatus($cycleNumber: Int!) {
        convergenceStatus(cycleNumber: $cycleNumber) {
          findingsBySeverity { key count }
          cycleSummaryContent
        }
      }`,
      { cycleNumber: cycle }
    );

    const findings_by_severity: Record<string, number> = {};
    for (const gc of data.convergenceStatus.findingsBySeverity) {
      findings_by_severity[gc.key] = gc.count;
    }

    // Parse the content JSON blob to extract inner content field (S8 fix)
    let cycle_summary_content: string | null = null;
    const rawContent = data.convergenceStatus.cycleSummaryContent;
    if (rawContent != null) {
      try {
        const parsed = JSON.parse(rawContent) as Record<string, unknown>;
        cycle_summary_content = typeof parsed.content === 'string' ? parsed.content : rawContent;
      } catch {
        // Not valid JSON, use raw content
        cycle_summary_content = rawContent;
      }
    }

    return {
      findings_by_severity,
      cycle_summary_content,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle operations
  // -------------------------------------------------------------------------

  // AC-5: archiveCycle mapped to archiveCycle mutation returning string
  async archiveCycle(cycle: number): Promise<string> {
    const data = await this.client.mutate<{
      archiveCycle: string;
    }>(
      `mutation ArchiveCycle($cycleNumber: Int!) {
        archiveCycle(cycleNumber: $cycleNumber)
      }`,
      { cycleNumber: cycle }
    );

    return data.archiveCycle;
  }

  // AC-4: appendJournalEntry mapped to appendJournal mutation
  async appendJournalEntry(args: {
    skill: string;
    date: string;
    entryType: string;
    body: string;
    cycle: number;
  }): Promise<string> {
    let data: { appendJournal: { id: string; status: string } };
    try {
      data = await this.client.mutate<{
        appendJournal: { id: string; status: string };
      }>(
        `mutation AppendJournal($input: JournalEntryInput!) {
          appendJournal(input: $input) {
            id
            status
          }
        }`,
        {
          input: {
            skill: args.skill,
            date: args.date,
            entryType: args.entryType,
            body: args.body,
            cycle: args.cycle,
          },
        }
      );
    } catch (err) {
      if (err instanceof StorageAdapterError) {
        throw err;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Transport error in appendJournalEntry: ${errorMessage}`,
        "TRANSACTION_FAILED",
        { skill: args.skill, cycle: args.cycle }
      );
    }

    return data.appendJournal.id;
  }
}
