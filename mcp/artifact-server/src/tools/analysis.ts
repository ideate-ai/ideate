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

  if (!ctx.adapter) {
    throw new Error(
      "handleGetConvergenceStatus requires ctx.adapter to be set. " +
        "This is a configuration error — the server and all tests must provide an adapter."
    );
  }

  // Delegate storage operations to adapter
  const convergenceData = await ctx.adapter.getConvergenceData(cycleNumber);
  findingsBySeverity = convergenceData.findings_by_severity;
  cycleSummaryContent = convergenceData.cycle_summary_content;

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

  if (!ctx.adapter) {
    throw new Error(
      "handleGetDomainState requires ctx.adapter to be set. " +
        "This is a configuration error — the server and all tests must provide an adapter."
    );
  }

  // Delegate to adapter
  domainMap = await ctx.adapter.getDomainState(domainsFilter ?? undefined);

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
  if (!ctx.adapter) {
    throw new Error(
      "buildProjectView requires ctx.adapter to be set. " +
        "This is a configuration error — the server and all tests must provide an adapter."
    );
  }

  // Delegate to adapter
  const projectResult = await ctx.adapter.queryNodes({ type: "project", status: "active" }, 1, 0);
  let activeProject: { id: string; name: string | null; intent: string; appetite: number | null } | undefined;
  let activeProjectNode: Awaited<ReturnType<typeof ctx.adapter.getNode>> = null;
  if (projectResult.nodes.length > 0) {
    activeProjectNode = await ctx.adapter.getNode(projectResult.nodes[0].node.id);
    if (activeProjectNode) {
      activeProject = {
        id: activeProjectNode.id,
        name: (activeProjectNode.properties.name as string | null) ?? null,
        intent: (activeProjectNode.properties.intent as string) ?? "",
        appetite: (activeProjectNode.properties.appetite as number | null) ?? null,
      };
    }
  }

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

  const phaseResult = await ctx.adapter.queryNodes({ type: "phase", status: "active" }, 1, 0);
  if (phaseResult.nodes.length > 0) {
    const phaseNode = await ctx.adapter.getNode(phaseResult.nodes[0].node.id);
    if (phaseNode) {
      const activePhaseId = phaseNode.id;
      const phaseName = (phaseNode.properties.name as string | null) ?? null;
      const phaseType = (phaseNode.properties.phase_type as string) ?? "";

      const wiCounts = await ctx.adapter.countNodes({ type: "work_item", phase: activePhaseId }, "status");
      let total = 0;
      let done = 0;
      for (const entry of wiCounts) {
        total += entry.count;
        if (entry.key === "done") done = entry.count;
      }

      lines.push("## Current Phase");
      lines.push(`**Phase**: ${activePhaseId}${phaseName ? ` — ${phaseName}` : ""}`);
      lines.push(`**Type**: ${phaseType}`);
      lines.push(`**Progress**: ${done}/${total} work items done`);
      lines.push("");
    }
  } else {
    lines.push("## Current Phase");
    lines.push("No active phase.");
    lines.push("");
  }

  // Horizon — read from project node properties (reuse the node fetched above)
  const horizonRaw = activeProjectNode?.properties.horizon;
  let horizonNext: string[] = [];
  if (horizonRaw) {
    try {
      const horizon =
        typeof horizonRaw === "string"
          ? (JSON.parse(horizonRaw) as { next?: string[] })
          : (horizonRaw as { next?: string[] });
      horizonNext = horizon.next ?? [];
    } catch {
      horizonNext = [];
    }
  }

  lines.push("## Horizon");
  if (horizonNext.length === 0) {
    lines.push("No phases planned.");
  } else {
    const horizonNodes = await ctx.adapter.getNodes(horizonNext);
    for (const phaseId of horizonNext) {
      const node = horizonNodes.get(phaseId);
      const name = (node?.properties.name as string | null) ?? null;
      lines.push(`- ${name ? `${phaseId} — ${name}` : phaseId}`);
    }
  }

  return lines.join("\n");
}

async function buildPhaseView(ctx: ToolContext): Promise<string> {
  if (!ctx.adapter) {
    throw new Error(
      "buildPhaseView requires ctx.adapter to be set. " +
        "This is a configuration error — the server and all tests must provide an adapter."
    );
  }

  // Delegate to adapter
  const phaseResult = await ctx.adapter.queryNodes({ type: "phase", status: "active" }, 1, 0);

  if (phaseResult.nodes.length === 0) {
    return "# Phase View\n\nNo active phase.";
  }

  const phaseNode = await ctx.adapter.getNode(phaseResult.nodes[0].node.id);
  if (!phaseNode) {
    return "# Phase View\n\nNo active phase.";
  }

  const activePhaseId = phaseNode.id;
  const phaseName = (phaseNode.properties.name as string | null) ?? null;
  const phaseType = (phaseNode.properties.phase_type as string) ?? "";
  const phaseStatus = phaseNode.status ?? "unknown";

  const lines: string[] = [];
  lines.push("# Phase View");
  lines.push("");
  lines.push(`**Phase**: ${activePhaseId}${phaseName ? ` — ${phaseName}` : ""}`);
  lines.push(`**Type**: ${phaseType}`);
  lines.push(`**Status**: ${phaseStatus}`);
  lines.push("");

  // Work items in this phase
  const wiResult = await ctx.adapter.queryNodes({ type: "work_item", phase: activePhaseId }, 1000, 0);
  const wiIds = wiResult.nodes.map((n) => n.node.id);
  if (wiIds.length > 0) {
    const wiNodes = await ctx.adapter.getNodes(wiIds);

    lines.push("## Work Items");
    lines.push("");
    lines.push("| ID | Title | Status | Complexity | Type |");
    lines.push("|----|-------|--------|------------|------|");
    for (const nodeId of wiIds) {
      const node = wiNodes.get(nodeId);
      if (!node) continue;
      const title = truncateDesc((node.properties.title as string) ?? "");
      const complexity = (node.properties.complexity as string | null) ?? "-";
      const work_item_type = (node.properties.work_item_type as string | null) ?? "-";
      lines.push(
        `| ${node.id} | ${title} | ${node.status ?? "unknown"} | ${complexity} | ${work_item_type} |`
      );
    }
    lines.push("");
  } else {
    lines.push("## Work Items");
    lines.push("No work items assigned to this phase.");
    lines.push("");
  }

  // Dependencies between phase items
  if (wiIds.length > 1) {
    const wiIdSet = new Set(wiIds);
    const depLines: string[] = [];
    for (const wiId of wiIds) {
      const edges = await ctx.adapter.getEdges(wiId, "outgoing");
      for (const edge of edges) {
        if (edge.edge_type === "depends_on" && wiIdSet.has(edge.target_id)) {
          depLines.push(`- ${edge.source_id} depends on ${edge.target_id}`);
        }
      }
    }
    if (depLines.length > 0) {
      lines.push("## Dependencies");
      for (const line of depLines) lines.push(line);
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

  if (!ctx.adapter) {
    throw new Error(
      "handleGetWorkspaceStatus requires ctx.adapter to be set. " +
        "This is a configuration error — the server and all tests must provide an adapter."
    );
  }

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
