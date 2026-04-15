import type { ToolContext } from "../types.js";
import type { Node } from "../adapter.js";

// ---------------------------------------------------------------------------
// Adapter resolution
//
// All handlers require ctx.adapter to be set. No tool handler may access
// ctx.db or ctx.drizzleDb directly — all data access routes through
// ctx.adapter (RF-clean-interface-proposal §1 invariant 2).
// ---------------------------------------------------------------------------

function getAdapter(ctx: ToolContext) {
  if (!ctx.adapter) {
    throw new Error(
      "metrics.ts: ToolContext.adapter is required. " +
        "This is a configuration error — the server and all tests must provide an adapter."
    );
  }
  return ctx.adapter;
}

// ---------------------------------------------------------------------------
// handleEmitMetric — no-op (soft-deprecated in PH-044)
// ---------------------------------------------------------------------------

/**
 * Soft-deprecated in PH-044. Prior aggregation logic was distrusted as
 * unreliable (bad data worse than no data). Full removal and replacement
 * deferred to quality-metrics rebuild phase.
 */
export async function handleEmitMetric(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const payload = args.payload as Record<string, unknown> | undefined | null;

  if (payload === undefined || payload === null) {
    throw new Error("Missing required parameter: payload");
  }

  // No-op: do not write YAML, do not call adapter.putNode, do not insert into metrics_events.
  void ctx;
  return "Metric emission deprecated — event not recorded.";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type MetricsScope = "agent" | "work_item" | "cycle";

interface MetricsFilter {
  cycle?: number;
  work_item?: string;
  agent_type?: string;
  phase?: string;
}

interface AgentAggregate {
  agent_type: string;
  event_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_input_tokens: number;
  avg_output_tokens: number;
  cache_hit_rate: number;
  finding_count: number;
  finding_severities: string;
  outcome_counts: Record<string, number>;
}

interface WorkItemAggregate {
  work_item: string;
  first_pass_accepted: boolean | null;
  rework_count: number;
  total_tokens: number;
}

interface CycleAggregate {
  cycle: number;
  convergence_cycles: number | null;
  total_findings_critical: number;
  total_findings_significant: number;
  total_findings_minor: number;
  total_tokens: number;
  total_cost_estimate: string | null;
}

// ---------------------------------------------------------------------------
// Raw DB row type (includes cycle_created from JOIN with nodes)
// ---------------------------------------------------------------------------

interface LocalMetricsEventRow {
  id: string;
  event_name: string;
  timestamp: string | null;
  payload: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  outcome: string | null;
  finding_count: number | null;
  finding_severities: string | null;
  first_pass_accepted: number | null;
  rework_count: number | null;
  work_item_total_tokens: number | null;
  cycle_total_tokens: number | null;
  cycle_total_cost_estimate: string | null;
  convergence_cycles: number | null;
  context_artifact_ids: string | null;
  cycle_created: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


/**
 * Map a Node returned by adapter.getNodes() to the LocalMetricsEventRow shape
 * used by the aggregation functions.
 *
 * node.properties contains all columns from the metrics_events extension table
 * (event_name, timestamp, payload, input_tokens, etc.) because LocalAdapter's
 * fetchExtensionProperties does SELECT * FROM metrics_events WHERE id = ?.
 * RemoteAdapter is expected to provide the same fields in Node.properties for
 * metrics_event nodes.
 */
function nodeToMetricsRow(node: Node): LocalMetricsEventRow {
  const p = node.properties;

  function num(v: unknown): number | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  function str(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    return String(v);
  }

  return {
    id: node.id,
    event_name: typeof p.event_name === "string" ? p.event_name : node.id,
    timestamp: str(p.timestamp),
    payload: str(p.payload),
    input_tokens: num(p.input_tokens),
    output_tokens: num(p.output_tokens),
    cache_read_tokens: num(p.cache_read_tokens),
    cache_write_tokens: num(p.cache_write_tokens),
    outcome: str(p.outcome),
    finding_count: num(p.finding_count),
    finding_severities: str(p.finding_severities),
    first_pass_accepted: num(p.first_pass_accepted),
    rework_count: num(p.rework_count),
    work_item_total_tokens: num(p.work_item_total_tokens),
    cycle_total_tokens: num(p.cycle_total_tokens),
    cycle_total_cost_estimate: str(p.cycle_total_cost_estimate),
    convergence_cycles: num(p.convergence_cycles),
    context_artifact_ids: str(p.context_artifact_ids),
    cycle_created: node.cycle_created,
  };
}

/**
 * Parse finding_severities JSON string → counts by severity.
 * Expected format: {"critical": N, "significant": N, "minor": N}
 * or a plain string. Returns { critical: 0, significant: 0, minor: 0 } on failure.
 */
function parseFindingSeverities(raw: string | null): {
  critical: number;
  significant: number;
  minor: number;
} {
  const zero = { critical: 0, significant: 0, minor: 0 };
  if (!raw) return zero;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      critical: typeof parsed.critical === "number" ? parsed.critical : 0,
      significant: typeof parsed.significant === "number" ? parsed.significant : 0,
      minor: typeof parsed.minor === "number" ? parsed.minor : 0,
    };
  } catch {
    return zero;
  }
}

// ---------------------------------------------------------------------------
// Aggregation: agent scope
// ---------------------------------------------------------------------------

function aggregateByAgent(rows: LocalMetricsEventRow[]): AgentAggregate[] {
  const map = new Map<string, {
    event_count: number;
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_total_tokens: number;
    finding_count: number;
    sev_critical: number;
    sev_significant: number;
    sev_minor: number;
    outcome_counts: Record<string, number>;
  }>();

  for (const row of rows) {
    let agentType = "unknown";
    if (row.payload) {
      try {
        const p = JSON.parse(row.payload);
        if (typeof p.agent_type === "string") agentType = p.agent_type;
      } catch { /* ignore */ }
    }
    if (agentType === "unknown") agentType = row.event_name;
    const key = agentType;
    if (!map.has(key)) {
      map.set(key, {
        event_count: 0,
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_total_tokens: 0,
        finding_count: 0,
        sev_critical: 0,
        sev_significant: 0,
        sev_minor: 0,
        outcome_counts: {},
      });
    }
    const agg = map.get(key)!;
    agg.event_count++;
    agg.total_input += row.input_tokens ?? 0;
    agg.total_output += row.output_tokens ?? 0;
    agg.total_cache_read += row.cache_read_tokens ?? 0;
    agg.total_total_tokens += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
    agg.finding_count += row.finding_count ?? 0;

    const sevs = parseFindingSeverities(row.finding_severities);
    agg.sev_critical += sevs.critical;
    agg.sev_significant += sevs.significant;
    agg.sev_minor += sevs.minor;

    if (row.outcome) {
      agg.outcome_counts[row.outcome] = (agg.outcome_counts[row.outcome] ?? 0) + 1;
    }
  }

  const result: AgentAggregate[] = [];
  for (const [agent_type, agg] of map.entries()) {
    const totalTokens = agg.total_input + agg.total_output;
    const avgInput = agg.event_count > 0 ? Math.round(agg.total_input / agg.event_count) : 0;
    const avgOutput = agg.event_count > 0 ? Math.round(agg.total_output / agg.event_count) : 0;
    // Cache hit rate = cache_read_tokens / total_input_tokens
    const cacheHitRate = agg.total_input > 0
      ? Math.round((agg.total_cache_read / agg.total_input) * 100) / 100
      : 0;
    const sevString = `critical: ${agg.sev_critical}, significant: ${agg.sev_significant}, minor: ${agg.sev_minor}`;

    result.push({
      agent_type,
      event_count: agg.event_count,
      total_input_tokens: agg.total_input,
      total_output_tokens: agg.total_output,
      avg_input_tokens: avgInput,
      avg_output_tokens: avgOutput,
      cache_hit_rate: cacheHitRate,
      finding_count: agg.finding_count,
      finding_severities: sevString,
      outcome_counts: agg.outcome_counts,
    });
  }

  return result.sort((a, b) => a.agent_type.localeCompare(b.agent_type));
}

// ---------------------------------------------------------------------------
// Aggregation: work_item scope
// ---------------------------------------------------------------------------

function aggregateByWorkItem(rows: LocalMetricsEventRow[]): WorkItemAggregate[] {
  // We aggregate per work_item value from the payload JSON field.
  // Each row may have a "work_item" key in its payload.
  const map = new Map<string, {
    first_pass_accepted: number | null;
    rework_count: number;
    total_tokens: number;
  }>();

  for (const row of rows) {
    // Extract work_item from payload
    let wiId: string | null = null;
    if (row.payload) {
      try {
        const p = JSON.parse(row.payload) as Record<string, unknown>;
        if (typeof p.work_item === "string") wiId = p.work_item;
      } catch {
        // ignore
      }
    }

    // Also consider first_pass_accepted / rework_count directly on the row
    // (these are set on work_item-level events)
    if (wiId === null) {
      // Skip rows without a work_item in payload (cycle-level events, etc.)
      continue;
    }

    if (!map.has(wiId)) {
      map.set(wiId, {
        first_pass_accepted: null,
        rework_count: 0,
        total_tokens: 0,
      });
    }
    const agg = map.get(wiId)!;

    // Use the first non-null first_pass_accepted value
    if (agg.first_pass_accepted === null && row.first_pass_accepted !== null) {
      agg.first_pass_accepted = row.first_pass_accepted;
    }
    // Sum rework_count
    agg.rework_count += row.rework_count ?? 0;
    // Sum tokens
    agg.total_tokens += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
    // Also include work_item_total_tokens if present (pre-aggregated)
    if (row.work_item_total_tokens !== null) {
      // Use the larger of computed vs. stored total (don't double-count)
      agg.total_tokens = Math.max(agg.total_tokens, row.work_item_total_tokens);
    }
  }

  const result: WorkItemAggregate[] = [];
  for (const [work_item, agg] of map.entries()) {
    result.push({
      work_item,
      first_pass_accepted: agg.first_pass_accepted === null
        ? null
        : agg.first_pass_accepted !== 0,
      rework_count: agg.rework_count,
      total_tokens: agg.total_tokens,
    });
  }

  return result.sort((a, b) => a.work_item.localeCompare(b.work_item));
}

// ---------------------------------------------------------------------------
// Aggregation: cycle scope
// ---------------------------------------------------------------------------

function aggregateByCycle(rows: LocalMetricsEventRow[]): CycleAggregate[] {
  const map = new Map<number, {
    convergence_cycles: number | null;
    total_findings_critical: number;
    total_findings_significant: number;
    total_findings_minor: number;
    total_tokens: number;
    cycle_total_tokens: number | null;
    cycle_total_cost_estimate: string | null;
  }>();

  for (const row of rows) {
    const cycleKey = row.cycle_created ?? 0;

    if (!map.has(cycleKey)) {
      map.set(cycleKey, {
        convergence_cycles: null,
        total_findings_critical: 0,
        total_findings_significant: 0,
        total_findings_minor: 0,
        total_tokens: 0,
        cycle_total_tokens: null,
        cycle_total_cost_estimate: null,
      });
    }
    const agg = map.get(cycleKey)!;

    // Use first non-null convergence_cycles
    if (agg.convergence_cycles === null && row.convergence_cycles !== null) {
      agg.convergence_cycles = row.convergence_cycles;
    }

    // Sum finding severities
    const sevs = parseFindingSeverities(row.finding_severities);
    agg.total_findings_critical += sevs.critical;
    agg.total_findings_significant += sevs.significant;
    agg.total_findings_minor += sevs.minor;

    // Sum tokens
    agg.total_tokens += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);

    // Use cycle_total_tokens / cost_estimate from the most recent row that has them
    if (row.cycle_total_tokens !== null) {
      agg.cycle_total_tokens = row.cycle_total_tokens;
    }
    if (row.cycle_total_cost_estimate !== null) {
      agg.cycle_total_cost_estimate = row.cycle_total_cost_estimate;
    }
  }

  const result: CycleAggregate[] = [];
  for (const [cycle, agg] of map.entries()) {
    // Prefer pre-aggregated cycle_total_tokens if available
    const effectiveTokens = agg.cycle_total_tokens ?? agg.total_tokens;

    result.push({
      cycle,
      convergence_cycles: agg.convergence_cycles,
      total_findings_critical: agg.total_findings_critical,
      total_findings_significant: agg.total_findings_significant,
      total_findings_minor: agg.total_findings_minor,
      total_tokens: effectiveTokens,
      total_cost_estimate: agg.cycle_total_cost_estimate,
    });
  }

  return result.sort((a, b) => a.cycle - b.cycle);
}

// ---------------------------------------------------------------------------
// Markdown renderers
// ---------------------------------------------------------------------------

function renderAgentTable(aggregates: AgentAggregate[]): string {
  if (aggregates.length === 0) {
    return "No agent metrics data found.\n";
  }

  const lines: string[] = [];
  lines.push("## Agent Aggregates");
  lines.push("");
  lines.push("| Agent Type | Events | Total In Tokens | Total Out Tokens | Avg In | Avg Out | Cache Hit Rate | Findings | Severities (C/S/M) | Outcomes |");
  lines.push("|------------|--------|-----------------|------------------|--------|---------|----------------|----------|--------------------|----------|");

  for (const a of aggregates) {
    const sevParts = a.finding_severities.match(/critical: (\d+), significant: (\d+), minor: (\d+)/);
    const sevDisplay = sevParts ? `${sevParts[1]}/${sevParts[2]}/${sevParts[3]}` : a.finding_severities;
    const outcomeParts = Object.entries(a.outcome_counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    const outcomeDisplay = outcomeParts || "—";
    const cacheDisplay = `${(a.cache_hit_rate * 100).toFixed(1)}%`;

    lines.push(
      `| ${a.agent_type} | ${a.event_count} | ${a.total_input_tokens} | ${a.total_output_tokens} | ${a.avg_input_tokens} | ${a.avg_output_tokens} | ${cacheDisplay} | ${a.finding_count} | ${sevDisplay} | ${outcomeDisplay} |`
    );
  }

  return lines.join("\n") + "\n";
}

function renderWorkItemTable(aggregates: WorkItemAggregate[]): string {
  if (aggregates.length === 0) {
    return "No work item metrics data found.\n";
  }

  const lines: string[] = [];
  lines.push("## Work Item Aggregates");
  lines.push("");
  lines.push("| Work Item | First Pass Accepted | Rework Count | Total Tokens |");
  lines.push("|-----------|---------------------|--------------|--------------|");

  for (const w of aggregates) {
    const fpa = w.first_pass_accepted === null ? "—" : w.first_pass_accepted ? "Yes" : "No";
    lines.push(`| ${w.work_item} | ${fpa} | ${w.rework_count} | ${w.total_tokens} |`);
  }

  return lines.join("\n") + "\n";
}

function renderCycleTable(aggregates: CycleAggregate[]): string {
  if (aggregates.length === 0) {
    return "No cycle metrics data found.\n";
  }

  const lines: string[] = [];
  lines.push("## Cycle Aggregates");
  lines.push("");
  lines.push("| Cycle | Convergence Cycles | Findings (C/S/M) | Total Tokens | Cost Estimate |");
  lines.push("|-------|--------------------|------------------|--------------|---------------|");

  for (const c of aggregates) {
    const conv = c.convergence_cycles !== null ? String(c.convergence_cycles) : "—";
    const sevDisplay = `${c.total_findings_critical}/${c.total_findings_significant}/${c.total_findings_minor}`;
    const cost = c.total_cost_estimate ?? "—";
    lines.push(`| ${c.cycle} | ${conv} | ${sevDisplay} | ${c.total_tokens} | ${cost} |`);
  }

  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleGetMetrics(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  const scope = args.scope as MetricsScope | undefined;
  const filterRaw = args.filter as Record<string, unknown> | undefined;

  const filter: MetricsFilter | undefined = filterRaw
    ? {
        cycle: typeof filterRaw.cycle === "number" ? filterRaw.cycle : undefined,
        work_item: typeof filterRaw.work_item === "string" ? filterRaw.work_item : undefined,
        agent_type: typeof filterRaw.agent_type === "string" ? filterRaw.agent_type : undefined,
        phase: typeof filterRaw.phase === "string" ? filterRaw.phase : undefined,
      }
    : undefined;

  const adapter = getAdapter(ctx);

  // Fetch all metric_event nodes via the adapter. queryNodes returns NodeMeta
  // only; getNodes returns full Node objects whose .properties contain all
  // metrics_events extension columns (event_name, input_tokens, payload, etc.).
  // Filters are applied in TypeScript after fetching because:
  //   - cycle maps to node.cycle_created (NodeFilter.cycle only applies for
  //     node types where hasColumn("cycle") is true, which excludes
  //     metrics_event in the local adapter).
  //   - agent_type, work_item, phase live inside the payload JSON field and
  //     are not queryable through NodeFilter.
  const METRICS_FETCH_LIMIT = 100_000;
  const queryResult = await adapter.queryNodes(
    { type: "metrics_event" },
    METRICS_FETCH_LIMIT,
    0
  );
  const nodeIds = queryResult.nodes.map(({ node }) => node.id);

  let rows: LocalMetricsEventRow[];

  if (nodeIds.length === 0) {
    rows = [];
  } else {
    const nodesMap = await adapter.getNodes(nodeIds);
    const allRows = Array.from(nodesMap.values()).map(nodeToMetricsRow);

    // Apply TypeScript-side filters (mirrors the SQL WHERE fragments).
    rows = allRows.filter((row) => {
      if (filter?.cycle !== undefined && row.cycle_created !== filter.cycle) {
        return false;
      }
      if (filter?.agent_type !== undefined) {
        let payloadAgentType: string | null = null;
        if (row.payload) {
          try {
            const p = JSON.parse(row.payload) as Record<string, unknown>;
            if (typeof p.agent_type === "string") payloadAgentType = p.agent_type;
          } catch { /* ignore */ }
        }
        if (payloadAgentType !== filter.agent_type) return false;
      }
      if (filter?.work_item !== undefined) {
        let payloadWorkItem: string | null = null;
        if (row.payload) {
          try {
            const p = JSON.parse(row.payload) as Record<string, unknown>;
            if (typeof p.work_item === "string") payloadWorkItem = p.work_item;
          } catch { /* ignore */ }
        }
        if (payloadWorkItem !== filter.work_item) return false;
      }
      if (filter?.phase !== undefined) {
        let payloadPhase: string | null = null;
        if (row.payload) {
          try {
            const p = JSON.parse(row.payload) as Record<string, unknown>;
            if (typeof p.phase === "string") payloadPhase = p.phase;
          } catch { /* ignore */ }
        }
        if (payloadPhase !== filter.phase) return false;
      }
      return true;
    });

    // Restore ordering consistent with the original SQL (timestamp ASC, id ASC).
    rows.sort((a, b) => {
      const tA = a.timestamp ?? "";
      const tB = b.timestamp ?? "";
      if (tA < tB) return -1;
      if (tA > tB) return 1;
      return a.id.localeCompare(b.id);
    });
  }

  const sections: string[] = [];
  sections.push("# Metrics Report");
  sections.push("");

  const appliedFilters: string[] = [];
  if (filter?.cycle !== undefined) appliedFilters.push(`cycle: ${filter.cycle}`);
  if (filter?.agent_type !== undefined) appliedFilters.push(`agent_type: ${filter.agent_type}`);
  if (filter?.work_item !== undefined) appliedFilters.push(`work_item: ${filter.work_item}`);
  if (filter?.phase !== undefined) appliedFilters.push(`phase: ${filter.phase}`);
  if (appliedFilters.length > 0) {
    sections.push(`**Filters**: ${appliedFilters.join(", ")}`);
    sections.push("");
  }

  sections.push(`**Total events**: ${rows.length}`);
  sections.push("");

  const showAgent = !scope || scope === "agent";
  const showWorkItem = !scope || scope === "work_item";
  const showCycle = !scope || scope === "cycle";

  if (showAgent) {
    const agentAggs = aggregateByAgent(rows);
    sections.push(renderAgentTable(agentAggs));
  }

  if (showWorkItem) {
    const wiAggs = aggregateByWorkItem(rows);
    sections.push(renderWorkItemTable(wiAggs));
  }

  if (showCycle) {
    const cycleAggs = aggregateByCycle(rows);
    sections.push(renderCycleTable(cycleAggs));
  }

  return sections.join("\n");
}
