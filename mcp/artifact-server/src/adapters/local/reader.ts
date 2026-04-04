// adapters/local/reader.ts — LocalAdapter read and query operations
//
// Implements the read/query half of StorageAdapter for local (SQLite + YAML)
// storage.  All SQL is executed synchronously via better-sqlite3; the async
// signatures match the StorageAdapter interface.
//
// Internal helpers mirror the logic in tools/query.ts and tools/analysis.ts so
// that query.ts and analysis.ts tool handlers can delegate to this module
// instead of running raw SQL directly.

import * as fs from "fs";
import * as path from "path";
import type Database from "better-sqlite3";
import type { DrizzleDb } from "../../db-helpers.js";

import type {
  Node,
  NodeMeta,
  NodeType,
  NodeFilter,
  GraphQuery,
  QueryResult,
  Edge,
  EdgeType,
} from "../../adapter.js";

// ---------------------------------------------------------------------------
// Internal row shapes returned from SQLite
// ---------------------------------------------------------------------------

interface NodeRow {
  id: string;
  type: string;
  status: string | null;
  cycle_created: number | null;
  cycle_modified: number | null;
  content_hash: string;
  token_count: number | null;
  file_path: string;
}

interface EdgeRow {
  source_id: string;
  target_id: string;
  edge_type: string;
  props: string | null;
}

// ---------------------------------------------------------------------------
// Extension table metadata (same as tools/query.ts TYPE_EXTENSION_INFO)
// ---------------------------------------------------------------------------

const TYPE_EXTENSION_INFO: Record<
  string,
  { table: string; summaryExpr: string }
> = {
  work_item: {
    table: "work_items",
    summaryExpr: "e.title",
  },
  finding: {
    table: "findings",
    summaryExpr: "e.severity || ' — ' || e.verdict || ' by ' || e.reviewer",
  },
  domain_policy: {
    table: "domain_policies",
    summaryExpr: "e.description",
  },
  domain_decision: {
    table: "domain_decisions",
    summaryExpr: "e.description",
  },
  domain_question: {
    table: "domain_questions",
    summaryExpr: "e.description",
  },
  guiding_principle: {
    table: "guiding_principles",
    summaryExpr: "e.name",
  },
  constraint: {
    table: "constraints",
    summaryExpr: "e.category || ': ' || e.description",
  },
  module_spec: {
    table: "module_specs",
    summaryExpr: "e.name",
  },
  research_finding: {
    table: "research_findings",
    summaryExpr: "e.topic",
  },
  journal_entry: {
    table: "journal_entries",
    summaryExpr: "'[' || e.phase || '] ' || e.title",
  },
  metrics_event: {
    table: "metrics_events",
    summaryExpr: "e.event_name",
  },
  decision_log: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  cycle_summary: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  review_manifest: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  review_output: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  architecture: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  overview: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  execution_strategy: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  guiding_principles: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  constraints: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  research: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  interview: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  interview_question: {
    table: "interview_questions",
    summaryExpr: "e.interview_id || ': ' || e.question",
  },
  domain_index: {
    table: "document_artifacts",
    summaryExpr: "COALESCE(e.title, n.type)",
  },
  proxy_human_decision: {
    table: "proxy_human_decisions",
    summaryExpr: "e.trigger || ' → ' || e.decision || ' [' || e.status || ']'",
  },
  project: {
    table: "projects",
    summaryExpr: "COALESCE(e.name, SUBSTR(e.intent, 1, 40))",
  },
  phase: {
    table: "phases",
    summaryExpr: "COALESCE(e.name, e.phase_type || ': ' || SUBSTR(e.intent, 1, 40))",
  },
};

// ---------------------------------------------------------------------------
// Column presence helpers (mirrors tools/query.ts hasColumn)
// ---------------------------------------------------------------------------

function hasColumn(type: string, column: string): boolean {
  const domainTypes = [
    "domain_policy", "domain_decision", "domain_question", "work_item",
  ];
  const cycleTypes = ["finding", "domain_decision", "proxy_human_decision"];
  const workItemRefTypes = ["finding"];
  const phaseTypes = ["journal_entry", "work_item"];
  const workItemTypeTypes = ["work_item"];

  switch (column) {
    case "domain": return domainTypes.includes(type);
    case "cycle": return cycleTypes.includes(type);
    case "work_item": return workItemRefTypes.includes(type);
    case "phase": return phaseTypes.includes(type);
    case "work_item_type": return workItemTypeTypes.includes(type);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Build Node from raw row + optional extension properties
// ---------------------------------------------------------------------------

function buildNodeMeta(row: NodeRow): NodeMeta {
  return {
    id: row.id,
    type: row.type as NodeType,
    status: row.status,
    cycle_created: row.cycle_created,
    cycle_modified: row.cycle_modified,
    content_hash: row.content_hash,
    token_count: row.token_count,
  };
}

function fetchExtensionProperties(
  db: Database.Database,
  id: string,
  type: string
): Record<string, unknown> {
  const info = TYPE_EXTENSION_INFO[type];
  if (!info) return {};

  const row = db
    .prepare(`SELECT * FROM ${info.table} WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;

  if (!row) return {};

  // Remove the id field from properties (it's already in NodeMeta)
  const { id: _id, ...props } = row;
  return props;
}

// ---------------------------------------------------------------------------
// LocalReaderAdapter class
//
// Only implements the read/query subset of StorageAdapter.  The remaining
// methods (put, patch, delete, putEdge, removeEdges, traverse, batchMutate,
// nextId, initialize, shutdown, archiveCycle) are provided by other modules.
// ---------------------------------------------------------------------------

export class LocalReaderAdapter {
  constructor(
    private readonly db: Database.Database,
    private readonly _drizzleDb: DrizzleDb,
    private readonly ideateDir: string
  ) {}

  // -----------------------------------------------------------------------
  // getNode
  // -----------------------------------------------------------------------

  async getNode(id: string): Promise<Node | null> {
    const row = this.db
      .prepare(
        `SELECT id, type, status, cycle_created, cycle_modified, content_hash, token_count, file_path
         FROM nodes WHERE id = ?`
      )
      .get(id) as NodeRow | undefined;

    if (!row) return null;

    const properties = fetchExtensionProperties(this.db, id, row.type);
    return { ...buildNodeMeta(row), properties };
  }

  // -----------------------------------------------------------------------
  // getNodes
  // -----------------------------------------------------------------------

  async getNodes(ids: string[]): Promise<Map<string, Node>> {
    if (ids.length === 0) return new Map();

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, type, status, cycle_created, cycle_modified, content_hash, token_count, file_path
         FROM nodes WHERE id IN (${placeholders})`
      )
      .all(...ids) as NodeRow[];

    const result = new Map<string, Node>();
    for (const row of rows) {
      const properties = fetchExtensionProperties(this.db, row.id, row.type);
      result.set(row.id, { ...buildNodeMeta(row), properties });
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // readNodeContent — read YAML from file_path
  // -----------------------------------------------------------------------

  async readNodeContent(id: string): Promise<string> {
    const row = this.db
      .prepare(`SELECT file_path FROM nodes WHERE id = ?`)
      .get(id) as { file_path: string } | undefined;

    if (!row) return "";

    try {
      return fs.readFileSync(row.file_path, "utf8");
    } catch {
      return "";
    }
  }

  // -----------------------------------------------------------------------
  // getEdges
  // -----------------------------------------------------------------------

  async getEdges(
    id: string,
    direction: "outgoing" | "incoming" | "both"
  ): Promise<Edge[]> {
    let rows: EdgeRow[];

    if (direction === "outgoing") {
      rows = this.db
        .prepare(
          `SELECT source_id, target_id, edge_type, props FROM edges WHERE source_id = ?`
        )
        .all(id) as EdgeRow[];
    } else if (direction === "incoming") {
      rows = this.db
        .prepare(
          `SELECT source_id, target_id, edge_type, props FROM edges WHERE target_id = ?`
        )
        .all(id) as EdgeRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT source_id, target_id, edge_type, props FROM edges WHERE source_id = ? OR target_id = ?`
        )
        .all(id, id) as EdgeRow[];
    }

    return rows.map((r) => ({
      source_id: r.source_id,
      target_id: r.target_id,
      edge_type: r.edge_type as EdgeType,
      properties: r.props ? (JSON.parse(r.props) as Record<string, unknown>) : {},
    }));
  }

  // -----------------------------------------------------------------------
  // queryNodes — filter mode (mirrors runFilterMode in tools/query.ts)
  // -----------------------------------------------------------------------

  async queryNodes(
    filter: NodeFilter,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    const type = filter.type as string | undefined;
    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (type) {
      whereClauses.push("n.type = ?");
      params.push(type);
    }

    if (filter.status) {
      whereClauses.push("n.status = ?");
      params.push(filter.status);
    } else if (type === "work_item") {
      whereClauses.push(
        "(n.status IS NULL OR (n.status != 'done' AND n.status != 'obsolete'))"
      );
    }

    let summaryExpr = "NULL";
    let extensionJoin = "";

    if (type && TYPE_EXTENSION_INFO[type]) {
      const info = TYPE_EXTENSION_INFO[type];
      summaryExpr = info.summaryExpr;
      extensionJoin = `LEFT JOIN ${info.table} e ON e.id = n.id`;

      if (filter.domain && hasColumn(type, "domain")) {
        whereClauses.push("e.domain = ?");
        params.push(filter.domain);
      }
      if (filter.cycle !== undefined && filter.cycle !== null && hasColumn(type, "cycle")) {
        whereClauses.push("e.cycle = ?");
        params.push(filter.cycle);
      }
      if (filter.severity && type === "finding") {
        whereClauses.push("e.severity = ?");
        params.push(filter.severity);
      }
      if (filter.phase && (type === "journal_entry" || type === "work_item")) {
        whereClauses.push("e.phase = ?");
        params.push(filter.phase);
      }
      if (filter.work_item && hasColumn(type, "work_item")) {
        whereClauses.push("e.work_item = ?");
        params.push(filter.work_item);
      }
      if (filter.work_item_type && hasColumn(type, "work_item_type")) {
        whereClauses.push("e.work_item_type = ?");
        params.push(filter.work_item_type);
      }
    } else if (!type) {
      // No type specified — apply cross-type filters via edges table or
      // subqueries against all extension tables that have the column.
      if (filter.domain) {
        // Filter by domain: node must appear in any extension table with a matching domain column
        whereClauses.push(
          `n.id IN (SELECT id FROM work_items WHERE domain = ? UNION SELECT id FROM domain_policies WHERE domain = ? UNION SELECT id FROM domain_decisions WHERE domain = ? UNION SELECT id FROM domain_questions WHERE domain = ?)`
        );
        params.push(filter.domain, filter.domain, filter.domain, filter.domain);
      }
      if (filter.phase) {
        whereClauses.push(
          `n.id IN (SELECT id FROM work_items WHERE phase = ? UNION SELECT id FROM journal_entries WHERE phase = ?)`
        );
        params.push(filter.phase, filter.phase);
      }
    }

    const whereClause =
      whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

    const countSql = `
      SELECT COUNT(*) as total_count
      FROM nodes n
      ${extensionJoin}
      ${whereClause}
    `;
    const countRow = this.db
      .prepare(countSql)
      .get(...params) as { total_count: number };
    const total_count = countRow.total_count;

    const selectSql = `
      SELECT
        n.id,
        n.type,
        n.status,
        n.cycle_created,
        n.cycle_modified,
        n.content_hash,
        n.token_count,
        SUBSTR(COALESCE(${summaryExpr}, ''), 1, 81) AS summary
      FROM nodes n
      ${extensionJoin}
      ${whereClause}
      ORDER BY n.id
      LIMIT ? OFFSET ?
    `;
    const rows = this.db
      .prepare(selectSql)
      .all(...params, limit, offset) as Array<
      NodeRow & { summary: string | null }
    >;

    const nodes = rows.map((r) => ({
      node: buildNodeMeta(r),
      summary: r.summary ?? "",
    }));

    return { nodes, total_count };
  }

  // -----------------------------------------------------------------------
  // queryGraph — graph traversal mode (mirrors runGraphMode in tools/query.ts)
  // -----------------------------------------------------------------------

  async queryGraph(
    query: GraphQuery,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    const {
      origin_id,
      depth = 1,
      direction = "both",
      edge_types,
      type_filter,
      filters = {},
    } = query;

    // Verify seed node exists
    const seedNode = this.db
      .prepare("SELECT id FROM nodes WHERE id = ?")
      .get(origin_id) as { id: string } | undefined;

    if (!seedNode) {
      const { NotFoundError } = await import("../../adapter.js");
      throw new NotFoundError(origin_id);
    }

    const edgeTypeParams = edge_types ?? [];

    function buildEdgeFilter(alias: string): string {
      if (!edge_types || edge_types.length === 0) return "";
      const placeholders = edge_types.map(() => "?").join(", ");
      return `AND ${alias}.edge_type IN (${placeholders})`;
    }

    let baseSql: string;
    let baseParams: (string | number)[];

    if (depth === 1) {
      const edgeTypeFilter = buildEdgeFilter("e");
      if (direction === "outgoing") {
        baseSql = `
          SELECT n.id AS node_id, n.type, e.edge_type, 'outgoing' AS direction, 1 AS depth, n.status
          FROM edges e
          JOIN nodes n ON n.id = e.target_id
          WHERE e.source_id = ? ${edgeTypeFilter}
        `;
        baseParams = [origin_id, ...edgeTypeParams];
      } else if (direction === "incoming") {
        baseSql = `
          SELECT n.id AS node_id, n.type, e.edge_type, 'incoming' AS direction, 1 AS depth, n.status
          FROM edges e
          JOIN nodes n ON n.id = e.source_id
          WHERE e.target_id = ? ${edgeTypeFilter}
        `;
        baseParams = [origin_id, ...edgeTypeParams];
      } else {
        baseSql = `
          SELECT n.id AS node_id, n.type, e.edge_type, 'outgoing' AS direction, 1 AS depth, n.status
          FROM edges e
          JOIN nodes n ON n.id = e.target_id
          WHERE e.source_id = ? ${edgeTypeFilter}
          UNION
          SELECT n.id AS node_id, n.type, e.edge_type, 'incoming' AS direction, 1 AS depth, n.status
          FROM edges e
          JOIN nodes n ON n.id = e.source_id
          WHERE e.target_id = ? ${edgeTypeFilter}
        `;
        baseParams = [origin_id, ...edgeTypeParams, origin_id, ...edgeTypeParams];
      }
    } else {
      // Recursive CTE for depth > 1
      const edgeTypeFilter = buildEdgeFilter("e");
      const outgoingStep = `
        SELECT e.target_id AS next_id, e.edge_type, 'outgoing' AS direction, t.depth + 1 AS depth
        FROM traversal t
        JOIN edges e ON e.source_id = t.node_id
        ${edgeTypeFilter}
        WHERE t.depth < ?
      `;
      const incomingStep = `
        SELECT e.source_id AS next_id, e.edge_type, 'incoming' AS direction, t.depth + 1 AS depth
        FROM traversal t
        JOIN edges e ON e.target_id = t.node_id
        ${edgeTypeFilter}
        WHERE t.depth < ?
      `;

      let recursiveBody: string;
      if (direction === "outgoing") {
        recursiveBody = `
          SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth
          UNION
          ${outgoingStep}
        `;
        baseParams = [origin_id, ...edgeTypeParams, depth];
      } else if (direction === "incoming") {
        recursiveBody = `
          SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth
          UNION
          ${incomingStep}
        `;
        baseParams = [origin_id, ...edgeTypeParams, depth];
      } else {
        recursiveBody = `
          SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth
          UNION
          ${outgoingStep}
          UNION
          ${incomingStep}
        `;
        baseParams = [origin_id, ...edgeTypeParams, depth, ...edgeTypeParams, depth];
      }

      baseSql = `
        WITH RECURSIVE traversal(node_id, edge_type, direction, depth) AS (
          ${recursiveBody}
        )
        SELECT n.id AS node_id, n.type, t.edge_type, t.direction, t.depth, n.status
        FROM traversal t
        JOIN nodes n ON n.id = t.node_id
        WHERE t.depth > 0
      `;
    }

    // Apply additional filters
    let filteredSql = baseSql;
    const filteredParams = [...baseParams];

    if (type_filter) {
      filteredSql = `SELECT * FROM (${filteredSql}) WHERE type = ?`;
      filteredParams.push(type_filter);
    }
    if (filters.status) {
      filteredSql = `SELECT * FROM (${filteredSql}) WHERE status = ?`;
      filteredParams.push(filters.status);
    }

    // Count total before pagination
    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total_count FROM (${filteredSql})`)
      .get(...filteredParams) as { total_count: number };
    const total_count = countRow.total_count;

    // Paginate
    filteredSql = `${filteredSql} ORDER BY depth, node_id LIMIT ? OFFSET ?`;
    filteredParams.push(limit, offset);

    type RawRow = {
      node_id: string;
      type: string;
      edge_type: string;
      direction: string;
      depth: number;
      status: string | null;
    };

    const rawRows = this.db.prepare(filteredSql).all(...filteredParams) as RawRow[];

    // Fetch summaries for the result rows
    const summaryMap = this._buildSummaryMap(
      rawRows.map((r) => ({ id: r.node_id, type: r.type }))
    );

    const nodes = rawRows.map((r) => {
      // Build a minimal NodeMeta without a full node lookup
      const nodeMeta: NodeMeta = {
        id: r.node_id,
        type: r.type as NodeType,
        status: r.status,
        cycle_created: null,
        cycle_modified: null,
        content_hash: "",
        token_count: null,
      };
      return {
        node: nodeMeta,
        summary: summaryMap[r.node_id] ?? "",
        edge_type: r.edge_type as EdgeType,
        direction: r.direction as "outgoing" | "incoming",
        depth: r.depth,
      };
    });

    return { nodes, total_count };
  }

  // -----------------------------------------------------------------------
  // countNodes — aggregation (mirrors analysis.ts aggregation queries)
  // -----------------------------------------------------------------------

  async countNodes(
    filter: NodeFilter,
    group_by: "status" | "type" | "domain" | "severity"
  ): Promise<Array<{ key: string; count: number }>> {
    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (filter.type) {
      whereClauses.push("n.type = ?");
      params.push(filter.type);
    }
    if (filter.status) {
      whereClauses.push("n.status = ?");
      params.push(filter.status);
    }
    if (filter.cycle !== undefined && filter.cycle !== null) {
      // Cycle lives on extension tables; handled via JOIN when type is known
    }

    const whereClause =
      whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

    let groupExpr: string;
    let joinClause = "";

    switch (group_by) {
      case "status":
        groupExpr = "n.status";
        break;
      case "type":
        groupExpr = "n.type";
        break;
      case "domain": {
        // domain lives on extension tables; use domain_policies/decisions/questions
        // For generic use, fall back to a subquery approach
        if (filter.type && (filter.type.startsWith("domain_") || filter.type === "work_item")) {
          const info = TYPE_EXTENSION_INFO[filter.type];
          joinClause = `LEFT JOIN ${info.table} e ON e.id = n.id`;
          groupExpr = "e.domain";
        } else {
          groupExpr = "'unknown'";
        }
        break;
      }
      case "severity": {
        if (filter.type === "finding") {
          joinClause = "LEFT JOIN findings e ON e.id = n.id";
          groupExpr = "e.severity";
          if (filter.cycle !== undefined && filter.cycle !== null) {
            whereClauses.push("e.cycle = ?");
            params.push(filter.cycle);
          }
        } else {
          groupExpr = "'unknown'";
        }
        break;
      }
    }

    const finalWhere =
      whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

    const sql = `
      SELECT ${groupExpr} AS key, COUNT(*) AS count
      FROM nodes n
      ${joinClause}
      ${finalWhere}
      GROUP BY ${groupExpr}
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<{
      key: string | null;
      count: number;
    }>;

    return rows.map((r) => ({ key: r.key ?? "unknown", count: r.count }));
  }

  // -----------------------------------------------------------------------
  // getDomainState — mirrors handleGetDomainState in tools/analysis.ts
  // -----------------------------------------------------------------------

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
    const allPolicies = this.db
      .prepare(
        `SELECT dp.id, dp.domain, dp.description, n.status
         FROM domain_policies dp
         JOIN nodes n ON n.id = dp.id
         WHERE (n.status IS NULL OR (n.status != 'deprecated' AND n.status != 'superseded'))
         ORDER BY dp.domain, dp.id`
      )
      .all() as Array<{ id: string; domain: string; description: string | null; status: string | null }>;

    const allDecisions = this.db
      .prepare(
        `SELECT dd.id, dd.domain, dd.description, n.status
         FROM domain_decisions dd
         JOIN nodes n ON n.id = dd.id
         ORDER BY dd.domain, dd.id`
      )
      .all() as Array<{ id: string; domain: string; description: string | null; status: string | null }>;

    const allQuestions = this.db
      .prepare(
        `SELECT dq.id, dq.domain, dq.description, n.status
         FROM domain_questions dq
         JOIN nodes n ON n.id = dq.id
         WHERE n.status = 'open'
         ORDER BY dq.domain, dq.id`
      )
      .all() as Array<{ id: string; domain: string; description: string | null; status: string | null }>;

    const domainSet = new Set<string>([
      ...allPolicies.map((p) => p.domain),
      ...allDecisions.map((d) => d.domain),
      ...allQuestions.map((q) => q.domain),
    ]);

    let domainList = Array.from(domainSet).sort();
    if (domains && domains.length > 0) {
      domainList = domainList.filter((d) => domains.includes(d));
    }

    const result = new Map<
      string,
      {
        policies: Array<{ id: string; description: string | null; status: string | null }>;
        decisions: Array<{ id: string; description: string | null; status: string | null }>;
        questions: Array<{ id: string; description: string | null; status: string | null }>;
      }
    >();

    for (const domain of domainList) {
      result.set(domain, {
        policies: allPolicies
          .filter((p) => p.domain === domain)
          .map(({ id, description, status }) => ({ id, description, status })),
        decisions: allDecisions
          .filter((d) => d.domain === domain)
          .map(({ id, description, status }) => ({ id, description, status })),
        questions: allQuestions
          .filter((q) => q.domain === domain)
          .map(({ id, description, status }) => ({ id, description, status })),
      });
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // getConvergenceData — mirrors handleGetConvergenceStatus in tools/analysis.ts
  // -----------------------------------------------------------------------

  async getConvergenceData(cycle: number): Promise<{
    findings_by_severity: Record<string, number>;
    cycle_summary_content: string | null;
  }> {
    // Get per-severity finding counts for this cycle
    const severityRows = this.db
      .prepare(
        `SELECT severity, COUNT(*) as count FROM findings WHERE cycle = ? GROUP BY severity`
      )
      .all(cycle) as Array<{ severity: string; count: number }>;

    const findings_by_severity: Record<string, number> = {};
    for (const row of severityRows) {
      findings_by_severity[row.severity] = row.count;
    }

    // Retrieve cycle_summary content
    const paddedCycle = String(cycle).padStart(3, "0");
    const likePattern = `%/cycles/${paddedCycle}/%`;

    type RawRow = { id: string; file_path: string; da_content: string | null };
    const summaryRows = this.db
      .prepare(
        `SELECT n.id, n.file_path, da.content AS da_content
         FROM nodes n
         LEFT JOIN document_artifacts da ON n.id = da.id
         WHERE n.type = 'cycle_summary'
           AND (
             da.cycle = ?
             OR (da.id IS NULL AND n.file_path LIKE ?)
             OR (da.id IS NOT NULL AND da.cycle IS NULL AND n.file_path LIKE ?)
           )`
      )
      .all(cycle, likePattern, likePattern) as RawRow[];

    // Prefer adherence row, fall back to summary row
    const adherenceRow =
      summaryRows.find((r) => r.id.toUpperCase().startsWith("SA-")) ??
      summaryRows.find((r) => r.id.toLowerCase().includes("adherence"));
    const summaryRow =
      summaryRows.find(
        (r) =>
          r.id.toUpperCase().startsWith("CS-") ||
          r.id.toLowerCase().includes("summary")
      ) ?? summaryRows[0];

    const targetRow = adherenceRow ?? summaryRow;
    let cycle_summary_content: string | null = null;

    if (targetRow) {
      if (targetRow.da_content !== null && targetRow.da_content !== undefined) {
        try {
          const parsed = JSON.parse(targetRow.da_content) as Record<string, unknown>;
          if (parsed && typeof parsed.content === "string") {
            cycle_summary_content = parsed.content;
          } else {
            cycle_summary_content = targetRow.da_content;
          }
        } catch {
          cycle_summary_content = targetRow.da_content;
        }
      } else {
        try {
          cycle_summary_content = fs.readFileSync(targetRow.file_path, "utf8");
        } catch {
          cycle_summary_content = null;
        }
      }
    }

    return { findings_by_severity, cycle_summary_content };
  }

  // -----------------------------------------------------------------------
  // nextId — generate next ID for a given node type
  // -----------------------------------------------------------------------

  async nextId(type: NodeType, cycle?: number): Promise<string> {
    const TYPE_PREFIX_MAP: Record<string, { prefix: string; padWidth: number }> = {
      work_item: { prefix: "WI-", padWidth: 3 },
      guiding_principle: { prefix: "GP-", padWidth: 2 },
      constraint: { prefix: "C-", padWidth: 2 },
      domain_policy: { prefix: "P-", padWidth: 2 },
      domain_decision: { prefix: "D-", padWidth: 2 },
      domain_question: { prefix: "Q-", padWidth: 2 },
      proxy_human_decision: { prefix: "PHD-", padWidth: 2 },
      project: { prefix: "PR-", padWidth: 3 },
      phase: { prefix: "PH-", padWidth: 3 },
    };

    const CYCLE_SCOPED_ID_TYPES = ["proxy_human_decision"];

    const mapping = TYPE_PREFIX_MAP[type];
    if (!mapping) {
      throw new Error(`Unknown type '${type}' for ID generation`);
    }

    const { prefix, padWidth } = mapping;

    if (CYCLE_SCOPED_ID_TYPES.includes(type)) {
      if (cycle === undefined) {
        throw new Error(`Parameter 'cycle' is required for type '${type}'`);
      }
      const paddedCycle = String(cycle).padStart(3, "0");
      const pattern = `${prefix}${paddedCycle}-%`;
      const row = this.db
        .prepare(
          `SELECT MAX(CAST(SUBSTR(id, ?) AS INTEGER)) as max_num
           FROM nodes WHERE id LIKE ?`
        )
        .get(prefix.length + 4 + 1, pattern) as { max_num: number | null } | undefined;
      const maxNum = row?.max_num ?? 0;
      const nextNum = maxNum + 1;
      return `${prefix}${paddedCycle}-${String(nextNum).padStart(padWidth, "0")}`;
    }

    const row = this.db
      .prepare(
        `SELECT MAX(CAST(SUBSTR(id, LENGTH(?) + 1) AS INTEGER)) as max_num
         FROM nodes WHERE id LIKE ? || '%'`
      )
      .get(prefix, prefix) as { max_num: number | null } | undefined;

    const maxNum = row?.max_num ?? 0;
    const nextNum = maxNum + 1;
    return prefix + String(nextNum).padStart(padWidth, "0");
  }

  // -----------------------------------------------------------------------
  // Internal: build summary map for a list of (id, type) pairs
  // Mirrors buildSummaryMap in tools/query.ts
  // -----------------------------------------------------------------------

  private _buildSummaryMap(items: { id: string; type: string }[]): Record<string, string> {
    if (items.length === 0) return {};

    const byTable: Record<string, { ids: string[]; summaryExpr: string }> = {};

    for (const item of items) {
      const info = TYPE_EXTENSION_INFO[item.type];
      if (!info) continue;
      const key = info.table;
      if (!byTable[key]) {
        byTable[key] = { ids: [], summaryExpr: info.summaryExpr };
      }
      byTable[key].ids.push(item.id);
    }

    const result: Record<string, string> = {};

    for (const [table, { ids, summaryExpr }] of Object.entries(byTable)) {
      const placeholders = ids.map(() => "?").join(", ");
      const sql = `
        SELECT n.id, SUBSTR(COALESCE(${summaryExpr}, ''), 1, 81) AS summary
        FROM nodes n
        LEFT JOIN ${table} e ON e.id = n.id
        WHERE n.id IN (${placeholders})
      `;
      const rows = this.db.prepare(sql).all(...ids) as { id: string; summary: string }[];
      for (const row of rows) {
        result[row.id] = row.summary ?? "";
      }
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // readDomainIndexCycle — read current_cycle from domains/index.yaml or index.md
  // Used by analysis handlers for workspace status cycle display
  // -----------------------------------------------------------------------

  readDomainIndexCycle(): number | null {
    const indexYamlPath = path.join(this.ideateDir, "domains", "index.yaml");
    const indexMdPath = path.join(this.ideateDir, "domains", "index.md");

    let content: string | null = null;
    try {
      content = fs.readFileSync(indexYamlPath, "utf8");
    } catch {
      try {
        content = fs.readFileSync(indexMdPath, "utf8");
      } catch {
        // neither file exists
      }
    }

    if (content === null) return null;
    const match = content.match(/^current_cycle:\s*(\d+)/m);
    return match ? parseInt(match[1], 10) : null;
  }
}
