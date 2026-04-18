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

// Maximum characters to include in a Step 3 "unknown format" content snippet.
const SNIPPET_MAX_CHARS = 200;

/**
 * Parse a principle adherence verdict from cycle summary content.
 *
 * Accepted patterns (step 1 — explicit tag, case-insensitive verdict keyword).
 * Both "Principle Adherence Verdict" and "Principle Violation Verdict" headings
 * are accepted (the latter is the legacy label). The bare "Principle Verdict"
 * heading is also accepted as a synonym (emitted by spec-reviewer skill and some
 * agent prompts). Each heading supports four formatting variants:
 *
 *   1. `**Principle Adherence Verdict**: Pass|Fail`
 *      (label bold, colon outside bold)
 *   2. `**Principle Adherence Verdict:** Pass|Fail`
 *      (label + colon inside bold)
 *   3. `Principle Adherence Verdict: Pass|Fail`
 *      (no bold, colon after label)
 *   4. `**Principle Adherence Verdict: Pass**` / `**Principle Adherence Verdict: Fail**`
 *      (all-bold — label, colon, and verdict keyword all inside bold tags)
 *   5. `**Principle Violation Verdict**: Pass|Fail`
 *      (legacy label — bold, colon outside bold)
 *   6. `**Principle Violation Verdict:** Pass|Fail`
 *      (legacy label — bold, colon inside bold)
 *   7. `Principle Violation Verdict: Pass|Fail`
 *      (legacy label — no bold)
 *   8. `**Principle Violation Verdict: Pass**` / `**Principle Violation Verdict: Fail**`
 *      (legacy all-bold variant — same regex as 4, the `(?:Adherence|Violation)`
 *      alternation covers both label variants)
 *   9. `Principle Verdict: Pass|Fail`
 *      (bare synonym — no bold, no Adherence/Violation qualifier)
 *  10. `**Principle Verdict: Pass**` / `**Principle Verdict: Fail**`
 *      (bare synonym all-bold variant)
 *
 * Note: verdicts other than Pass/Fail (e.g., Unknown, Inconclusive) produce verdict=unknown via the step3 fallback, not an explicit pattern match.
 *
 * Word-boundary anchors (`\b`) are applied after the verdict keyword so that
 * "Passed" / "Failed" / "Passthrough" do NOT match the Pass / Fail keywords.
 *
 * Step 2 falls back to scanning exact headings `## Principle Adherence`,
 * `## Principle Violation`, or `## Guiding Principle` section bodies for
 * emptiness (Pass) or subheadings/bullets (Fail). The heading text must match
 * exactly (no trailing words). Only the first STEP2_WINDOW_LINES non-empty lines
 * of the section body are examined; if the verdict line appears beyond the window
 * Step 2 falls through to Step 3.
 *
 * Step 3 returns `unknown` with a warning that names the patterns tried and
 * includes a ~200-char snippet of the actual content so callers can diagnose
 * why parsing failed.
 */
function parsePrincipleVerdict(content: string): PrincipleResult {
  // Step 1: look for explicit verdict tag (Principle Adherence or Principle Violation,
  // colon inside or outside bold, case-insensitive verdict keywords).
  // Patterns cover: **Label**: verdict, **Label:** verdict, Label: verdict,
  // and **Label: verdict** (all-bold — verdict keyword inside bold closing tags)
  // for both "Adherence" and "Violation" label variants.
  // \b after Pass/Fail prevents "Passed"/"Failed"/"Passthrough" from matching.
  const STEP1_PASS_RES = [
    /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict\*\*:\s*Pass\b/i,
    /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict:\*\*\s*Pass\b/i,
    /(?<!\*)Principle\s+(?:Adherence|Violation)\s+Verdict:\s*Pass\b(?!\*)/i,
    /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict:\s*Pass\b\*\*/i,
    // Bare synonym: "Principle Verdict:" (no Adherence/Violation qualifier)
    /(?<!\*)Principle\s+Verdict:\s*Pass\b(?!\*)/i,
    /\*\*Principle\s+Verdict:\s*Pass\b\*\*/i,
  ];
  const STEP1_FAIL_RES = [
    /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict\*\*:\s*Fail\b/i,
    /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict:\*\*\s*Fail\b/i,
    /(?<!\*)Principle\s+(?:Adherence|Violation)\s+Verdict:\s*Fail\b(?!\*)/i,
    /\*\*Principle\s+(?:Adherence|Violation)\s+Verdict:\s*Fail\b\*\*/i,
    // Bare synonym: "Principle Verdict:" (no Adherence/Violation qualifier)
    /(?<!\*)Principle\s+Verdict:\s*Fail\b(?!\*)/i,
    /\*\*Principle\s+Verdict:\s*Fail\b\*\*/i,
  ];

  for (const re of STEP1_PASS_RES) {
    if (re.test(content)) return { verdict: "pass", source: "step1" };
  }
  for (const re of STEP1_FAIL_RES) {
    if (re.test(content)) return { verdict: "fail", source: "step1" };
  }

  // Step 2: find ## Principle Adherence / ## Principle Violation / ## Guiding Principle section.
  // Only the first STEP2_WINDOW_LINES non-empty lines of the section body are examined;
  // if the verdict content appears beyond the window this step falls through to Step 3.
  const STEP2_WINDOW_LINES = 20;
  const lines = content.split("\n");
  let inSection = false;
  const sectionBodyLines: string[] = [];
  let nonEmptyCount = 0;
  let windowExceeded = false;

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (inSection) break; // hit next section
      const heading = line.replace(/^##\s+/, "").trim().toLowerCase();
      if (
        heading === "principle adherence" ||
        heading === "principle violation" ||
        heading === "guiding principle"
      ) {
        inSection = true;
      }
      continue;
    }
    if (inSection) {
      sectionBodyLines.push(line);
      if (line.trim() !== "") {
        nonEmptyCount++;
        if (nonEmptyCount > STEP2_WINDOW_LINES) {
          windowExceeded = true;
          break;
        }
      }
    }
  }

  if (inSection && !windowExceeded) {
    const body = sectionBodyLines.join("\n").trim();
    // "None." or empty body → Pass
    if (body === "" || /^none\.?\s*$/i.test(body)) {
      return { verdict: "pass", source: "step2" };
    }
    // Body has ### subheadings or bullet items → Fail
    if (/^###\s/m.test(body) || /^\s*-\s/m.test(body)) {
      return { verdict: "fail", source: "step2" };
    }
    // Body exists but doesn't match Pass/Fail patterns — fall through to step 3
  }

  // Step 3: unknown — enumerate the patterns tried and include a content snippet
  // so callers can diagnose why parsing failed.
  // Use single-quoted YAML scalar with '' to escape any internal single quotes,
  // ensuring the emitted YAML value is always parseable.
  // P-33: strip absolute .ideate/ paths from the snippet before emitting —
  // the snippet is diagnostic text visible to callers and must not leak
  // filesystem paths from the server environment.
  const rawSnippet = (
    content.length > SNIPPET_MAX_CHARS
      ? content.slice(0, SNIPPET_MAX_CHARS) + "..."
      : content
  ).replace(/\/[\w/.-]*\.ideate\//g, '<ideate-dir>/')
   .replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const patternsTriedDesc =
    "**Principle Adherence Verdict**: Pass|Fail, " +
    "**Principle Adherence Verdict:** Pass|Fail, " +
    "Principle Adherence Verdict: Pass|Fail, " +
    "**Principle Adherence Verdict: Pass|Fail** (all-bold), " +
    "**Principle Violation Verdict**: Pass|Fail, " +
    "**Principle Violation Verdict:** Pass|Fail, " +
    "Principle Violation Verdict: Pass|Fail, " +
    "Principle Verdict: Pass|Fail (bare synonym), " +
    "**Principle Verdict: Pass|Fail** (bare synonym all-bold), " +
    "## Principle Adherence|Violation|Guiding Principle (exact heading) section body heuristic";
  const warningText =
    `unexpected format; patterns tried: ${patternsTriedDesc}; ` +
    `content snippet: ${rawSnippet}`;
  // Escape internal single quotes for YAML single-quoted scalar
  const yamlSafeWarning = warningText.replace(/'/g, "''");
  return {
    verdict: "unknown",
    source: "step3",
    warning: yamlSafeWarning,
  };
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
    // P-33: do NOT emit absolute paths. Use artifact-type + relative path + filenames only.
    const checkedFiles = ["spec-adherence.yaml", "summary.yaml"];
    const paddedCycle = String(cycleNumber).padStart(3, "0");
    const warningText =
      `no cycle_summary found for cycle ${cycleNumber}; ` +
      `artifact type: cycle_summary; ` +
      `relative path: cycles/${paddedCycle}; ` +
      `checked filenames: ${checkedFiles.join(", ")}`;
    principleResult = {
      verdict: "unknown",
      source: "step3",
      warning: warningText.replace(/'/g, "''"),
    };
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
    // Use single-quoted YAML scalar; internal single quotes are already escaped as ''
    // by parsePrincipleVerdict, so this emission is always valid YAML.
    lines.push(`principle_verdict_warning: '${principleResult.warning}'`);
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
