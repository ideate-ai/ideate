import { ToolContext } from "./index.js";
import { TYPE_TO_EXTENSION_TABLE } from "../db.js";

// ---------------------------------------------------------------------------
// handleGetNextId — return next available ID for an artifact type
// ---------------------------------------------------------------------------

const TYPE_PREFIX_MAP: Record<string, { prefix: string; padWidth: number }> = {
  work_item: { prefix: "WI-", padWidth: 3 },
  guiding_principle: { prefix: "GP-", padWidth: 2 },
  constraint: { prefix: "C-", padWidth: 2 },
  policy: { prefix: "P-", padWidth: 2 },
  decision: { prefix: "D-", padWidth: 2 },
  question: { prefix: "Q-", padWidth: 2 },
};

export async function handleGetNextId(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const type = args.type as string | undefined;

  if (!type) {
    throw new Error("Missing required parameter: type");
  }

  const mapping = TYPE_PREFIX_MAP[type];
  if (!mapping) {
    const validTypes = Object.keys(TYPE_PREFIX_MAP).join(", ");
    throw new Error(`Unknown type '${type}'. Valid types: ${validTypes}`);
  }

  const { prefix, padWidth } = mapping;

  // Query SQLite for max numeric ID matching this prefix
  const row = ctx.db.prepare(
    `SELECT MAX(CAST(REPLACE(id, ?, '') AS INTEGER)) as max_num
     FROM nodes
     WHERE id LIKE ? || '%'`
  ).get(prefix, prefix) as { max_num: number | null } | undefined;

  const maxNum = row?.max_num ?? 0;
  const nextNum = maxNum + 1;
  const nextId = prefix + String(nextNum).padStart(padWidth, "0");

  return nextId;
}

// ---------------------------------------------------------------------------
// Valid artifact types
// ---------------------------------------------------------------------------

const VALID_TYPES = Object.keys(TYPE_TO_EXTENSION_TABLE);

// Maps type → extension table name and summary SQL expression
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
  // Document artifact types all share the same table
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
};

// ---------------------------------------------------------------------------
// Filters that live on extension tables (not nodes)
// ---------------------------------------------------------------------------

interface ParsedFilters {
  domain?: string;
  status?: string;
  cycle?: number;
  severity?: string;
  phase?: string;
  work_item?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string | null | undefined, max = 80): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function markdownTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length))
  );
  const header = "| " + headers.map((h, i) => h.padEnd(widths[i])).join(" | ") + " |";
  const sep = "| " + widths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const body = rows
    .map((r) => "| " + r.map((cell, i) => (cell ?? "").padEnd(widths[i])).join(" | ") + " |")
    .join("\n");
  return [header, sep, body].join("\n");
}

// ---------------------------------------------------------------------------
// Filter mode
// ---------------------------------------------------------------------------

interface FilterModeRow {
  id: string;
  type: string;
  status: string | null;
  summary: string | null;
  domain: string | null;
  cycle: number | null;
  file_path: string;
}

function runFilterMode(
  ctx: ToolContext,
  type: string | undefined,
  filters: ParsedFilters,
  limit: number,
  offset: number
): string {
  const whereClauses: string[] = [];
  const params: (string | number)[] = [];

  if (type) {
    whereClauses.push("n.type = ?");
    params.push(type);
  }

  // status lives on nodes
  if (filters.status) {
    whereClauses.push("n.status = ?");
    params.push(filters.status);
  }

  // Build the summary expression and optional extension JOIN
  let summaryExpr = "NULL";
  let extensionJoin = "";

  if (type && TYPE_EXTENSION_INFO[type]) {
    const info = TYPE_EXTENSION_INFO[type];
    summaryExpr = info.summaryExpr;
    extensionJoin = `LEFT JOIN ${info.table} e ON e.id = n.id`;

    // Apply extension-table filters for the given type
    if (filters.domain && hasColumn(type, "domain")) {
      whereClauses.push("e.domain = ?");
      params.push(filters.domain);
    }
    if (filters.cycle && hasColumn(type, "cycle")) {
      whereClauses.push("e.cycle = ?");
      params.push(filters.cycle);
    }
    if (filters.severity && type === "finding") {
      whereClauses.push("e.severity = ?");
      params.push(filters.severity);
    }
    if (filters.phase && type === "journal_entry") {
      whereClauses.push("e.phase = ?");
      params.push(filters.phase);
    }
    if (filters.work_item && hasColumn(type, "work_item")) {
      whereClauses.push("e.work_item = ?");
      params.push(filters.work_item);
    }
  } else if (!type) {
    // No specific type — we can only filter on nodes columns
    // domain/cycle/severity/phase/work_item are ignored when no type is given
    // (they live on extension tables we can't JOIN without knowing the type)
  }

  const whereClause =
    whereClauses.length > 0 ? "WHERE " + whereClauses.join(" AND ") : "";

  // domain column for the result: use extension table when possible
  let domainExpr = "NULL";
  if (type && (type.startsWith("domain_") || type === "work_item")) {
    domainExpr = "e.domain";
  }

  // cycle column for the result
  let cycleExpr = "NULL";
  if (type === "finding" || type === "domain_decision") {
    cycleExpr = "e.cycle";
  } else if (
    type &&
    ["decision_log", "cycle_summary", "review_manifest", "architecture",
     "overview", "execution_strategy", "guiding_principles", "constraints",
     "research", "interview"].includes(type)
  ) {
    cycleExpr = "e.cycle";
  }

  const sql = `
    SELECT
      n.id,
      n.type,
      n.status,
      SUBSTR(COALESCE(${summaryExpr}, ''), 1, 81) AS summary,
      ${domainExpr} AS domain,
      ${cycleExpr} AS cycle,
      n.file_path
    FROM nodes n
    ${extensionJoin}
    ${whereClause}
    ORDER BY n.id
    LIMIT ? OFFSET ?
  `;

  params.push(limit, offset);

  const rows = ctx.db.prepare(sql).all(...params) as FilterModeRow[];

  if (rows.length === 0) {
    return "No results found.";
  }

  const tableRows = rows.map((r) => [
    r.id,
    r.type,
    r.status ?? "",
    truncate(r.summary),
    r.domain ?? "",
    r.cycle != null ? String(r.cycle) : "",
    r.file_path,
  ]);

  return markdownTable(
    ["ID", "Type", "Status", "Summary", "Domain", "Cycle", "File"],
    tableRows
  );
}

// ---------------------------------------------------------------------------
// Graph traversal mode
// ---------------------------------------------------------------------------

function runGraphMode(
  ctx: ToolContext,
  relatedTo: string,
  depth: number,
  direction: string,
  edgeTypes: string[] | undefined,
  typeFilter: string | undefined,
  filters: ParsedFilters,
  limit: number,
  offset: number
): string {
  // Verify the seed node exists
  const seedNode = ctx.db
    .prepare("SELECT id FROM nodes WHERE id = ?")
    .get(relatedTo) as { id: string } | undefined;

  if (!seedNode) {
    return `Error: Node '${relatedTo}' not found`;
  }

  if (depth === 1) {
    return runGraphDepth1(ctx, relatedTo, direction, edgeTypes, typeFilter, filters, limit, offset);
  } else {
    return runGraphRecursive(ctx, relatedTo, depth, direction, edgeTypes, typeFilter, filters, limit, offset);
  }
}

function buildEdgeTypeFilter(edgeTypes: string[] | undefined, alias: string): string {
  if (!edgeTypes || edgeTypes.length === 0) return "";
  const placeholders = edgeTypes.map(() => "?").join(", ");
  return `AND ${alias}.edge_type IN (${placeholders})`;
}

function runGraphDepth1(
  ctx: ToolContext,
  relatedTo: string,
  direction: string,
  edgeTypes: string[] | undefined,
  typeFilter: string | undefined,
  filters: ParsedFilters,
  limit: number,
  offset: number
): string {
  const edgeTypeFilter = buildEdgeTypeFilter(edgeTypes, "e");
  const edgeTypeParams = edgeTypes ?? [];

  let sql: string;
  const params: (string | number)[] = [];

  if (direction === "outgoing") {
    sql = `
      SELECT n.id AS node_id, n.type, e.edge_type, 'outgoing' AS direction, 1 AS depth, n.status, n.file_path
      FROM edges e
      JOIN nodes n ON n.id = e.target_id
      WHERE e.source_id = ?
      ${edgeTypeFilter}
    `;
    params.push(relatedTo, ...edgeTypeParams);
  } else if (direction === "incoming") {
    sql = `
      SELECT n.id AS node_id, n.type, e.edge_type, 'incoming' AS direction, 1 AS depth, n.status, n.file_path
      FROM edges e
      JOIN nodes n ON n.id = e.source_id
      WHERE e.target_id = ?
      ${edgeTypeFilter}
    `;
    params.push(relatedTo, ...edgeTypeParams);
  } else {
    // both
    sql = `
      SELECT n.id AS node_id, n.type, e.edge_type, 'outgoing' AS direction, 1 AS depth, n.status, n.file_path
      FROM edges e
      JOIN nodes n ON n.id = e.target_id
      WHERE e.source_id = ?
      ${edgeTypeFilter}
      UNION
      SELECT n.id AS node_id, n.type, e.edge_type, 'incoming' AS direction, 1 AS depth, n.status, n.file_path
      FROM edges e
      JOIN nodes n ON n.id = e.source_id
      WHERE e.target_id = ?
      ${edgeTypeFilter}
    `;
    params.push(relatedTo, ...edgeTypeParams, relatedTo, ...edgeTypeParams);
  }

  // Wrap in a CTE so we can apply type/filter/pagination
  return executeTraversalQuery(ctx, sql, params, typeFilter, filters, limit, offset);
}

function runGraphRecursive(
  ctx: ToolContext,
  relatedTo: string,
  depth: number,
  direction: string,
  edgeTypes: string[] | undefined,
  typeFilter: string | undefined,
  filters: ParsedFilters,
  limit: number,
  offset: number
): string {
  const edgeTypeFilter = buildEdgeTypeFilter(edgeTypes, "e");
  const edgeTypeParams = edgeTypes ?? [];

  let outgoingStep: string;
  let incomingStep: string;

  // Outgoing step (traversal follows source_id → target_id)
  outgoingStep = `
    SELECT e.target_id AS next_id, e.edge_type, 'outgoing' AS direction, t.depth + 1 AS depth
    FROM traversal t
    JOIN edges e ON e.source_id = t.node_id
    ${edgeTypeFilter}
    WHERE t.depth < ?
  `;

  // Incoming step (traversal follows target_id → source_id)
  incomingStep = `
    SELECT e.source_id AS next_id, e.edge_type, 'incoming' AS direction, t.depth + 1 AS depth
    FROM traversal t
    JOIN edges e ON e.target_id = t.node_id
    ${edgeTypeFilter}
    WHERE t.depth < ?
  `;

  let recursiveBody: string;
  let params: (string | number)[] = [];

  if (direction === "outgoing") {
    recursiveBody = `
      SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth
      UNION
      ${outgoingStep}
    `;
    params = [relatedTo, ...edgeTypeParams, depth];
  } else if (direction === "incoming") {
    recursiveBody = `
      SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth
      UNION
      ${incomingStep}
    `;
    params = [relatedTo, ...edgeTypeParams, depth];
  } else {
    // both directions
    recursiveBody = `
      SELECT ? AS node_id, '' AS edge_type, '' AS direction, 0 AS depth
      UNION
      ${outgoingStep}
      UNION
      ${incomingStep}
    `;
    params = [relatedTo, ...edgeTypeParams, depth, ...edgeTypeParams, depth];
  }

  const cteQuery = `
    WITH RECURSIVE traversal(node_id, edge_type, direction, depth) AS (
      ${recursiveBody}
    )
    SELECT n.id AS node_id, n.type, t.edge_type, t.direction, t.depth, n.status, n.file_path
    FROM traversal t
    JOIN nodes n ON n.id = t.node_id
    WHERE t.depth > 0
  `;

  return executeTraversalQuery(ctx, cteQuery, params, typeFilter, filters, limit, offset);
}

function executeTraversalQuery(
  ctx: ToolContext,
  baseSql: string,
  baseParams: (string | number)[],
  typeFilter: string | undefined,
  filters: ParsedFilters,
  limit: number,
  offset: number
): string {
  // We need summaries — but the base traversal query doesn't include them.
  // We wrap it and JOIN with extension tables based on each row's type.
  // Since we can't easily do a dynamic per-row JOIN in SQLite, we'll do a two-phase approach:
  // 1. Run the traversal to get node ids + metadata
  // 2. Fetch summaries for each unique type

  type RawRow = {
    node_id: string;
    type: string;
    edge_type: string;
    direction: string;
    depth: number;
    status: string | null;
    file_path: string;
  };

  // Apply type filter within the query if present
  let filteredSql = baseSql;
  const filteredParams = [...baseParams];

  if (typeFilter) {
    filteredSql = `SELECT * FROM (${baseSql}) WHERE type = ?`;
    filteredParams.push(typeFilter);
  }

  // Status filter from nodes
  if (filters.status) {
    const wrapper = typeFilter ? filteredSql : `SELECT * FROM (${baseSql})`;
    if (typeFilter) {
      filteredSql = `SELECT * FROM (${filteredSql}) WHERE status = ?`;
    } else {
      filteredSql = `${wrapper} WHERE status = ?`;
    }
    filteredParams.push(filters.status);
  }

  // Paginate
  filteredSql = `${filteredSql} ORDER BY depth, node_id LIMIT ? OFFSET ?`;
  filteredParams.push(limit, offset);

  const rows = ctx.db.prepare(filteredSql).all(...filteredParams) as RawRow[];

  if (rows.length === 0) {
    return "No results found.";
  }

  // Fetch summaries for each row by its type
  const summaryMap = buildSummaryMap(ctx, rows.map((r) => ({ id: r.node_id, type: r.type })));

  const tableRows = rows.map((r) => [
    r.node_id,
    r.type,
    r.edge_type || "",
    r.direction || "",
    String(r.depth),
    r.status ?? "",
    truncate(summaryMap[r.node_id]),
  ]);

  return markdownTable(
    ["ID", "Type", "Edge", "Dir", "Depth", "Status", "Summary"],
    tableRows
  );
}

// ---------------------------------------------------------------------------
// Summary builder: fetches summaries for a mixed list of (id, type) pairs
// ---------------------------------------------------------------------------

function buildSummaryMap(
  ctx: ToolContext,
  items: { id: string; type: string }[]
): Record<string, string> {
  if (items.length === 0) return {};

  // Group by extension table
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
    const rows = ctx.db.prepare(sql).all(...ids) as { id: string; summary: string }[];
    for (const row of rows) {
      result[row.id] = row.summary ?? "";
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: does a given artifact type have a specific column on its extension table?
// ---------------------------------------------------------------------------

function hasColumn(type: string, column: string): boolean {
  const domainTypes = [
    "domain_policy", "domain_decision", "domain_question", "work_item",
  ];
  const cycleTypes = ["finding", "domain_decision"];
  const workItemRefTypes = ["finding"];
  const phaseTypes = ["journal_entry"];

  switch (column) {
    case "domain":
      return domainTypes.includes(type);
    case "cycle":
      return cycleTypes.includes(type);
    case "work_item":
      return workItemRefTypes.includes(type);
    case "phase":
      return phaseTypes.includes(type);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleArtifactQuery(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const type = args.type as string | undefined;
  const filters = (args.filters ?? {}) as ParsedFilters;
  const relatedTo = args.related_to as string | undefined;
  const edgeTypes = args.edge_types as string[] | undefined;
  const direction = (args.direction as string | undefined) ?? "both";
  const depthRaw = args.depth as number | undefined;
  const limitRaw = args.limit as number | undefined;
  const offset = (args.offset as number | undefined) ?? 0;

  // Validate: at least one of type, related_to, or filters required
  const hasFilters =
    filters &&
    Object.values(filters).some((v) => v !== undefined && v !== null);

  if (!type && !relatedTo && !hasFilters) {
    return "Error: At least one of 'type', 'related_to', or 'filters' is required";
  }

  // Validate type
  if (type && !VALID_TYPES.includes(type)) {
    return `Error: Unknown type '${type}'. Valid types: ${VALID_TYPES.join(", ")}`;
  }

  // Validate depth
  if (depthRaw !== undefined && !relatedTo) {
    return "Error: 'depth' requires 'related_to' parameter";
  }
  const depth = depthRaw ?? 1;
  if (depth > 10) {
    return "Error: Maximum depth is 10";
  }

  // Cap limit
  let limit = limitRaw ?? 50;
  if (limit > 200) limit = 200;

  // Route to appropriate mode
  if (relatedTo) {
    return runGraphMode(
      ctx,
      relatedTo,
      depth,
      direction,
      edgeTypes,
      type,
      filters,
      limit,
      offset
    );
  } else {
    return runFilterMode(ctx, type, filters, limit, offset);
  }
}
