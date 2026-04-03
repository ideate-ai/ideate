import * as fs from "fs";
import * as path from "path";
import type { ToolContext } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DESC_MAX_CHARS = 200;
function truncateDesc(text: string): string {
  if (text.length <= DESC_MAX_CHARS) return text;
  return text.slice(0, DESC_MAX_CHARS) + "...";
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Parse current_cycle from domains/index.yaml (or index.md).
 * Looks for a line matching `current_cycle: N`.
 */
function parseCycleFromIndex(indexMd: string): number | null {
  const match = indexMd.match(/^current_cycle:\s*(\d+)/m);
  if (match) return parseInt(match[1], 10);
  return null;
}

// ---------------------------------------------------------------------------
// Principle violation parsing (spec-adherence.md)
// ---------------------------------------------------------------------------

type PrincipleVerdict = "pass" | "fail" | "unknown";

interface PrincipleResult {
  verdict: PrincipleVerdict;
  source: "step1" | "step2" | "step3";
  warning?: string;
}

function parsePrincipleVerdict(content: string): PrincipleResult {
  // Step 1: look for explicit bold verdict tag
  if (/\*\*Principle Violation Verdict\*\*:\s*Pass/i.test(content)) {
    return { verdict: "pass", source: "step1" };
  }
  if (/\*\*Principle Violation Verdict\*\*:\s*Fail/i.test(content)) {
    return { verdict: "fail", source: "step1" };
  }

  // Step 2: find ## Principle Violation or ## Guiding Principle section
  const lines = content.split("\n");
  let inSection = false;
  const sectionBodyLines: string[] = [];

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (inSection) break; // hit next section
      const heading = line.replace(/^##\s+/, "").trim().toLowerCase();
      if (heading.startsWith("principle violation") || heading.startsWith("guiding principle")) {
        inSection = true;
      }
      continue;
    }
    if (inSection) {
      sectionBodyLines.push(line);
    }
  }

  if (inSection) {
    const body = sectionBodyLines.join("\n").trim();
    // "None." or empty body → Pass
    if (body === "" || /^none\.?\s*$/i.test(body)) {
      return { verdict: "pass", source: "step2" };
    }
    // Body has ### subheadings or bullet items → Fail
    if (/^###\s/.test(body) || /^\s*-\s/.test(body)) {
      return { verdict: "fail", source: "step2" };
    }
    // Body exists but not matching patterns — fall through to step 3
  }

  // Step 3: unknown
  return { verdict: "unknown", source: "step3", warning: "unexpected format" };
}

// ---------------------------------------------------------------------------
// ideate_get_convergence_status
// ---------------------------------------------------------------------------

export async function handleGetConvergenceStatus(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // Validate cycle_number
  const cycleNumber = Number(args.cycle_number);
  if (args.cycle_number === undefined || isNaN(cycleNumber)) {
    throw new Error("Missing or invalid required parameter: cycle_number");
  }

  let findingsBySeverity: Record<string, number>;
  let cycleSummaryContent: string | null;

  if (ctx.adapter) {
    // Delegate storage operations to adapter
    const convergenceData = await ctx.adapter.getConvergenceData(cycleNumber);
    findingsBySeverity = convergenceData.findings_by_severity;
    cycleSummaryContent = convergenceData.cycle_summary_content;
  } else {
    // Fallback: direct SQLite path
    const paddedCycle = String(cycleNumber).padStart(3, "0");
    type RawRow = { id: string; file_path: string; da_content: string | null };
    const likePattern = `%/cycles/${paddedCycle}/%`;
    const rawRows = ctx.db.prepare(`
      SELECT n.id, n.file_path, da.content AS da_content
      FROM nodes n
      LEFT JOIN document_artifacts da ON n.id = da.id
      WHERE n.type = 'cycle_summary'
        AND (
          da.cycle = ?
          OR (da.id IS NULL AND n.file_path LIKE ?)
          OR (da.id IS NOT NULL AND da.cycle IS NULL AND n.file_path LIKE ?)
        )
    `).all(cycleNumber, likePattern, likePattern) as RawRow[];

    const adherenceRow =
      rawRows.find((r) => r.id.toUpperCase().startsWith("SA-")) ??
      rawRows.find((r) => r.id.toLowerCase().includes("adherence"));
    const summaryRow = rawRows.find((r) =>
      r.id.toUpperCase().startsWith("CS-") ||
      r.id.toLowerCase().includes("summary")
    ) ?? rawRows[0];

    function resolveContent(row: RawRow | undefined): string | null {
      if (!row) return null;
      if (row.da_content !== null && row.da_content !== undefined) {
        try {
          const parsed = JSON.parse(row.da_content) as Record<string, unknown>;
          if (parsed && typeof parsed.content === "string") {
            return parsed.content;
          }
          console.warn("resolveContent: da_content parsed successfully but .content is not a string for id:", row.id);
          return null;
        } catch {
          // not JSON
        }
        return row.da_content;
      }
      return readFileSafe(row.file_path);
    }

    cycleSummaryContent = resolveContent(adherenceRow ?? summaryRow);

    const severityRows = ctx.db.prepare(
      `SELECT severity, COUNT(*) as count FROM findings WHERE cycle = ? GROUP BY severity`
    ).all(cycleNumber) as Array<{ severity: string; count: number }>;

    findingsBySeverity = {};
    for (const row of severityRows) {
      findingsBySeverity[row.severity] = row.count;
    }
  }

  let principleResult: PrincipleResult;
  if (cycleSummaryContent === null) {
    principleResult = { verdict: "unknown", source: "step3", warning: `no cycle_summary found for cycle ${cycleNumber}` };
  } else {
    principleResult = parsePrincipleVerdict(cycleSummaryContent);
  }

  const critSigCount = (findingsBySeverity["critical"] ?? 0) + (findingsBySeverity["significant"] ?? 0);
  const criticalCount = findingsBySeverity["critical"] ?? 0;
  const significantCount = findingsBySeverity["significant"] ?? 0;
  const minorCount = findingsBySeverity["minor"] ?? 0;
  const suggestionsCount = findingsBySeverity["suggestion"] ?? 0;

  const conditionA = critSigCount === 0;
  const conditionB = principleResult.verdict === "pass";
  const converged = conditionA && conditionB;

  const lines: string[] = [
    `cycle: ${cycleNumber}`,
    `converged: ${converged}`,
    `condition_a: ${conditionA}`,
    `condition_b: ${conditionB}`,
    `principle_verdict: ${principleResult.verdict}`,
    `principle_verdict_source: ${principleResult.source}`,
    `findings:`,
    `  critical: ${criticalCount}`,
    `  significant: ${significantCount}`,
    `  minor: ${minorCount}`,
    `  suggestions: ${suggestionsCount}`,
  ];

  if (principleResult.warning) {
    lines.push(`principle_verdict_warning: "${principleResult.warning}"`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ideate_get_domain_state
// ---------------------------------------------------------------------------

export async function handleGetDomainState(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  const domainsFilter = Array.isArray(args.domains) ? (args.domains as string[]) : null;

  // Read cycle number from domains/index.yaml (fall back to index.md for backward compatibility)
  const indexYamlPath = path.join(ctx.ideateDir, "domains", "index.yaml");
  const indexMdPath = path.join(ctx.ideateDir, "domains", "index.md");
  const indexContent = readFileSafe(indexYamlPath) ?? readFileSafe(indexMdPath);
  const cycleNumber = indexContent !== null ? parseCycleFromIndex(indexContent) : null;

  type DomainEntry = {
    policies: Array<{ id: string; description: string | null; status: string | null }>;
    decisions: Array<{ id: string; description: string | null; status: string | null }>;
    questions: Array<{ id: string; description: string | null; status: string | null }>;
  };

  let domainMap: Map<string, DomainEntry>;

  if (ctx.adapter) {
    // Delegate to adapter
    domainMap = await ctx.adapter.getDomainState(domainsFilter ?? undefined);
  } else {
    // Fallback: direct SQLite path
    const allPolicies = ctx.db.prepare(`
      SELECT dp.id, dp.domain, dp.description, n.status
      FROM domain_policies dp
      JOIN nodes n ON n.id = dp.id
      WHERE (n.status IS NULL OR (n.status != 'deprecated' AND n.status != 'superseded'))
      ORDER BY dp.domain, dp.id
    `).all() as Array<{
      id: string;
      domain: string;
      description: string | null;
      status: string | null;
    }>;

    const allDecisions = ctx.db.prepare(`
      SELECT dd.id, dd.domain, dd.description, n.status
      FROM domain_decisions dd
      JOIN nodes n ON n.id = dd.id
      ORDER BY dd.domain, dd.id
    `).all() as Array<{
      id: string;
      domain: string;
      description: string | null;
      status: string | null;
    }>;

    const allQuestions = ctx.db.prepare(`
      SELECT dq.id, dq.domain, dq.description, n.status
      FROM domain_questions dq
      JOIN nodes n ON n.id = dq.id
      WHERE n.status = 'open'
      ORDER BY dq.domain, dq.id
    `).all() as Array<{
      id: string;
      domain: string;
      description: string | null;
      status: string | null;
    }>;

    const domainSet = new Set<string>([
      ...allPolicies.map((p) => p.domain),
      ...allDecisions.map((d) => d.domain),
      ...allQuestions.map((q) => q.domain),
    ]);
    let domainList = Array.from(domainSet).sort();

    if (domainsFilter && domainsFilter.length > 0) {
      domainList = domainList.filter((d) => domainsFilter.includes(d));
    }

    domainMap = new Map<string, DomainEntry>();
    for (const domain of domainList) {
      domainMap.set(domain, {
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
  }

  const sections: string[] = [];
  if (cycleNumber !== null) {
    sections.push(`Current cycle: ${cycleNumber}\n`);
  }

  const domains = Array.from(domainMap.keys());

  for (const domain of domains) {
    const entry = domainMap.get(domain)!;
    const { policies, decisions, questions } = entry;

    sections.push(`## ${domain}`);
    sections.push(`\n### Policies (${policies.length} active)`);
    if (policies.length === 0) {
      sections.push("None.");
    } else {
      for (const p of policies) {
        const desc = p.description ? ` — ${truncateDesc(p.description)}` : "";
        sections.push(`- **${p.id}**${desc}`);
      }
    }

    sections.push(`\n### Decisions (${decisions.length})`);
    if (decisions.length === 0) {
      sections.push("None.");
    } else {
      for (const d of decisions) {
        const desc = d.description ? ` — ${truncateDesc(d.description)}` : "";
        sections.push(`- **${d.id}**${desc}`);
      }
    }

    sections.push(`\n### Open Questions (${questions.length})`);
    if (questions.length === 0) {
      sections.push("None.");
    } else {
      for (const q of questions) {
        const desc = q.description ? ` — ${truncateDesc(q.description)}` : "";
        sections.push(`- **${q.id}**${desc}`);
      }
    }
    sections.push("");
  }

  if (domains.length === 0) {
    sections.push("No domain data found.");
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// View helpers for ideate_get_workspace_status
// ---------------------------------------------------------------------------

async function buildProjectView(ctx: ToolContext): Promise<string> {
  const activeProject = ctx.db.prepare(`
    SELECT p.id, p.name, p.intent, p.appetite
    FROM projects p
    JOIN nodes n ON n.id = p.id
    WHERE n.status = 'active'
    ORDER BY n.id
    LIMIT 1
  `).get() as { id: string; name: string | null; intent: string; appetite: number | null } | undefined;

  if (!activeProject) {
    return "# Project View\n\nNo active project.";
  }

  const lines: string[] = [];
  lines.push("# Project View");
  lines.push("");
  lines.push(`**Project**: ${activeProject.id}${activeProject.name ? ` — ${activeProject.name}` : ""}`);
  lines.push(`**Intent**: ${activeProject.intent}`);
  lines.push(`**Appetite**: ${activeProject.appetite ?? "unset"}`);
  lines.push("");

  // Current phase
  const activePhase = ctx.db.prepare(`
    SELECT p.id, p.name, p.phase_type
    FROM phases p
    JOIN nodes n ON n.id = p.id
    WHERE n.status = 'active'
    ORDER BY n.id
    LIMIT 1
  `).get() as { id: string; name: string | null; phase_type: string } | undefined;

  if (activePhase) {
    // Work item progress for this phase
    const phaseWiRows = ctx.db.prepare(`
      SELECT n.status, COUNT(*) as count
      FROM work_items wi
      JOIN nodes n ON n.id = wi.id
      WHERE wi.phase = ?
      GROUP BY n.status
    `).all(activePhase.id) as Array<{ status: string | null; count: number }>;

    let total = 0;
    let done = 0;
    for (const row of phaseWiRows) {
      total += row.count;
      if (row.status === "done") done = row.count;
    }

    lines.push("## Current Phase");
    lines.push(`**Phase**: ${activePhase.id}${activePhase.name ? ` — ${activePhase.name}` : ""}`);
    lines.push(`**Type**: ${activePhase.phase_type}`);
    lines.push(`**Progress**: ${done}/${total} work items done`);
    lines.push("");
  } else {
    lines.push("## Current Phase");
    lines.push("No active phase.");
    lines.push("");
  }

  // Horizon — read from SQLite projects table
  const horizonRow = ctx.db.prepare(
    `SELECT p.horizon FROM projects p JOIN nodes n ON n.id = p.id WHERE n.status = 'active' LIMIT 1`
  ).get() as { horizon: string | null } | undefined;

  if (horizonRow?.horizon) {
    try {
      const horizon = JSON.parse(horizonRow.horizon) as { next?: string[]; later?: string[] };
      const nextIds = horizon.next ?? [];
      if (nextIds.length > 0) {
        lines.push("## Horizon");
        for (const phaseId of nextIds) {
          const phaseRow = ctx.db.prepare(
            `SELECT name FROM phases WHERE id = ?`
          ).get(phaseId) as { name: string | null } | undefined;
          const label = phaseRow?.name ? `${phaseId} — ${phaseRow.name}` : phaseId;
          lines.push(`- ${label}`);
        }
      } else {
        lines.push("## Horizon");
        lines.push("No phases planned.");
      }
    } catch {
      lines.push("## Horizon");
      lines.push("No phases planned.");
    }
  } else {
    lines.push("## Horizon");
    lines.push("No phases planned.");
  }

  return lines.join("\n");
}

async function buildPhaseView(ctx: ToolContext): Promise<string> {
  const activePhase = ctx.db.prepare(`
    SELECT p.id, p.name, p.phase_type, n.status
    FROM phases p
    JOIN nodes n ON n.id = p.id
    WHERE n.status = 'active'
    ORDER BY n.id
    LIMIT 1
  `).get() as { id: string; name: string | null; phase_type: string; status: string } | undefined;

  if (!activePhase) {
    return "# Phase View\n\nNo active phase.";
  }

  const lines: string[] = [];
  lines.push("# Phase View");
  lines.push("");
  lines.push(`**Phase**: ${activePhase.id}${activePhase.name ? ` — ${activePhase.name}` : ""}`);
  lines.push(`**Type**: ${activePhase.phase_type}`);
  lines.push(`**Status**: ${activePhase.status}`);
  lines.push("");

  // Work items in this phase
  const phaseItems = ctx.db.prepare(`
    SELECT wi.id, wi.title, wi.complexity, wi.work_item_type, n.status
    FROM work_items wi
    JOIN nodes n ON n.id = wi.id
    WHERE wi.phase = ?
    ORDER BY wi.id
  `).all(activePhase.id) as Array<{
    id: string;
    title: string;
    complexity: string | null;
    work_item_type: string | null;
    status: string | null;
  }>;

  if (phaseItems.length > 0) {
    lines.push("## Work Items");
    lines.push("");
    lines.push("| ID | Title | Status | Complexity | Type |");
    lines.push("|----|-------|--------|------------|------|");
    for (const item of phaseItems) {
      lines.push(
        `| ${item.id} | ${truncateDesc(item.title)} | ${item.status ?? "unknown"} | ${item.complexity ?? "-"} | ${item.work_item_type ?? "-"} |`
      );
    }
    lines.push("");
  } else {
    lines.push("## Work Items");
    lines.push("No work items assigned to this phase.");
    lines.push("");
  }

  // Dependencies between phase items
  if (phaseItems.length > 1) {
    const phaseItemIds = phaseItems.map((i) => i.id);
    const placeholders = phaseItemIds.map(() => "?").join(",");
    const deps = ctx.db.prepare(`
      SELECT source_id, target_id
      FROM edges
      WHERE edge_type = 'depends_on'
        AND source_id IN (${placeholders})
        AND target_id IN (${placeholders})
    `).all(...phaseItemIds, ...phaseItemIds) as Array<{ source_id: string; target_id: string }>;

    if (deps.length > 0) {
      lines.push("## Dependencies");
      for (const dep of deps) {
        lines.push(`- ${dep.source_id} depends on ${dep.target_id}`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// ideate_get_workspace_status
// ---------------------------------------------------------------------------

export async function handleGetWorkspaceStatus(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const view = (typeof args.view === "string" ? args.view : "workspace") as
    | "workspace"
    | "project"
    | "phase";

  if (view === "project") return buildProjectView(ctx);
  if (view === "phase") return buildPhaseView(ctx);

  // Read cycle number from domains/index.yaml (fall back to index.md for backward compatibility)
  const indexYamlPath = path.join(ctx.ideateDir, "domains", "index.yaml");
  const indexMdPath = path.join(ctx.ideateDir, "domains", "index.md");
  const indexContent = readFileSafe(indexYamlPath) ?? readFileSafe(indexMdPath);
  const cycleNumber = indexContent !== null ? parseCycleFromIndex(indexContent) : null;

  let wiByStatus: Record<string, number>;
  let criticalCount = 0;
  let significantCount = 0;
  let minorCount = 0;
  let openQRows: Array<{ domain: string; count: number }>;
  let activeProject: { id: string; name: string | null; intent: string; appetite: number | null } | undefined;
  let activePhase: { id: string; name: string | null; phase_type: string; intent: string } | undefined;

  if (ctx.adapter) {
    // Delegate aggregation queries to adapter
    const wiCounts = await ctx.adapter.countNodes({ type: "work_item" }, "status");
    wiByStatus = {};
    for (const entry of wiCounts) {
      wiByStatus[entry.key] = entry.count;
    }

    if (cycleNumber !== null) {
      const findingCounts = await ctx.adapter.countNodes(
        { type: "finding", cycle: cycleNumber },
        "severity"
      );
      for (const entry of findingCounts) {
        if (entry.key === "critical") criticalCount = entry.count;
        else if (entry.key === "significant") significantCount = entry.count;
        else if (entry.key === "minor") minorCount = entry.count;
      }
    }

    // Get open questions per domain via getDomainState
    const domainState = await ctx.adapter.getDomainState();
    const openQMap: Record<string, number> = {};
    for (const [domain, entry] of domainState) {
      if (entry.questions.length > 0) {
        openQMap[domain] = entry.questions.length;
      }
    }
    openQRows = Object.entries(openQMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, count]) => ({ domain, count }));

    // Active project
    activeProject = undefined;
    const projectResult = await ctx.adapter.queryNodes(
      { type: "project", status: "active" },
      1,
      0
    );
    if (projectResult.nodes.length > 0) {
      const projectNode = await ctx.adapter.getNode(projectResult.nodes[0].node.id);
      if (projectNode) {
        activeProject = {
          id: projectNode.id,
          name: (projectNode.properties.name as string | null) ?? null,
          intent: (projectNode.properties.intent as string) ?? "",
          appetite: (projectNode.properties.appetite as number | null) ?? null,
        };
      }
    }

    // Active phase
    activePhase = undefined;
    const phaseResult = await ctx.adapter.queryNodes(
      { type: "phase", status: "active" },
      1,
      0
    );
    if (phaseResult.nodes.length > 0) {
      const phaseNode = await ctx.adapter.getNode(phaseResult.nodes[0].node.id);
      if (phaseNode) {
        activePhase = {
          id: phaseNode.id,
          name: (phaseNode.properties.name as string | null) ?? null,
          phase_type: (phaseNode.properties.phase_type as string) ?? "",
          intent: (phaseNode.properties.intent as string) ?? "",
        };
      }
    }
  } else {
    // Fallback: direct SQLite path
    const wiCounts = ctx.db.prepare(`
      SELECT n.status, COUNT(*) as count
      FROM nodes n
      WHERE n.type = 'work_item'
      GROUP BY n.status
    `).all() as Array<{ status: string | null; count: number }>;

    wiByStatus = {};
    for (const row of wiCounts) {
      const s = row.status ?? "unknown";
      wiByStatus[s] = row.count;
    }

    if (cycleNumber !== null) {
      const countRows = ctx.db.prepare(`
        SELECT severity, COUNT(*) as count
        FROM findings WHERE cycle = ?
        GROUP BY severity
      `).all(cycleNumber) as Array<{ severity: string; count: number }>;
      for (const r of countRows) {
        if (r.severity === "critical") criticalCount = r.count;
        else if (r.severity === "significant") significantCount = r.count;
        else if (r.severity === "minor") minorCount = r.count;
      }
    }

    openQRows = ctx.db.prepare(`
      SELECT dq.domain, COUNT(*) as count
      FROM domain_questions dq
      JOIN nodes n ON n.id = dq.id
      WHERE n.status = 'open'
      GROUP BY dq.domain
      ORDER BY dq.domain
    `).all() as Array<{ domain: string; count: number }>;

    activeProject = ctx.db.prepare(`
      SELECT p.id, p.name, p.intent, p.appetite
      FROM projects p
      JOIN nodes n ON n.id = p.id
      WHERE n.status = 'active'
      ORDER BY n.id
      LIMIT 1
    `).get() as { id: string; name: string | null; intent: string; appetite: number | null } | undefined;

    activePhase = ctx.db.prepare(`
      SELECT p.id, p.name, p.phase_type, p.intent
      FROM phases p
      JOIN nodes n ON n.id = p.id
      WHERE n.status = 'active'
      ORDER BY n.id
      LIMIT 1
    `).get() as { id: string; name: string | null; phase_type: string; intent: string } | undefined;
  }

  // Compute aggregate totals
  let wiTotal = 0;
  for (const count of Object.values(wiByStatus)) {
    wiTotal += count;
  }

  const wiDone = wiByStatus["done"] ?? 0;
  const wiPending = (wiByStatus["pending"] ?? 0) + (wiByStatus["not_started"] ?? 0);
  const wiBlocked = wiByStatus["blocked"] ?? 0;
  const wiInProgress = wiByStatus["in_progress"] ?? 0;
  const wiObsolete = wiByStatus["obsolete"] ?? 0;

  const totalOpenQ = openQRows.reduce((sum, r) => sum + r.count, 0);

  // Build dashboard
  const lines: string[] = [];

  lines.push("# Workspace Status Dashboard");
  lines.push("");
  lines.push(`**Current cycle**: ${cycleNumber ?? "unknown"}`);
  lines.push("");

  lines.push("## Work Items");
  lines.push(`- Total: ${wiTotal}`);
  lines.push(`- Done: ${wiDone}`);
  lines.push(`- In progress: ${wiInProgress}`);
  lines.push(`- Pending: ${wiPending}`);
  lines.push(`- Blocked: ${wiBlocked}`);
  lines.push(`- Obsolete: ${wiObsolete}`);
  // Include any other statuses not covered above
  for (const [status, count] of Object.entries(wiByStatus)) {
    if (!["done", "pending", "not_started", "blocked", "in_progress", "obsolete"].includes(status)) {
      lines.push(`- ${status}: ${count}`);
    }
  }
  lines.push("");

  lines.push("## Latest Cycle Findings");
  if (cycleNumber !== null) {
    lines.push(`(Cycle ${cycleNumber})`);
  }
  lines.push(`- Critical: ${criticalCount}`);
  lines.push(`- Significant: ${significantCount}`);
  lines.push(`- Minor: ${minorCount}`);
  lines.push("");

  lines.push("## Open Domain Questions");
  lines.push(`Total: ${totalOpenQ}`);
  if (openQRows.length > 0) {
    for (const row of openQRows) {
      lines.push(`- ${row.domain}: ${row.count}`);
    }
  } else {
    lines.push("None.");
  }

  if (activeProject) {
    lines.push("");
    lines.push("## Active Project");
    lines.push(`- ID: ${activeProject.id}`);
    if (activeProject.name !== null && activeProject.name !== undefined) {
      lines.push(`- Name: ${activeProject.name}`);
    }
    lines.push(`- Intent: ${activeProject.intent}`);
    lines.push(`- Appetite: ${activeProject.appetite ?? "unset"}`);
  }

  if (activePhase) {
    lines.push("");
    lines.push("## Current Phase");
    lines.push(`- ID: ${activePhase.id}`);
    if (activePhase.name !== null && activePhase.name !== undefined) {
      lines.push(`- Name: ${activePhase.name}`);
    }
    lines.push(`- Type: ${activePhase.phase_type}`);
    lines.push(`- Intent: ${activePhase.intent}`);
  }

  return lines.join("\n");
}
