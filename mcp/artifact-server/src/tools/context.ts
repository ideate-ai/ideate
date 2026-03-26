import * as fs from "fs";
import * as path from "path";
import { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WorkItemRow {
  id: string;
  type: string;
  file_path: string;
  status: string | null;
  cycle_created: number | null;
  cycle_modified: number | null;
  title: string;
  complexity: string | null;
  scope: string | null;
  depends: string | null;
  blocks: string | null;
  criteria: string | null;
  module: string | null;
  domain: string | null;
  notes: string | null;
}

interface ModuleSpecRow {
  id: string;
  name: string;
  scope: string | null;
  provides: string | null;
  requires: string | null;
  boundary_rules: string | null;
}

interface DomainPolicyRow {
  id: string;
  domain: string;
  derived_from: string | null;
  established: string | null;
  amended: string | null;
  description: string | null;
}

interface ResearchFindingRow {
  id: string;
  topic: string;
  date: string | null;
  content: string | null;
  sources: string | null;
}

interface DocumentArtifactRow {
  id: string;
  title: string | null;
  cycle: number | null;
  content: string | null;
  file_path: string;
}

interface GuidingPrincipleRow {
  id: string;
  name: string;
  description: string | null;
  file_path: string;
}

interface ConstraintRow {
  id: string;
  category: string;
  description: string | null;
  file_path: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJsonArray(val: string | null | undefined): string[] {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function truncateLines(text: string, maxLines: number): { text: string; truncated: boolean; total: number } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return { text, truncated: false, total: lines.length };
  }
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    total: lines.length,
  };
}

/** Normalize a work item ID to handle both "WI-185" and "185" forms. */
function normalizeWorkItemId(raw: string): string[] {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  // "185" → also try "WI-185"
  if (/^\d+$/.test(trimmed)) {
    candidates.push(`WI-${trimmed}`);
  }
  // "WI-185" → also try "185"
  const prefixMatch = trimmed.match(/^WI-(\d+)$/i);
  if (prefixMatch) {
    candidates.push(prefixMatch[1]);
  }
  return candidates;
}

/** Walk a directory recursively, returning all file paths. */
function walkDir(dir: string, extensions: string[]): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  function walk(current: string, depth: number): void {
    if (depth > 8) return; // guard against very deep trees
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__pycache__") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }

  walk(dir, 0);
  return results;
}

/** Extract export/function/class declarations from source file content. */
function extractExports(content: string, ext: string): string[] {
  const exports: string[] = [];

  if (ext === ".ts" || ext === ".js") {
    // TypeScript / JavaScript patterns
    const patterns = [
      /^export\s+(?:async\s+)?function\s+(\w+)/gm,
      /^export\s+(?:const|let|var)\s+(\w+)/gm,
      /^export\s+(?:class|interface|type|enum)\s+(\w+)/gm,
      /^export\s+default\s+(?:function\s+)?(\w+)/gm,
      /^export\s+\{\s*([^}]+)\}/gm,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1]?.trim();
        if (name && name.length < 80) {
          exports.push(name);
        }
      }
    }
  } else if (ext === ".py") {
    // Python patterns
    const patterns = [
      /^def\s+(\w+)\s*\(/gm,
      /^class\s+(\w+)/gm,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const name = match[1]?.trim();
        if (name && !name.startsWith("_")) {
          exports.push(name);
        }
      }
    }
  }

  // Deduplicate
  return [...new Set(exports)].slice(0, 20);
}

/** Map file extension to language display name. */
function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "TypeScript",
    ".js": "JavaScript",
    ".py": "Python",
    ".sh": "Shell",
    ".json": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
  };
  return map[ext] ?? ext.slice(1).toUpperCase();
}

// ---------------------------------------------------------------------------
// handleGetWorkItemContext
// ---------------------------------------------------------------------------

export async function handleGetWorkItemContext(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  const workItemIdRaw = args.work_item_id;

  if (typeof workItemIdRaw !== "string" || workItemIdRaw.trim() === "") {
    throw new Error('Required argument "work_item_id" is missing or empty.');
  }

  const idCandidates = normalizeWorkItemId(workItemIdRaw);

  // -------------------------------------------------------------------------
  // 1. Look up work item (JOIN nodes + work_items)
  // -------------------------------------------------------------------------

  const placeholders = idCandidates.map(() => "?").join(", ");
  const workItemRow = ctx.db
    .prepare(
      `SELECT n.id, n.type, n.file_path, n.status, n.cycle_created, n.cycle_modified,
              w.title, w.complexity, w.scope, w.depends, w.blocks, w.criteria, w.module, w.domain, w.notes
       FROM nodes n JOIN work_items w ON w.id = n.id
       WHERE n.id IN (${placeholders})
       LIMIT 1`
    )
    .get(...idCandidates) as WorkItemRow | undefined;

  if (!workItemRow) {
    throw new Error(
      `Work item not found: "${workItemIdRaw}". Tried IDs: ${idCandidates.join(", ")}`
    );
  }

  const sections: string[] = [];

  // -------------------------------------------------------------------------
  // 2. Work Item section
  // -------------------------------------------------------------------------

  const criteria = parseJsonArray(workItemRow.criteria);
  const depends = parseJsonArray(workItemRow.depends);
  const blocks = parseJsonArray(workItemRow.blocks);

  let scopeEntries: Array<{ path: string; op: string }> = [];
  try {
    const parsed = workItemRow.scope ? JSON.parse(workItemRow.scope) : [];
    scopeEntries = Array.isArray(parsed) ? parsed : [];
  } catch {
    // ignore
  }

  const workItemSection: string[] = [
    `## Work Item: ${workItemRow.id} — ${workItemRow.title}`,
    "",
    `**Status**: ${workItemRow.status ?? "pending"}`,
    `**Complexity**: ${workItemRow.complexity ?? "unknown"}`,
    `**Domain**: ${workItemRow.domain ?? "unassigned"}`,
    `**Module**: ${workItemRow.module ?? "unassigned"}`,
    `**File**: ${workItemRow.file_path}`,
  ];

  if (workItemRow.cycle_created != null) {
    workItemSection.push(`**Cycle Created**: ${workItemRow.cycle_created}`);
  }

  if (depends.length > 0) {
    workItemSection.push("", `**Depends on**: ${depends.join(", ")}`);
  }
  if (blocks.length > 0) {
    workItemSection.push(`**Blocks**: ${blocks.join(", ")}`);
  }

  if (scopeEntries.length > 0) {
    workItemSection.push("", "**Scope**:");
    for (const entry of scopeEntries) {
      workItemSection.push(`- \`${entry.path}\` (${entry.op})`);
    }
  }

  if (criteria.length > 0) {
    workItemSection.push("", "**Acceptance Criteria**:");
    for (const c of criteria) {
      workItemSection.push(`- ${c}`);
    }
  }

  sections.push(workItemSection.join("\n"));

  // -------------------------------------------------------------------------
  // 3. Read implementation notes from disk
  // -------------------------------------------------------------------------

  if (workItemRow.notes) {
    const projectRoot = path.dirname(path.dirname(ctx.ideateDir));
    const notesPath = path.resolve(projectRoot, workItemRow.notes);
    try {
      const notesContent = fs.readFileSync(notesPath, "utf8");
      const { text: notesText, truncated, total } = truncateLines(notesContent, 200);
      const notesSection: string[] = [
        `## Implementation Notes`,
        "",
        `> Source: \`${notesPath}\``,
        "",
        notesText,
      ];
      if (truncated) {
        notesSection.push(
          "",
          `*(truncated — showing 200 of ${total} lines; read the full file for complete notes)*`
        );
      }
      sections.push(notesSection.join("\n"));
    } catch {
      sections.push(
        `## Implementation Notes\n\n> Notes file not found: \`${notesPath}\``
      );
    }
  }

  // -------------------------------------------------------------------------
  // 4. Find module spec via belongs_to_module edge
  // -------------------------------------------------------------------------

  const moduleRow = ctx.db
    .prepare(
      `SELECT ms.id, ms.name, ms.scope, ms.provides, ms.requires, ms.boundary_rules
       FROM edges e
       JOIN nodes n ON n.id = e.target_id
       JOIN module_specs ms ON ms.id = n.id
       WHERE e.source_id = ? AND e.edge_type = 'belongs_to_module'
       LIMIT 1`
    )
    .get(workItemRow.id) as ModuleSpecRow | undefined;

  if (moduleRow) {
    const provides = parseJsonArray(moduleRow.provides);
    const requires = parseJsonArray(moduleRow.requires);
    const boundaryRules = parseJsonArray(moduleRow.boundary_rules);

    const moduleSection: string[] = [
      `## Module Spec: ${moduleRow.name}`,
      "",
    ];

    if (moduleRow.scope) {
      moduleSection.push(`**Scope**: ${moduleRow.scope}`, "");
    }

    if (provides.length > 0) {
      moduleSection.push("**Provides**:");
      for (const p of provides) {
        moduleSection.push(`- ${p}`);
      }
      moduleSection.push("");
    }

    if (requires.length > 0) {
      moduleSection.push("**Requires**:");
      for (const r of requires) {
        moduleSection.push(`- ${r}`);
      }
      moduleSection.push("");
    }

    if (boundaryRules.length > 0) {
      moduleSection.push("**Boundary Rules**:");
      for (const rule of boundaryRules) {
        moduleSection.push(`- ${rule}`);
      }
    }

    sections.push(moduleSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 5. Find domain policies where domain = work_item.domain
  // -------------------------------------------------------------------------

  if (workItemRow.domain) {
    const policyRows = ctx.db
      .prepare(
        `SELECT dp.id, dp.domain, dp.derived_from, dp.established, dp.amended, dp.description
         FROM domain_policies dp
         WHERE dp.domain = ?
         ORDER BY dp.id`
      )
      .all(workItemRow.domain) as DomainPolicyRow[];

    if (policyRows.length > 0) {
      const policySection: string[] = [
        `## Domain Policies (${workItemRow.domain})`,
        "",
      ];

      for (const policy of policyRows) {
        policySection.push(`### ${policy.id}`);
        if (policy.description) {
          const { text: descText, truncated, total } = truncateLines(policy.description, 30);
          policySection.push(descText);
          if (truncated) {
            policySection.push(`*(description truncated at 30 of ${total} lines)*`);
          }
        }
        const details: string[] = [];
        if (policy.established) details.push(`Established: ${policy.established}`);
        if (policy.amended) details.push(`Amended: ${policy.amended}`);
        if (details.length > 0) {
          policySection.push(`*${details.join(" | ")}*`);
        }
        policySection.push("");
      }

      sections.push(policySection.join("\n"));
    }
  }

  // -------------------------------------------------------------------------
  // 6. Find relevant research by topic match
  // -------------------------------------------------------------------------

  const researchRows = ctx.db
    .prepare(
      `SELECT rf.id, rf.topic, rf.date, rf.content, rf.sources
       FROM research_findings rf
       JOIN nodes n ON n.id = rf.id
       ORDER BY rf.id`
    )
    .all() as ResearchFindingRow[];

  // Filter by topic relevance: match against domain or module name
  const relevanceTokens: string[] = [];
  if (workItemRow.domain) relevanceTokens.push(workItemRow.domain.toLowerCase());
  if (workItemRow.module) relevanceTokens.push(workItemRow.module.toLowerCase());

  const relevantResearch = relevanceTokens.length > 0
    ? researchRows.filter((r) => {
        const topicLower = r.topic.toLowerCase();
        return relevanceTokens.some((t) => topicLower.includes(t));
      })
    : researchRows.slice(0, 3); // fallback: first 3 if no domain/module

  if (relevantResearch.length > 0) {
    const researchSection: string[] = [
      `## Relevant Research`,
      "",
    ];

    let researchLineCount = 0;
    const MAX_RESEARCH_LINES = 150;

    for (const research of relevantResearch) {
      if (researchLineCount >= MAX_RESEARCH_LINES) {
        researchSection.push(
          `*(additional research entries omitted — total matched: ${relevantResearch.length})*`
        );
        break;
      }

      researchSection.push(`### ${research.id}: ${research.topic}`);
      researchLineCount += 2;

      if (research.date) {
        researchSection.push(`*Date: ${research.date}*`);
        researchLineCount++;
      }

      if (research.content) {
        const remaining = MAX_RESEARCH_LINES - researchLineCount;
        const { text: contentText, truncated, total } = truncateLines(research.content, remaining);
        researchSection.push(contentText);
        researchLineCount += contentText.split("\n").length;
        if (truncated) {
          researchSection.push(
            `*(truncated — showing ${remaining} of ${total} lines)*`
          );
          researchLineCount++;
        }
      }

      const sources = parseJsonArray(research.sources);
      if (sources.length > 0) {
        researchSection.push("", `**Sources**: ${sources.join(", ")}`);
        researchLineCount += 2;
      }

      researchSection.push("");
      researchLineCount++;
    }

    sections.push(researchSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 7. Assemble final response, enforcing 500-line target
  // -------------------------------------------------------------------------

  let result = sections.join("\n\n---\n\n");

  const totalLines = result.split("\n").length;
  if (totalLines > 500) {
    // Trim the last section (research) first
    const trimmedLines = result.split("\n").slice(0, 500);
    result =
      trimmedLines.join("\n") +
      `\n\n*(response truncated at 500 lines; total was ${totalLines} lines)*`;
  }

  return result;
}

// ---------------------------------------------------------------------------
// handleGetContextPackage
// ---------------------------------------------------------------------------

export async function handleGetContextPackage(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  void args; // args unused now

  const sections: string[] = [];
  const fullDocPaths: Array<{ label: string; path: string }> = [];

  // -------------------------------------------------------------------------
  // 1. Architecture document
  // -------------------------------------------------------------------------

  const archRow = ctx.db
    .prepare(
      `SELECT da.id, da.title, da.cycle, da.content, n.file_path
       FROM document_artifacts da
       JOIN nodes n ON n.id = da.id
       WHERE n.type = 'architecture'
       ORDER BY n.id
       LIMIT 1`
    )
    .get() as DocumentArtifactRow | undefined;

  if (archRow) {
    fullDocPaths.push({ label: "Architecture", path: archRow.file_path });

    if (archRow.content) {
      const archLines = archRow.content.split("\n");
      const archSection: string[] = [`## Architecture`];

      if (archLines.length <= 300) {
        archSection.push("", archRow.content);
      } else {
        // Provide a component/interface summary by scanning headings and key lines
        archSection.push(
          "",
          `> Full document: \`${archRow.file_path}\` (${archLines.length} lines — summary shown below)`,
          ""
        );

        // Extract headings and first sentence of each section
        let inSection = false;
        let sectionLines = 0;
        const MAX_ARCH_SUMMARY_LINES = 150;
        let summaryCount = 0;

        for (const line of archLines) {
          if (summaryCount >= MAX_ARCH_SUMMARY_LINES) break;
          if (/^#{1,3}\s/.test(line)) {
            archSection.push(line);
            summaryCount++;
            inSection = true;
            sectionLines = 0;
          } else if (inSection && sectionLines < 3 && line.trim()) {
            archSection.push(line);
            summaryCount++;
            sectionLines++;
          }
        }
      }

      sections.push(archSection.join("\n"));
    }
  } else {
    sections.push(`## Architecture\n\n*No architecture document found in the index.*`);
  }

  // -------------------------------------------------------------------------
  // 2. Guiding Principles
  // -------------------------------------------------------------------------

  const principleRows = ctx.db
    .prepare(
      `SELECT gp.id, gp.name, gp.description, n.file_path
       FROM guiding_principles gp
       JOIN nodes n ON n.id = gp.id
       ORDER BY n.id`
    )
    .all() as GuidingPrincipleRow[];

  if (principleRows.length > 0) {
    const principleSection: string[] = [`## Guiding Principles`, ""];

    for (let i = 0; i < principleRows.length; i++) {
      const gp = principleRows[i];
      fullDocPaths.push({ label: `Principle: ${gp.name}`, path: gp.file_path });
      principleSection.push(`### ${i + 1}. ${gp.name}`);
      if (gp.description) {
        const { text, truncated, total } = truncateLines(gp.description, 20);
        principleSection.push(text);
        if (truncated) {
          principleSection.push(`*(truncated — showing 20 of ${total} lines)*`);
        }
      }
      principleSection.push("");
    }

    sections.push(principleSection.join("\n"));
  } else {
    sections.push(`## Guiding Principles\n\n*No guiding principles found in the index.*`);
  }

  // -------------------------------------------------------------------------
  // 3. Constraints
  // -------------------------------------------------------------------------

  const constraintRows = ctx.db
    .prepare(
      `SELECT c.id, c.category, c.description, n.file_path
       FROM constraints c
       JOIN nodes n ON n.id = c.id
       ORDER BY c.category, n.id`
    )
    .all() as ConstraintRow[];

  if (constraintRows.length > 0) {
    const constraintSection: string[] = [`## Constraints`, ""];

    let currentCategory = "";
    for (const constraint of constraintRows) {
      fullDocPaths.push({ label: `Constraint: ${constraint.id}`, path: constraint.file_path });

      if (constraint.category !== currentCategory) {
        currentCategory = constraint.category;
        constraintSection.push(`### ${currentCategory}`);
      }

      constraintSection.push(`**${constraint.id}**`);
      if (constraint.description) {
        const { text, truncated, total } = truncateLines(constraint.description, 10);
        constraintSection.push(text);
        if (truncated) {
          constraintSection.push(`*(truncated — showing 10 of ${total} lines)*`);
        }
      }
      constraintSection.push("");
    }

    sections.push(constraintSection.join("\n"));
  } else {
    sections.push(`## Constraints\n\n*No constraints found in the index.*`);
  }

  // -------------------------------------------------------------------------
  // 4. Source Code Index
  // -------------------------------------------------------------------------

  // Derive project source root: ideateDir is typically <project>/.ideate/
  // or the specs dir passed in. The project root is typically 2 levels up.
  const projectRoot = path.dirname(path.dirname(ctx.ideateDir));

  // Look for source directories: src/, lib/, agents/, skills/, scripts/
  const SOURCE_DIRS = ["src", "lib", "agents", "skills", "scripts", "mcp"];
  const SOURCE_EXTS = [".ts", ".js", ".py"];

  const sourceFiles: Array<{ file: string; relPath: string; ext: string }> = [];

  for (const srcDir of SOURCE_DIRS) {
    const fullSrcDir = path.join(projectRoot, srcDir);
    const files = walkDir(fullSrcDir, SOURCE_EXTS);
    for (const file of files) {
      sourceFiles.push({
        file,
        relPath: path.relative(projectRoot, file),
        ext: path.extname(file),
      });
    }
  }

  if (sourceFiles.length > 0) {
    const indexSection: string[] = [
      `## Source Code Index`,
      "",
      `| File | Language | Key Exports |`,
      `|------|----------|-------------|`,
    ];

    const MAX_INDEX_FILES = 80;
    const shown = sourceFiles.slice(0, MAX_INDEX_FILES);

    for (const { file, relPath, ext } of shown) {
      const language = extToLanguage(ext);
      let exports: string[] = [];
      try {
        const content = fs.readFileSync(file, "utf8");
        exports = extractExports(content, ext);
      } catch {
        // skip unreadable files
      }
      const exportsStr = exports.length > 0 ? exports.slice(0, 8).join(", ") : "—";
      indexSection.push(`| \`${relPath}\` | ${language} | ${exportsStr} |`);
    }

    if (sourceFiles.length > MAX_INDEX_FILES) {
      indexSection.push(
        "",
        `*(showing ${MAX_INDEX_FILES} of ${sourceFiles.length} source files)*`
      );
    }

    sections.push(indexSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 5. Full Document Paths
  // -------------------------------------------------------------------------

  // Add architecture and other key document paths from the DB
  const allDocRows = ctx.db
    .prepare(
      `SELECT n.id, n.type, n.file_path, da.title
       FROM document_artifacts da
       JOIN nodes n ON n.id = da.id
       ORDER BY n.type, n.id`
    )
    .all() as Array<{ id: string; type: string; file_path: string; title: string | null }>;

  for (const doc of allDocRows) {
    const label = doc.title ? `${doc.type}: ${doc.title}` : `${doc.type}: ${doc.id}`;
    // Don't duplicate paths already captured
    if (!fullDocPaths.some((p) => p.path === doc.file_path)) {
      fullDocPaths.push({ label, path: doc.file_path });
    }
  }

  if (fullDocPaths.length > 0) {
    const pathSection: string[] = [`## Full Document Paths`, ""];

    for (const { label, path: docPath } of fullDocPaths) {
      pathSection.push(`- **${label}**: \`${docPath}\``);
    }

    sections.push(pathSection.join("\n"));
  }

  // -------------------------------------------------------------------------
  // 6. Assemble final response, target 500-800 lines
  // -------------------------------------------------------------------------

  let result = sections.join("\n\n---\n\n");

  const totalLines = result.split("\n").length;
  if (totalLines > 800) {
    const trimmedLines = result.split("\n").slice(0, 800);
    result =
      trimmedLines.join("\n") +
      `\n\n*(response truncated at 800 lines; total was ${totalLines} lines)*`;
  }

  return result;
}
