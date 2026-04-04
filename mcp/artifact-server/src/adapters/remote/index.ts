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

import { ConnectionError } from "../../adapter.js";
import { GraphQLClient } from "./client.js";

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

/** Map a GraphQL ArtifactNode response to a StorageAdapter Node. */
function mapGqlNodeToNode(gql: GqlArtifactNode): Node {
  // Extract known metadata fields, everything else goes into properties
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
    ...rest
  } = gql;

  // Reconstruct properties from the serialized content field.
  // The server stores JSON.stringify(input.properties) as content, so parsing
  // it gives us the original property bag (name, title, description, etc.).
  let properties: Record<string, unknown> = rest as Record<string, unknown>;
  if (typeof content === "string" && content.length > 0) {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        properties = { ...properties, ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // content may not be valid JSON — fall back to rest
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
  return input;
}

// ---------------------------------------------------------------------------
// RemoteAdapter
// ---------------------------------------------------------------------------

export class RemoteAdapter implements StorageAdapter {
  private client: GraphQLClient;
  private codebaseId: string;

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

    this.client = new GraphQLClient(config.endpoint, headers);
    this.codebaseId = config.codebase_id;
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
      throw new ConnectionError(
        "Failed to initialize remote adapter: could not reach GraphQL endpoint",
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
    return mapGqlNodeToNode(data.artifact);
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
    for (const gql of data.artifacts) {
      const node = mapGqlNodeToNode(gql);
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
    const data = await this.client.mutate<{
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
          properties: input.properties,
          cycle: input.cycle,
          codebaseId: this.codebaseId,
        },
      }
    );

    return {
      id: data.putNode.id,
      status: fromGraphQLEnum(data.putNode.status) as "created" | "updated",
    };
  }

  async patchNode(input: UpdateNodeInput): Promise<UpdateNodeResult> {
    const data = await this.client.mutate<{
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
          properties: input.properties,
        },
      }
    );

    return {
      id: data.patchNode.id,
      status: fromGraphQLEnum(data.patchNode.status) as "updated" | "not_found",
    };
  }

  async deleteNode(id: string): Promise<DeleteNodeResult> {
    const data = await this.client.mutate<{
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

    return {
      id: data.deleteNode.id,
      status: fromGraphQLEnum(data.deleteNode.status) as "deleted" | "not_found",
    };
  }

  // -------------------------------------------------------------------------
  // Edge CRUD
  // -------------------------------------------------------------------------

  async putEdge(edge: Edge): Promise<void> {
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
  }

  async removeEdges(
    source_id: string,
    edge_types: EdgeType[]
  ): Promise<void> {
    await this.client.mutate<{ removeEdges: boolean }>(
      `mutation RemoveEdges($sourceId: ID!, $edgeTypes: [EdgeType!]!) {
        removeEdges(sourceId: $sourceId, edgeTypes: $edgeTypes)
      }`,
      {
        sourceId: source_id,
        edgeTypes: edge_types.map(toGraphQLEnum),
      }
    );
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

    return {
      ranked_nodes: data.assembleContext.rankedNodes.map((rn) => ({
        node: mapGqlNodeToNode(rn.node),
        score: rn.score,
        content: rn.content,
      })),
      total_tokens: data.assembleContext.totalTokens,
      ppr_scores: data.assembleContext.pprScores,
    };
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
      {
        query: gqlQuery,
        first: limit,
        // Encode offset as a cursor string for pagination
        after: offset > 0 ? Buffer.from(String(offset - 1)).toString("base64") : undefined,
      }
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

    return data.nodeCounts;
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

    return {
      findings_by_severity,
      cycle_summary_content: data.convergenceStatus.cycleSummaryContent,
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
    const data = await this.client.mutate<{
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

    return data.appendJournal.id;
  }
}
