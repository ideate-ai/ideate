/**
 * tool-usage.ts — Handler for ideate_get_tool_usage MCP tool.
 *
 * Delegates to ctx.adapter.getToolUsage(filter) and returns aggregates,
 * raw rows, or both as JSON. No direct SQLite / drizzleDb access.
 */

import type { ToolContext } from "../types.js";
import type { ToolUsageFilter, ToolUsageRow } from "../adapter.js";

// ---------------------------------------------------------------------------
// Response shape types
// ---------------------------------------------------------------------------

interface AggregateRow {
  tool_name: string;
  count: number;
  request_tokens_total: number;
  response_tokens_total: number;
  request_bytes_total: number;
  response_bytes_total: number;
}

// ---------------------------------------------------------------------------
// Aggregate computation helper
// ---------------------------------------------------------------------------

function buildAggregates(rows: ToolUsageRow[]): AggregateRow[] {
  const map = new Map<string, AggregateRow>();

  for (const row of rows) {
    let entry = map.get(row.tool_name);
    if (entry === undefined) {
      entry = {
        tool_name: row.tool_name,
        count: 0,
        request_tokens_total: 0,
        response_tokens_total: 0,
        request_bytes_total: 0,
        response_bytes_total: 0,
      };
      map.set(row.tool_name, entry);
    }
    entry.count += 1;
    entry.request_tokens_total += row.request_tokens ?? 0;
    entry.response_tokens_total += row.response_tokens ?? 0;
    entry.request_bytes_total += row.request_bytes;
    entry.response_bytes_total += row.response_bytes;
  }

  return Array.from(map.values()).sort((a, b) =>
    a.tool_name < b.tool_name ? -1 : a.tool_name > b.tool_name ? 1 : 0
  );
}

// ---------------------------------------------------------------------------
// handleGetToolUsage
// ---------------------------------------------------------------------------

/**
 * Handle ideate_get_tool_usage tool calls.
 *
 * Args (all optional):
 *   tool_name, session_id, cycle, phase, from, to  — filter fields
 *   view   — "aggregate" | "detail" | "both" (default "aggregate")
 *   limit  — max rows for detail view (default 1000, max 10000)
 */
export async function handleGetToolUsage(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  if (!ctx.adapter) {
    throw new Error("handleGetToolUsage requires ctx.adapter to be set");
  }

  // -------------------------------------------------------------------------
  // Parse view / limit
  // -------------------------------------------------------------------------

  const rawView = args["view"];
  const view: "aggregate" | "detail" | "both" =
    rawView === "detail" || rawView === "both" ? rawView : "aggregate";

  const rawLimit = args["limit"];
  let limit = 1000;
  if (typeof rawLimit === "number") {
    if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
      limit = 1000;
    } else if (rawLimit > 10000) {
      limit = 10000;
    } else {
      limit = Math.floor(rawLimit);
    }
  }

  // -------------------------------------------------------------------------
  // Build filter — copy only the six recognised filter fields
  // -------------------------------------------------------------------------

  const filter: ToolUsageFilter = {};

  if (typeof args["tool_name"] === "string") {
    filter.tool_name = args["tool_name"];
  }
  if (typeof args["session_id"] === "string") {
    filter.session_id = args["session_id"];
  }
  if (typeof args["cycle"] === "number" && Number.isFinite(args["cycle"])) {
    filter.cycle = Math.floor(args["cycle"] as number);
  }
  if (typeof args["phase"] === "string") {
    filter.phase = args["phase"];
  }
  if (typeof args["from"] === "string") {
    filter.from = args["from"];
  }
  if (typeof args["to"] === "string") {
    filter.to = args["to"];
  }

  // -------------------------------------------------------------------------
  // Query adapter
  // -------------------------------------------------------------------------

  const rows = await ctx.adapter.getToolUsage(filter);

  // -------------------------------------------------------------------------
  // Build response
  // -------------------------------------------------------------------------

  const totalCount = rows.length;
  const limitedRows = rows.slice(0, limit);
  const truncated = totalCount > limit;

  if (view === "aggregate") {
    const response = {
      filters: filter,
      aggregate: buildAggregates(rows),
    };
    return JSON.stringify(response, null, 2);
  }

  if (view === "detail") {
    const response = {
      filters: filter,
      rows: limitedRows,
      total_count: totalCount,
      truncated,
    };
    return JSON.stringify(response, null, 2);
  }

  // view === "both"
  //
  // Truncation semantics for the "both" view:
  //   - aggregate: computed from ALL rows returned by the adapter — never
  //     truncated. Counts and token totals are always exact regardless of
  //     the `limit` parameter.
  //   - rows (detail): capped at `limit` (default 1000, max 10000) via
  //     rows.slice(0, limit). When totalCount > limit the `truncated` flag
  //     is set to true and the newest rows beyond the limit are omitted
  //     (rows are ordered oldest-first by timestamp ASC, id ASC).
  //   - Effectively, the detail section truncates first; the aggregate
  //     section is never affected by the budget, so callers can rely on
  //     aggregate totals even when `truncated === true`.
  const response = {
    filters: filter,
    aggregate: buildAggregates(rows),
    rows: limitedRows,
    total_count: totalCount,
    truncated,
  };
  return JSON.stringify(response, null, 2);
}
