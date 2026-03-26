import * as fs from "fs";
import * as path from "path";
import { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function padCycle(n: number): string {
  return String(n).padStart(3, "0");
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

/**
 * Count bullet items under a named ## section in a markdown string.
 * A bullet is any line starting with `- ` (after optional whitespace).
 * Counting stops at the next ## heading (or end of file).
 */
function countBulletsUnderSection(content: string, sectionName: string): number {
  const lines = content.split("\n");
  let inSection = false;
  let count = 0;

  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (inSection) break; // hit next section
      if (line.replace(/^##\s+/, "").trim().toLowerCase() === sectionName.toLowerCase()) {
        inSection = true;
      }
      continue;
    }
    if (inSection && /^\s*-\s/.test(line)) {
      count++;
    }
  }
  return count;
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
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  const cycleNumber = args.cycle_number as number;
  const cyclePad = padCycle(cycleNumber);

  // Read spec-adherence.md
  const adherencePath = path.join(ctx.ideateDir, "archive", "cycles", cyclePad, "spec-adherence.md");
  const adherenceContent = readFileSafe(adherencePath);

  let principleResult: PrincipleResult;
  if (adherenceContent === null) {
    principleResult = { verdict: "unknown", source: "step3", warning: `file not found: ${adherencePath}` };
  } else {
    principleResult = parsePrincipleVerdict(adherenceContent);
  }

  // Read summary.md for finding counts
  const summaryPath = path.join(ctx.ideateDir, "archive", "cycles", cyclePad, "summary.md");
  const summaryContent = readFileSafe(summaryPath);

  let criticalCount = 0;
  let significantCount = 0;
  let minorCount = 0;
  let suggestionsCount = 0;

  if (summaryContent !== null) {
    criticalCount = countBulletsUnderSection(summaryContent, "Critical Findings");
    significantCount = countBulletsUnderSection(summaryContent, "Significant Findings");
    minorCount = countBulletsUnderSection(summaryContent, "Minor Findings");
    suggestionsCount = countBulletsUnderSection(summaryContent, "Suggestions");
  }

  const conditionA = criticalCount === 0 && significantCount === 0;
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

  // Query domain_policies (active: status not deprecated/superseded)
  const policiesStmt = ctx.db.prepare(`
    SELECT dp.id, dp.domain, dp.description, n.status
    FROM domain_policies dp
    JOIN nodes n ON n.id = dp.id
    WHERE (n.status IS NULL OR (n.status != 'deprecated' AND n.status != 'superseded'))
    ORDER BY dp.domain, dp.id
  `);
  const allPolicies = policiesStmt.all() as Array<{
    id: string;
    domain: string;
    description: string | null;
    status: string | null;
  }>;

  // Query domain_questions (open: status = open)
  const questionsStmt = ctx.db.prepare(`
    SELECT dq.id, dq.domain, dq.description, n.status
    FROM domain_questions dq
    JOIN nodes n ON n.id = dq.id
    WHERE n.status = 'open'
    ORDER BY dq.domain, dq.id
  `);
  const allQuestions = questionsStmt.all() as Array<{
    id: string;
    domain: string;
    description: string | null;
    status: string | null;
  }>;

  // Collect unique domains
  const domainSet = new Set<string>([
    ...allPolicies.map((p) => p.domain),
    ...allQuestions.map((q) => q.domain),
  ]);
  let domains = Array.from(domainSet).sort();

  // Apply optional filter
  if (domainsFilter && domainsFilter.length > 0) {
    domains = domains.filter((d) => domainsFilter.includes(d));
  }

  const sections: string[] = [];
  if (cycleNumber !== null) {
    sections.push(`Current cycle: ${cycleNumber}\n`);
  }

  for (const domain of domains) {
    const policies = allPolicies.filter((p) => p.domain === domain);
    const questions = allQuestions.filter((q) => q.domain === domain);

    sections.push(`## ${domain}`);
    sections.push(`\n### Policies (${policies.length} active)`);
    if (policies.length === 0) {
      sections.push("None.");
    } else {
      for (const p of policies) {
        const desc = p.description ? ` — ${p.description}` : "";
        sections.push(`- **${p.id}**${desc}`);
      }
    }

    sections.push(`\n### Open Questions (${questions.length})`);
    if (questions.length === 0) {
      sections.push("None.");
    } else {
      for (const q of questions) {
        const desc = q.description ? ` — ${q.description}` : "";
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
// ideate_get_project_status
// ---------------------------------------------------------------------------

export async function handleGetProjectStatus(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  void args; // args unused now

  // Read cycle number from domains/index.yaml (fall back to index.md for backward compatibility)
  const indexYamlPath = path.join(ctx.ideateDir, "domains", "index.yaml");
  const indexMdPath = path.join(ctx.ideateDir, "domains", "index.md");
  const indexContent = readFileSafe(indexYamlPath) ?? readFileSafe(indexMdPath);
  const cycleNumber = indexContent !== null ? parseCycleFromIndex(indexContent) : null;

  // Work item counts by status
  const wiCountsStmt = ctx.db.prepare(`
    SELECT n.status, COUNT(*) as count
    FROM nodes n
    WHERE n.type = 'work_item'
    GROUP BY n.status
  `);
  const wiCounts = wiCountsStmt.all() as Array<{ status: string | null; count: number }>;

  let wiTotal = 0;
  const wiByStatus: Record<string, number> = {};
  for (const row of wiCounts) {
    const s = row.status ?? "unknown";
    wiByStatus[s] = row.count;
    wiTotal += row.count;
  }

  // Derive named buckets
  const wiDone = wiByStatus["done"] ?? 0;
  const wiPending = (wiByStatus["pending"] ?? 0) + (wiByStatus["not_started"] ?? 0);
  const wiBlocked = wiByStatus["blocked"] ?? 0;
  const wiInProgress = wiByStatus["in_progress"] ?? 0;
  const wiObsolete = wiByStatus["obsolete"] ?? 0;

  // Finding counts from latest cycle summary.md (if cycle is known)
  let criticalCount = 0;
  let significantCount = 0;
  let minorCount = 0;
  let suggestionsCount = 0;

  if (cycleNumber !== null) {
    const cyclePad = padCycle(cycleNumber);
    const summaryPath = path.join(ctx.ideateDir, "archive", "cycles", cyclePad, "summary.md");
    const summaryContent = readFileSafe(summaryPath);
    if (summaryContent !== null) {
      criticalCount = countBulletsUnderSection(summaryContent, "Critical Findings");
      significantCount = countBulletsUnderSection(summaryContent, "Significant Findings");
      minorCount = countBulletsUnderSection(summaryContent, "Minor Findings");
      suggestionsCount = countBulletsUnderSection(summaryContent, "Suggestions");
    }
  }

  // Open questions per domain
  const openQStmt = ctx.db.prepare(`
    SELECT dq.domain, COUNT(*) as count
    FROM domain_questions dq
    JOIN nodes n ON n.id = dq.id
    WHERE n.status = 'open'
    GROUP BY dq.domain
    ORDER BY dq.domain
  `);
  const openQRows = openQStmt.all() as Array<{ domain: string; count: number }>;
  const totalOpenQ = openQRows.reduce((sum, r) => sum + r.count, 0);

  // Build dashboard
  const lines: string[] = [];

  lines.push("# Project Status Dashboard");
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
  lines.push(`- Suggestions: ${suggestionsCount}`);
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

  return lines.join("\n");
}
