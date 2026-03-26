#!/usr/bin/env tsx
/**
 * migrate-to-v3: One-time migration tool
 *
 * Converts an existing ideate v2 artifact directory (specs/ with markdown files
 * and work-items.yaml) to the v3 .ideate/ format (YAML artifacts + SQLite index).
 *
 * Usage: node migrate-to-v3.js --specs-dir <path> --output-dir <path> [--dry-run]
 *
 * This script is designed to be run ONCE per project. Individual migration steps
 * are idempotent (safe to re-run), but the script is not designed for incremental
 * or ongoing execution.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ---------------------------------------------------------------------------
// Migration context (passed explicitly to all helpers)
// ---------------------------------------------------------------------------

export interface MigrationContext {
  errors: string[];
  created: string[];
  ideateDir: string;
  sourceDir: string;
  dryRun: boolean;
  force: boolean;
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function tokenCount(content: string): number {
  return Math.floor(content.length / 4);
}

/**
 * Serialize a plain object to YAML.
 * This is a minimal hand-rolled serializer for the flat/shallow objects
 * produced by this script.  It handles:
 *   - null values  → "null"
 *   - strings      → block scalar (|) when multi-line, quoted when needed
 *   - numbers      → bare
 *   - arrays of strings/objects → block sequence
 *   - plain objects nested one level deep
 */
export function toYaml(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      lines.push(`${pad}${key}: null`);
    } else if (typeof value === "number") {
      lines.push(`${pad}${key}: ${value}`);
    } else if (typeof value === "boolean") {
      lines.push(`${pad}${key}: ${value}`);
    } else if (typeof value === "string") {
      if (value === "") {
        lines.push(`${pad}${key}: ""`);
      } else if (value.includes("\n")) {
        // Block scalar
        const escaped = value.trimEnd();
        lines.push(`${pad}${key}: |`);
        for (const ln of escaped.split("\n")) {
          lines.push(`${pad}  ${ln}`);
        }
      } else if (
        /^\s/.test(value) ||
        value.includes(":") ||
        value.includes("#") ||
        value.startsWith(">") ||
        value.startsWith("'") ||
        value.startsWith('"') ||
        value.startsWith("{") ||
        value.startsWith("[") ||
        value.startsWith("*") ||
        value.startsWith("&") ||
        value.startsWith("!") ||
        value.startsWith("|") ||
        value.includes("\t") ||
        /^\d/.test(value) ||
        value === "true" ||
        value === "false" ||
        value === "null" ||
        value === "yes" ||
        value === "no" ||
        value === "on" ||
        value === "off"
      ) {
        const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        lines.push(`${pad}${key}: "${escaped}"`);
      } else {
        lines.push(`${pad}${key}: ${value}`);
      }
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${key}: []`);
      } else {
        lines.push(`${pad}${key}:`);
        for (const item of value) {
          if (typeof item === "string") {
            if (
              item.includes("\n") ||
              item.startsWith('"') ||
              item.includes(":") ||
              item.includes("#") ||
              item.includes("\t") ||
              /^\s/.test(item) ||
              item.startsWith(">") ||
              item.startsWith("'") ||
              item.startsWith("{") ||
              item.startsWith("[") ||
              item.startsWith("*") ||
              item.startsWith("&") ||
              item.startsWith("!") ||
              item.startsWith("|") ||
              /^\d/.test(item) ||
              item === "true" ||
              item === "false" ||
              item === "null" ||
              item === "yes" ||
              item === "no" ||
              item === "on" ||
              item === "off"
            ) {
              const escaped = item.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
              lines.push(`${pad}  - "${escaped}"`);
            } else {
              lines.push(`${pad}  - ${item}`);
            }
          } else if (typeof item === "object" && item !== null) {
            const sub = item as Record<string, unknown>;
            const subKeys = Object.keys(sub);
            if (subKeys.length === 0) {
              lines.push(`${pad}  - {}`);
            } else {
              const firstKey = subKeys[0];
              const firstVal = sub[firstKey];
              const rest = subKeys.slice(1);
              const firstStr =
                typeof firstVal === "string"
                  ? firstVal.includes(":") || firstVal.includes('"')
                    ? `"${firstVal.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
                    : firstVal
                  : String(firstVal);
              let line = `${pad}  - {${firstKey}: ${firstStr}`;
              for (const k of rest) {
                const v = sub[k];
                const vStr =
                  typeof v === "string"
                    ? v.includes(":") || v.includes('"')
                      ? `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
                      : v
                    : String(v);
                line += `, ${k}: ${vStr}`;
              }
              line += `}`;
              lines.push(line);
            }
          } else {
            lines.push(`${pad}  - ${item}`);
          }
        }
      }
    } else if (typeof value === "object") {
      lines.push(`${pad}${key}:`);
      lines.push(toYaml(value as Record<string, unknown>, indent + 1));
    }
  }

  return lines.join("\n");
}

/** Strip wrapping single or double quotes from a YAML scalar value. */
function unquoteYamlString(val: string): string {
  if (
    (val.startsWith('"') && val.endsWith('"')) ||
    (val.startsWith("'") && val.endsWith("'"))
  ) {
    const inner = val.slice(1, -1);
    // Unescape doubled single-quotes or backslash-escaped chars
    return inner.replace(/''/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return val;
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function writeOutput(
  ctx: MigrationContext,
  relPath: string,
  content: string,
  sourceHint: string
): void {
  const fullPath = path.join(ctx.ideateDir, relPath);
  if (ctx.dryRun) {
    console.log(`[DRY RUN] Would create .ideate/${relPath} (from ${sourceHint})`);
    ctx.created.push(relPath);
    return;
  }
  const dir = path.dirname(fullPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
  ctx.created.push(relPath);
}

function warn(ctx: MigrationContext, msg: string): void {
  ctx.errors.push(`WARNING: ${msg}`);
  console.warn(`WARNING: ${msg}`);
}

// ---------------------------------------------------------------------------
// YAML file builder: wraps content with computed hash + token_count
// ---------------------------------------------------------------------------

/**
 * Compute content_hash and token_count for an artifact object and return the
 * enriched object.  The fields content_hash and token_count in the input are
 * ignored when computing the hash so the result is always deterministic.
 */
export function buildArtifact(obj: Record<string, unknown>): Record<string, unknown> {
  // Temporarily remove hash fields to compute hash from content-only fields
  const forHash: Record<string, unknown> = { ...obj };
  delete forHash["content_hash"];
  delete forHash["token_count"];

  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(forHash).sort(([a], [b]) => a.localeCompare(b)))
  );
  const hash = sha256(canonical);
  const tokens = tokenCount(canonical);

  return {
    ...obj,
    content_hash: hash,
    token_count: tokens,
  };
}

/** Serialize an artifact object to a YAML string (with trailing newline). */
function serializeArtifact(obj: Record<string, unknown>): string {
  return toYaml(buildArtifact(obj)) + "\n";
}

// ---------------------------------------------------------------------------
// 1. Guiding Principles
// ---------------------------------------------------------------------------

/**
 * Parse guiding-principles.md content into an array of principle objects.
 * Each section `## N. Name` becomes one object with id/type/name/status/description.
 */
export function parsePrinciples(content: string): Array<Record<string, unknown>> {
  const headingMatches = Array.from(content.matchAll(/^## (\d+)\. (.+)$/gm));
  const results: Array<Record<string, unknown>> = [];

  for (let i = 0; i < headingMatches.length; i++) {
    const match = headingMatches[i];
    const num = parseInt(match[1], 10);
    const name = match[2].trim();
    const id = `GP-${String(num).padStart(2, "0")}`;

    // Extract body text between this heading and next
    const start = match.index! + match[0].length;
    const nextMatch = headingMatches[i + 1];
    const end = nextMatch ? nextMatch.index! : content.length;
    const body = content.slice(start, end).trim();

    // Check for status markers
    let status = "active";
    if (/`?_Deprecated_`?/i.test(body)) status = "deprecated";
    else if (/`?_Amended_`?/i.test(body) || /`?_Changed_`?/i.test(body))
      status = "amended";

    // Extract amendment history from blockquote lines
    const amendmentHistory: Array<{ cycle: number; change_summary: string }> =
      [];
    for (const bq of body.matchAll(
      /> _(?:Amended|Changed|Updated)[^_]*?: (.+?)_/gi
    )) {
      amendmentHistory.push({
        cycle: 0, // cycle unknown from text
        change_summary: bq[1].trim(),
      });
    }
    // Also catch the format "> _Amended in refinement (date): text._"
    for (const bq of body.matchAll(
      /> _(?:Amended|Changed|Updated) in (?:refinement )?\(([^)]+)\): (.+?)\.?_/gi
    )) {
      // Only add if not already captured above
      if (!amendmentHistory.some((a) => a.change_summary === bq[2].trim())) {
        amendmentHistory.push({
          cycle: 0,
          change_summary: bq[2].trim(),
        });
      }
    }

    // Description: body without blockquote lines
    const descLines = body
      .split("\n")
      .filter((ln) => !ln.trimStart().startsWith(">"))
      .join("\n")
      .trim();

    results.push({
      id,
      type: "guiding_principle",
      name,
      status,
      description: descLines,
      amendment_history: amendmentHistory,
      cycle_created: 1,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: `.ideate/principles/${id}.yaml`,
    });
  }

  return results;
}

function migrateGuidingPrinciples(ctx: MigrationContext): void {
  const filePath = path.join(ctx.sourceDir, "steering", "guiding-principles.md");
  const content = readFile(filePath);
  if (!content) {
    warn(ctx, `guiding-principles.md not found at ${filePath}`);
    return;
  }

  const principles = parsePrinciples(content);

  if (principles.length === 0) {
    warn(ctx, "No principle sections found in guiding-principles.md");
    return;
  }

  for (const obj of principles) {
    const num = parseInt((obj["id"] as string).replace("GP-", ""), 10);
    const yaml = serializeArtifact(obj);
    writeOutput(
      ctx,
      `principles/${obj["id"]}.yaml`,
      yaml,
      `steering/guiding-principles.md §${num}`
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Constraints
// ---------------------------------------------------------------------------

function migrateConstraints(ctx: MigrationContext): void {
  const filePath = path.join(ctx.sourceDir, "steering", "constraints.md");
  const content = readFile(filePath);
  if (!content) {
    warn(ctx, `constraints.md not found at ${filePath}`);
    return;
  }

  // Parse category headers and numbered items
  const lines = content.split("\n");
  let currentCategory = "technology";

  for (const line of lines) {
    // Category header: ## Technology Constraints, ## Design Constraints, etc.
    const categoryMatch = line.match(/^## (Technology|Design|Process|Scope)/i);
    if (categoryMatch) {
      currentCategory = categoryMatch[1].toLowerCase();
      continue;
    }

    // Numbered item: "1. **Title.** Description"
    const itemMatch = line.match(/^(\d+)\.\s+\*\*([^*]+)\*\*\s*(.*)/);
    if (itemMatch) {
      const num = parseInt(itemMatch[1], 10);
      const title = itemMatch[2].replace(/\.$/, "").trim();
      const rest = itemMatch[3].trim();
      const description = rest ? `${title}. ${rest}` : title;
      const id = `C-${String(num).padStart(2, "0")}`;

      const obj: Record<string, unknown> = {
        id,
        type: "constraint",
        category: currentCategory,
        status: "active",
        description,
        cycle_created: 1,
        cycle_modified: null,
        content_hash: "",
        token_count: 0,
        file_path: `.ideate/constraints/${id}.yaml`,
      };

      const yaml = serializeArtifact(obj);
      writeOutput(
        ctx,
        `constraints/${id}.yaml`,
        yaml,
        `steering/constraints.md §${currentCategory} #${num}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Work Items
// ---------------------------------------------------------------------------

/** Parse a YAML flow-style array like [foo, bar] or ['a', "b"] into string[]. */
export function parseYamlFlowArray(str: string): string[] {
  const inner = str.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inner.trim()) return [];
  return inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

/** Minimal YAML parser for the work-items.yaml structure. */
export function parseWorkItemsYaml(content: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};

  // Split on top-level item keys: lines matching /^  "NNN":$/
  const itemStartRegex = /^  "(\d+)":\s*$/gm;
  const matches = Array.from(content.matchAll(itemStartRegex));

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const itemId = match[1];
    const start = match.index! + match[0].length;
    const end = matches[i + 1] ? matches[i + 1].index! : content.length;
    const block = content.slice(start, end);

    const item: Record<string, unknown> = {};

    // title
    const titleMatch = block.match(/^\s{4}title:\s*(.+)$/m);
    if (titleMatch) item["title"] = unquoteYamlString(titleMatch[1].trim());

    // complexity
    const complexityMatch = block.match(/^\s{4}complexity:\s*(.+)$/m);
    if (complexityMatch) item["complexity"] = complexityMatch[1].trim();

    // status
    const statusMatch = block.match(/^\s{4}status:\s*(.+)$/m);
    if (statusMatch) item["status"] = statusMatch[1].trim();

    // notes path
    const notesMatch = block.match(/^\s{4}notes:\s*(.+)$/m);
    if (notesMatch) item["notes_path"] = notesMatch[1].trim();

    // depends: ["x", "y"] or depends: []
    const dependsMatch = block.match(/^\s{4}depends:\s*(\[.*?\])/m);
    if (dependsMatch) {
      item["depends"] = parseYamlFlowArray(dependsMatch[1]);
    } else {
      item["depends"] = [];
    }

    // blocks: ["x", "y"] or blocks: []
    const blocksMatch = block.match(/^\s{4}blocks:\s*(\[.*?\])/m);
    if (blocksMatch) {
      item["blocks"] = parseYamlFlowArray(blocksMatch[1]);
    } else {
      item["blocks"] = [];
    }

    // scope: list of {path: x, op: y}
    const scopeSection = block.match(/^\s{4}scope:\n((?:\s{6}-.*\n?)*)/m);
    const scopeEntries: Array<{ path: string; op: string }> = [];
    if (scopeSection) {
      const scopeLines = scopeSection[1].matchAll(
        /\{path:\s*([^,]+),\s*op:\s*([^}]+)\}/g
      );
      for (const sl of scopeLines) {
        scopeEntries.push({
          path: sl[1].trim(),
          op: sl[2].trim(),
        });
      }
    }
    item["scope"] = scopeEntries;

    // criteria: list of strings (may be multi-line with continuation)
    const criteriaSection = block.match(/^\s{4}criteria:\n((?:[ \t]+.*\n?)*)/m);
    const criteria: string[] = [];
    if (criteriaSection) {
      const criteriaLines = criteriaSection[1].split("\n");
      for (const cl of criteriaLines) {
        const cm = cl.match(/^\s{6}-\s+'(.*)'\s*$/) || cl.match(/^\s{6}-\s+"(.*)"\s*$/) || cl.match(/^\s{6}-\s+(.*)\s*$/);
        if (cm && cm[1].trim()) {
          criteria.push(cm[1].trim().replace(/''/g, "'"));
        } else if (criteria.length > 0 && cl.match(/^\s{7,}\S/)) {
          // Continuation line: indented deeper than 6 spaces and doesn't start a new item
          criteria[criteria.length - 1] += " " + cl.trim();
        }
      }
    }
    item["criteria"] = criteria;

    result[itemId] = item;
  }

  return result;
}

function migrateWorkItems(ctx: MigrationContext): void {
  const yamlPath = path.join(ctx.sourceDir, "plan", "work-items.yaml");
  const content = readFile(yamlPath);
  if (!content) {
    warn(ctx, `work-items.yaml not found at ${yamlPath}`);
    return;
  }

  const items = parseWorkItemsYaml(content);

  for (const [rawId, item] of Object.entries(items)) {
    const num = parseInt(rawId, 10);
    const id = `WI-${String(num).padStart(3, "0")}`;

    // Merge notes from plan/notes/{rawId}.md
    let notes: string | null = null;
    const notesPath = path.join(ctx.sourceDir, "plan", "notes", `${rawId}.md`);
    const notesContent = readFile(notesPath);
    if (notesContent) {
      notes = notesContent.trim();
    } else if (item["notes_path"]) {
      // Try the path recorded in YAML
      const altPath = path.join(ctx.sourceDir, String(item["notes_path"]));
      const altContent = readFile(altPath);
      if (altContent) notes = altContent.trim();
    }

    const statusVal = (item["status"] as string) || "pending";

    const obj: Record<string, unknown> = {
      id,
      type: "work_item",
      title: item["title"] || "",
      status: statusVal,
      complexity: item["complexity"] || "medium",
      scope: item["scope"] || [],
      depends: item["depends"] || [],
      blocks: item["blocks"] || [],
      criteria: item["criteria"] || [],
      module: null,
      domain: null,
      notes: notes,
      cycle_created: 1,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: `.ideate/work-items/${id}.yaml`,
    };

    const yaml = serializeArtifact(obj);
    writeOutput(
      ctx,
      `work-items/${id}.yaml`,
      yaml,
      `plan/work-items.yaml "${rawId}"`
    );
  }
}

// ---------------------------------------------------------------------------
// 4-6. Domain artifacts (policies, decisions, questions)
// ---------------------------------------------------------------------------

/** Parse sections of the form "## X-NN: Title" from domain markdown files. */
function parseDomainSections(
  content: string,
  prefix: string
): Array<{ id: string; title: string; body: string }> {
  const results: Array<{ id: string; title: string; body: string }> = [];
  const headingRegex = new RegExp(
    `^## (${prefix}-\\d+):?\\s*(.*)$`,
    "gm"
  );
  const headingMatches = Array.from(content.matchAll(headingRegex));

  for (let i = 0; i < headingMatches.length; i++) {
    const match = headingMatches[i];
    const id = match[1].trim();
    const title = match[2].trim();
    const start = match.index! + match[0].length;
    const end = headingMatches[i + 1] ? headingMatches[i + 1].index! : content.length;
    const body = content.slice(start, end).trim();
    results.push({ id, title, body });
  }

  return results;
}

function extractField(body: string, label: string): string | null {
  const regex = new RegExp(
    `\\*\\*${label}\\*\\*:\\s*(.+?)(?=\\n|$)`,
    "i"
  );
  const match = body.match(regex);
  return match ? match[1].trim() : null;
}

function extractListField(body: string, label: string): string[] {
  const val = extractField(body, label);
  if (!val) return [];
  return val
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function migratePolicies(ctx: MigrationContext, domain: string, filePath: string): void {
  const content = readFile(filePath);
  if (!content) {
    warn(ctx, `policies.md not found at ${filePath}`);
    return;
  }

  const sections = parseDomainSections(content, "P");
  for (const { id, title, body } of sections) {
    // Normalize id: ensure P-NN format with zero-padded number
    const numMatch = id.match(/P-(\d+)/);
    if (!numMatch) {
      warn(ctx, `Cannot parse policy id from "${id}" in ${domain}/policies.md`);
      continue;
    }
    const num = parseInt(numMatch[1], 10);
    const normalId = `P-${String(num).padStart(2, "0")}`;

    const status = extractField(body, "Status") || "active";
    const derivedFrom = extractListField(body, "Derived from");
    const established = extractField(body, "Established") || "planning phase";
    const amended = extractField(body, "Amended");

    // Description: the policy text, excluding **Field**: lines
    const descLines = body
      .split("\n")
      .filter((ln) => !ln.match(/^- \*\*\w/))
      .join("\n")
      .trim();

    const description = descLines || title;

    const obj: Record<string, unknown> = {
      id: normalId,
      type: "domain_policy",
      domain,
      status,
      derived_from: derivedFrom,
      established,
      amended: amended || null,
      description,
      cycle_created: 1,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: `.ideate/policies/${normalId}.yaml`,
    };

    const yaml = serializeArtifact(obj);
    writeOutput(
      ctx,
      `policies/${normalId}.yaml`,
      yaml,
      `domains/${domain}/policies.md §${id}`
    );
  }
}

function migrateDecisions(ctx: MigrationContext, domain: string, filePath: string): void {
  const content = readFile(filePath);
  if (!content) {
    warn(ctx, `decisions.md not found at ${filePath}`);
    return;
  }

  const sections = parseDomainSections(content, "D");
  for (const { id, title, body } of sections) {
    const numMatch = id.match(/D-(\d+)/);
    if (!numMatch) {
      warn(ctx, `Cannot parse decision id from "${id}" in ${domain}/decisions.md`);
      continue;
    }
    const num = parseInt(numMatch[1], 10);
    const normalId = `D-${String(num).padStart(2, "0")}`;

    const status = extractField(body, "Status") || "settled";

    // Decision text
    const decisionLine = extractField(body, "Decision");
    const description = decisionLine || title;

    // Rationale
    const rationale = extractField(body, "Rationale") || "";

    // Supersedes
    const supersedes = extractField(body, "Supersedes");

    // Cycle: try to extract from Source or Established references
    let cycle = 1;
    const cycleMatch = body.match(/cycle[s]? (\d+)/i);
    if (cycleMatch) cycle = parseInt(cycleMatch[1], 10);

    const obj: Record<string, unknown> = {
      id: normalId,
      type: "domain_decision",
      domain,
      status,
      cycle,
      supersedes: supersedes || null,
      description,
      rationale,
      cycle_created: 1,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: `.ideate/decisions/${normalId}.yaml`,
    };

    const yaml = serializeArtifact(obj);
    writeOutput(
      ctx,
      `decisions/${normalId}.yaml`,
      yaml,
      `domains/${domain}/decisions.md §${id}`
    );
  }
}

function migrateQuestions(ctx: MigrationContext, domain: string, filePath: string): void {
  const content = readFile(filePath);
  if (!content) {
    warn(ctx, `questions.md not found at ${filePath}`);
    return;
  }

  const sections = parseDomainSections(content, "Q");
  for (const { id, title, body } of sections) {
    const numMatch = id.match(/Q-(\d+)/);
    if (!numMatch) {
      warn(ctx, `Cannot parse question id from "${id}" in ${domain}/questions.md`);
      continue;
    }
    const num = parseInt(numMatch[1], 10);
    const normalId = `Q-${String(num).padStart(2, "0")}`;

    const status = extractField(body, "Status") || "open";
    const impact = extractField(body, "Impact") || "";
    const source = extractField(body, "Source") || "";
    const resolution = extractField(body, "Resolution");
    const resolvedInStr = extractField(body, "Resolved in");
    let resolvedIn: number | null = null;
    if (resolvedInStr) {
      const m = resolvedInStr.match(/cycle\s*(\d+)/i) || resolvedInStr.match(/(\d+)/);
      if (m) resolvedIn = parseInt(m[1], 10);
    }

    // Description: the question text (first non-field line)
    const questionLine = extractField(body, "Question");
    const description = questionLine || title;

    const obj: Record<string, unknown> = {
      id: normalId,
      type: "domain_question",
      domain,
      status,
      impact,
      source,
      resolution: resolution || null,
      resolved_in: resolvedIn,
      description,
      cycle_created: 1,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: `.ideate/questions/${normalId}.yaml`,
    };

    const yaml = serializeArtifact(obj);
    writeOutput(
      ctx,
      `questions/${normalId}.yaml`,
      yaml,
      `domains/${domain}/questions.md §${id}`
    );
  }
}

function migrateDomains(ctx: MigrationContext): void {
  const domainsDir = path.join(ctx.sourceDir, "domains");
  if (!fs.existsSync(domainsDir)) {
    warn(ctx, `domains/ directory not found at ${domainsDir}`);
    return;
  }

  const entries = fs.readdirSync(domainsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const domain = entry.name;
    const domainPath = path.join(domainsDir, domain);

    migratePolicies(ctx, domain, path.join(domainPath, "policies.md"));
    migrateDecisions(ctx, domain, path.join(domainPath, "decisions.md"));
    migrateQuestions(ctx, domain, path.join(domainPath, "questions.md"));
  }
}

// ---------------------------------------------------------------------------
// 7. Research
// ---------------------------------------------------------------------------

function migrateResearch(ctx: MigrationContext): void {
  const researchDir = path.join(ctx.sourceDir, "steering", "research");
  if (!fs.existsSync(researchDir)) {
    warn(ctx, `steering/research/ directory not found at ${researchDir}`);
    return;
  }

  const files = fs
    .readdirSync(researchDir)
    .filter((f) => f.endsWith(".md"));

  for (const file of files) {
    const slug = path.basename(file, ".md");
    const id = `RF-${slug}`;
    const filePath = path.join(researchDir, file);
    const content = readFile(filePath);
    if (!content) {
      warn(ctx, `Cannot read research file: ${filePath}`);
      continue;
    }

    // Extract H1 title
    const h1Match = content.match(/^# (.+)$/m);
    const topic = h1Match ? h1Match[1].trim() : slug;

    // Extract date from "Research compiled: YYYY-MM-DD" or frontmatter
    const dateMatch =
      content.match(/Research compiled:\s*(\d{4}-\d{2}-\d{2})/i) ||
      content.match(/^date:\s*(\d{4}-\d{2}-\d{2})/m);
    const date = dateMatch ? dateMatch[1] : null;

    const obj: Record<string, unknown> = {
      id,
      type: "research_finding",
      topic,
      status: "active",
      date: date || null,
      content: content.trim(),
      sources: [],
      cycle_created: 1,
      cycle_modified: null,
      content_hash: "",
      token_count: 0,
      file_path: `.ideate/research/${id}.yaml`,
    };

    const yaml = serializeArtifact(obj);
    writeOutput(
      ctx,
      `research/${id}.yaml`,
      yaml,
      `steering/research/${file}`
    );
  }
}

// ---------------------------------------------------------------------------
// 8. Journal
// ---------------------------------------------------------------------------

export function migrateJournal(ctx: MigrationContext): void {
  const filePath = path.join(ctx.sourceDir, "journal.md");
  const content = readFile(filePath);
  if (!content) {
    warn(ctx, `journal.md not found at ${filePath}`);
    return;
  }

  // ## [{phase}] {date} — {title}
  const headingMatches = Array.from(
    content.matchAll(/^## \[([^\]]+)\] (\d{4}-\d{2}-\d{2}) — (.+)$/gm)
  );

  if (headingMatches.length === 0) {
    warn(ctx, "No journal entries found in journal.md");
    return;
  }

  // Track per-cycle sequence counters and current cycle for execute entries
  let currentCycle = 0;
  // Map of cycle -> seq counter (1-based)
  const cycleSeqCounters: Record<number, number> = {};
  // Global sequence counter to assign cycles to each entry
  let globalRefineSeq = 0;

  for (let i = 0; i < headingMatches.length; i++) {
    const match = headingMatches[i];
    const phase = match[1].trim().toLowerCase();
    const date = match[2].trim();
    const title = match[3].trim();

    const start = match.index! + match[0].length;
    const end = headingMatches[i + 1] ? headingMatches[i + 1].index! : content.length;
    const body = content.slice(start, end).trim();

    // Determine cycle for this entry
    let entryCycle: number;
    if (phase === "refine") {
      globalRefineSeq++;
      currentCycle = globalRefineSeq;
      entryCycle = currentCycle;
    } else if (phase === "review") {
      // review entries belong to the current refine cycle (or 0 if none yet)
      entryCycle = currentCycle;
    } else {
      // execute and other phases belong to the current cycle
      entryCycle = currentCycle;
    }

    // Assign 1-based sequence within cycle
    if (!cycleSeqCounters[entryCycle]) {
      cycleSeqCounters[entryCycle] = 0;
    }
    cycleSeqCounters[entryCycle]++;
    const seq = cycleSeqCounters[entryCycle];

    const nnn = String(entryCycle).padStart(3, "0");
    const seqStr = String(seq).padStart(3, "0");
    const id = `J-${nnn}-${seqStr}`;

    const obj: Record<string, unknown> = {
      id,
      type: "journal_entry",
      phase,
      date,
      cycle_created: entryCycle,
      title,
      content: body,
      content_hash: "",
      token_count: 0,
    };

    const yaml = serializeArtifact(obj);
    writeOutput(
      ctx,
      `cycles/${nnn}/journal/${id}.yaml`,
      yaml,
      `journal.md §${i + 1}`
    );
  }
}

// ---------------------------------------------------------------------------
// 9. Archive cycles (findings)
// ---------------------------------------------------------------------------

/** Extract the verdict from the first "## Verdict: {Pass|Fail}" line. */
function extractVerdict(content: string): string | null {
  const match = content.match(/^##\s+Verdict:\s*(Pass|Fail)/m);
  return match ? match[1] : null;
}

export function migrateArchiveCycles(ctx: MigrationContext): void {
  const archiveCyclesDir = path.join(ctx.sourceDir, "archive", "cycles");
  if (!fs.existsSync(archiveCyclesDir)) {
    warn(ctx, `archive/cycles/ directory not found at ${archiveCyclesDir}`);
    return;
  }

  const cycleEntries = fs
    .readdirSync(archiveCyclesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const fileToReviewer: Record<string, string> = {
    "code-quality.md": "code-reviewer",
    "spec-adherence.md": "spec-reviewer",
    "gap-analysis.md": "gap-analyst",
  };

  // Severity prefix mapping
  const prefixToSeverity: Record<string, string> = {
    C: "critical",
    S: "significant",
    M: "minor",
  };

  // Global finding sequence counter — never resets between cycles so IDs are unique
  let globalFindingSeq = 0;

  for (const cycleEntry of cycleEntries) {
    const nnn = cycleEntry.name; // e.g. "001"
    const cycleNum = parseInt(nnn, 10);
    const cyclePath = path.join(archiveCyclesDir, nnn);

    const reviewFiles = fs
      .readdirSync(cyclePath)
      .filter((f) => Object.keys(fileToReviewer).includes(f))
      .sort();

    for (const reviewFile of reviewFiles) {
      const reviewer = fileToReviewer[reviewFile];
      const filePath = path.join(cyclePath, reviewFile);
      const content = readFile(filePath);
      if (!content) {
        warn(ctx, `Cannot read review file: ${filePath}`);
        continue;
      }

      // Parse finding headings: ### C{N}: title, ### S{N}: title, ### M{N}: title
      const findingMatches = Array.from(
        content.matchAll(/^### ([CSM])(\d+):\s*(.+)$/gm)
      );

      for (let i = 0; i < findingMatches.length; i++) {
        const fMatch = findingMatches[i];
        const severityPrefix = fMatch[1];
        const findingTitle = fMatch[3].trim();
        const severity = prefixToSeverity[severityPrefix] || "minor";

        // Body: lines after heading up to next ### or ##
        const fStart = fMatch.index! + fMatch[0].length;
        const nextFinding = findingMatches[i + 1];
        // Find next ## or ### after fStart
        const nextHeadingMatch = content
          .slice(fStart)
          .match(/^#{2,3} /m);
        let fEnd: number;
        if (nextFinding && nextFinding.index! < fStart + (nextHeadingMatch?.index ?? Infinity)) {
          fEnd = nextFinding.index!;
        } else if (nextHeadingMatch) {
          fEnd = fStart + nextHeadingMatch.index!;
        } else {
          fEnd = content.length;
        }
        const description = content.slice(fStart, fEnd).trim();

        globalFindingSeq++;
        const seqStr = String(globalFindingSeq).padStart(3, "0");
        const findingNnn = String(cycleNum).padStart(3, "0");
        const id = `F-${findingNnn}-${seqStr}`;
        const outRelPath = `cycles/${findingNnn}/findings/${id}.yaml`;

        const verdict = extractVerdict(content);
        const workItem = `cycle-${String(cycleNum).padStart(3, "0")}`;

        const obj: Record<string, unknown> = {
          id,
          type: "finding",
          cycle: cycleNum,
          reviewer,
          severity,
          title: findingTitle,
          description,
          file_path: outRelPath,
          line: null,
          suggestion: null,
          addressed_by: null,
          work_item: workItem,
          verdict,
          content_hash: "",
          token_count: 0,
        };

        const yaml = serializeArtifact(obj);
        writeOutput(
          ctx,
          outRelPath,
          yaml,
          `archive/cycles/${nnn}/${reviewFile} §${severityPrefix}${fMatch[2]}`
        );
      }
    }

    // decision-log.md → type: decision_log
    const decisionLogPath = path.join(cyclePath, "decision-log.md");
    if (fs.existsSync(decisionLogPath)) {
      const content = readFile(decisionLogPath);
      if (content) {
        const obj: Record<string, unknown> = {
          id: `DL-${nnn}`,
          type: "decision_log",
          cycle: cycleNum,
          content: content.trim(),
          content_hash: "",
          token_count: 0,
        };
        writeOutput(
          ctx,
          `cycles/${nnn}/DL-${nnn}.yaml`,
          serializeArtifact(obj),
          `archive/cycles/${nnn}/decision-log.md`
        );
      }
    }

    // summary.md → type: cycle_summary
    const summaryPath = path.join(cyclePath, "summary.md");
    if (fs.existsSync(summaryPath)) {
      const content = readFile(summaryPath);
      if (content) {
        const obj: Record<string, unknown> = {
          id: `CS-${nnn}`,
          type: "cycle_summary",
          cycle: cycleNum,
          content: content.trim(),
          content_hash: "",
          token_count: 0,
        };
        writeOutput(
          ctx,
          `cycles/${nnn}/CS-${nnn}.yaml`,
          serializeArtifact(obj),
          `archive/cycles/${nnn}/summary.md`
        );
      }
    }

    // review-manifest.md → type: review_manifest
    const reviewManifestPath = path.join(cyclePath, "review-manifest.md");
    if (fs.existsSync(reviewManifestPath)) {
      const content = readFile(reviewManifestPath);
      if (content) {
        const obj: Record<string, unknown> = {
          id: `RM-${nnn}`,
          type: "review_manifest",
          cycle: cycleNum,
          content: content.trim(),
          content_hash: "",
          token_count: 0,
        };
        writeOutput(
          ctx,
          `cycles/${nnn}/RM-${nnn}.yaml`,
          serializeArtifact(obj),
          `archive/cycles/${nnn}/review-manifest.md`
        );
      }
    }

    // incremental/*.md → type: finding (same extraction logic, FI- prefix)
    const incrementalDir = path.join(cyclePath, "incremental");
    if (fs.existsSync(incrementalDir)) {
      let incrementalSeq = 0;
      const incrementalFiles = fs
        .readdirSync(incrementalDir)
        .filter((f) => f.endsWith(".md"))
        .sort();

      for (const file of incrementalFiles) {
        const filePath = path.join(incrementalDir, file);
        const content = readFile(filePath);
        if (!content) continue;

        // Extract work_item from filename prefix (e.g., 154-integrate-drizzle.md → WI-154)
        const workItemMatch = file.match(/^(\d+)-/);
        const work_item = workItemMatch ? `WI-${workItemMatch[1]}` : null;

        const verdict = extractVerdict(content);

        // Parse finding headings using same logic as capstone reviews
        const findingMatches = Array.from(
          content.matchAll(/^### ([CSM])(\d+):\s*(.+)$/gm)
        );

        for (let i = 0; i < findingMatches.length; i++) {
          const fMatch = findingMatches[i];
          const severityPrefix = fMatch[1];
          const findingTitle = fMatch[3].trim();
          const severity = prefixToSeverity[severityPrefix] || "minor";

          // Body: lines after heading up to next ### or ##
          const fStart = fMatch.index! + fMatch[0].length;
          const nextFinding = findingMatches[i + 1];
          const nextHeadingMatch = content.slice(fStart).match(/^#{2,3} /m);
          let fEnd: number;
          if (nextFinding && nextFinding.index! < fStart + (nextHeadingMatch?.index ?? Infinity)) {
            fEnd = nextFinding.index!;
          } else if (nextHeadingMatch) {
            fEnd = fStart + nextHeadingMatch.index!;
          } else {
            fEnd = content.length;
          }
          const description = content.slice(fStart, fEnd).trim();

          incrementalSeq++;
          const seqStr = String(incrementalSeq).padStart(3, "0");
          const id = `FI-${nnn}-${seqStr}`;
          const outRelPath = `cycles/${nnn}/findings/${id}.yaml`;

          const obj: Record<string, unknown> = {
            id,
            type: "finding",
            cycle: cycleNum,
            reviewer: "code-reviewer",
            severity,
            title: findingTitle,
            description,
            file_path: outRelPath,
            line: null,
            suggestion: null,
            addressed_by: null,
            work_item,
            verdict,
            content_hash: "",
            token_count: 0,
          };

          const yaml = serializeArtifact(obj);
          writeOutput(
            ctx,
            outRelPath,
            yaml,
            `archive/cycles/${nnn}/incremental/${file} §${severityPrefix}${fMatch[2]}`
          );
        }
      }
    }
  }

}

// ---------------------------------------------------------------------------
// 10. Plan artifacts
// ---------------------------------------------------------------------------

/**
 * Derive a title from a markdown file: use the first H1 heading if present,
 * otherwise fall back to the filename slug.
 */
function deriveTitle(content: string, slug: string): string {
  const h1 = content.match(/^# (.+)$/m);
  return h1 ? h1[1].trim() : slug;
}

/** Extract the body of a named ## section, trimmed. Returns null if absent. */
export function extractSection(content: string, heading: string): string | null {
  const re = new RegExp(`(?:^|\\n)## ${heading}[ \\t]*\\n([\\s\\S]*?)(?=\\n## [^#]|$)`);
  const match = content.match(re);
  return match ? match[1].trim() : null;
}

/** Extract bullet list items from a named ## section. Returns [] if absent. */
function extractListItems(content: string, heading: string): string[] {
  const section = extractSection(content, heading);
  if (!section) return [];
  return section
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length > 0);
}

export function migratePlanArtifacts(
  ctx: MigrationContext,
  sourceDir: string
): void {
  const planDir = path.join(sourceDir, "plan");

  // Fixed plan files: filename → type
  const fixedFiles: Array<{ file: string; type: string; id: string }> = [
    { file: "architecture.md", type: "architecture", id: "architecture" },
    { file: "overview.md", type: "overview", id: "overview" },
    { file: "execution-strategy.md", type: "execution_strategy", id: "execution-strategy" },
  ];

  for (const { file, type, id } of fixedFiles) {
    const filePath = path.join(planDir, file);
    const content = readFile(filePath);
    if (!content) continue; // skip silently if missing

    const title = deriveTitle(content, id);
    const obj: Record<string, unknown> = {
      id,
      type,
      title,
      content: content.trim(),
      content_hash: "",
      token_count: 0,
    };

    const yaml = serializeArtifact(obj);
    writeOutput(ctx, `plan/${id}.yaml`, yaml, `plan/${file}`);
  }

  // Module specs: plan/modules/*.md
  const modulesDir = path.join(planDir, "modules");
  if (fs.existsSync(modulesDir)) {
    const moduleFiles = fs.readdirSync(modulesDir).filter((f) => f.endsWith(".md"));
    for (const file of moduleFiles) {
      const slug = path.basename(file, ".md");
      const id = `module_spec-${slug}`;
      const filePath = path.join(modulesDir, file);
      const content = readFile(filePath);
      if (!content) continue;

      const h1 = content.match(/^# (.+)$/m);
      const rawName = h1 ? h1[1].trim() : slug;
      const name = rawName.replace(/^Module:\s*/i, "").trim() || slug;

      const obj: Record<string, unknown> = {
        id,
        type: "module_spec",
        name,
        scope:          extractSection(content, "Scope") ?? "",
        provides:       extractListItems(content, "Provides"),
        requires:       extractListItems(content, "Requires"),
        boundary_rules: extractListItems(content, "Boundary Rules"),
        content_hash: "",
        token_count: 0,
      };

      writeOutput(ctx, `plan/modules/${slug}.yaml`, serializeArtifact(obj), `plan/modules/${file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 11. Steering artifacts
// ---------------------------------------------------------------------------

export function migrateSteeringArtifacts(
  ctx: MigrationContext,
  sourceDir: string
): void {
  const steeringDir = path.join(sourceDir, "steering");

  // Fixed steering files: filename → type
  const fixedFiles: Array<{ file: string; type: string; id: string }> = [
    { file: "guiding-principles.md", type: "guiding_principles", id: "guiding-principles" },
    { file: "constraints.md", type: "constraints", id: "constraints" },
  ];

  for (const { file, type, id } of fixedFiles) {
    const filePath = path.join(steeringDir, file);
    const content = readFile(filePath);
    if (!content) continue; // skip silently if missing

    const title = deriveTitle(content, id);
    const obj: Record<string, unknown> = {
      id,
      type,
      title,
      content: content.trim(),
      content_hash: "",
      token_count: 0,
    };

    writeOutput(ctx, `steering/${id}.yaml`, serializeArtifact(obj), `steering/${file}`);
  }

  // Research files: steering/research/*.md
  const researchDir = path.join(steeringDir, "research");
  if (fs.existsSync(researchDir)) {
    const researchFiles = fs.readdirSync(researchDir).filter((f) => f.endsWith(".md"));
    for (const file of researchFiles) {
      const slug = path.basename(file, ".md");
      const id = `research-${slug}`;
      const filePath = path.join(researchDir, file);
      const content = readFile(filePath);
      if (!content) continue;

      const title = deriveTitle(content, slug);
      const obj: Record<string, unknown> = {
        id,
        type: "research",
        title,
        content: content.trim(),
        content_hash: "",
        token_count: 0,
      };

      writeOutput(ctx, `steering/research/${slug}.yaml`, serializeArtifact(obj), `steering/research/${file}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 12. Interviews
// ---------------------------------------------------------------------------

/**
 * Recursively collect all .md files under a directory.
 */
function collectMdFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Parse **Q: ...** / A: ... blocks from markdown interview content.
 * Returns an array of entry objects with id, question, answer, domain, seq.
 * The id prefix is used to construct IQ-{prefix}-{seq} identifiers.
 */
export function parseInterviewEntries(
  content: string,
  idPrefix: string
): Array<{ id: string; question: string; answer: string; domain: null; seq: number }> {
  const entries: Array<{ id: string; question: string; answer: string; domain: null; seq: number }> = [];

  // Match blocks of the form:
  //   **Q: <question text>**
  //   A: <answer text (possibly multiline)>
  //
  // The answer runs until the next **Q: or end of string.
  const blockRegex = /\*\*Q:\s*(.*?)\*\*\s*\nA:\s*([\s\S]*?)(?=\n\*\*Q:|\n---\n|$)/g;

  let match: RegExpExecArray | null;
  let seq = 1;
  while ((match = blockRegex.exec(content)) !== null) {
    const question = match[1].trim();
    const answer = match[2].trim();
    if (!question) continue;
    const paddedSeq = String(seq).padStart(3, "0");
    entries.push({
      id: `IQ-${idPrefix}-${paddedSeq}`,
      question,
      answer,
      domain: null,
      seq,
    });
    seq++;
  }

  return entries;
}

export function migrateInterviews(
  ctx: MigrationContext,
  sourceDir: string
): void {
  // 1. Legacy steering/interview.md
  const legacyPath = path.join(sourceDir, "steering", "interview.md");
  const legacyContent = readFile(legacyPath);
  if (legacyContent) {
    const entries = parseInterviewEntries(legacyContent, "legacy");
    const obj: Record<string, unknown> = {
      id: "interviews/legacy",
      type: "interview",
      cycle: null,
      source_path: "steering/interview.md",
      entries: entries.length > 0 ? entries : [],
      content_hash: "",
      token_count: 0,
    };
    writeOutput(ctx, "interviews/legacy.yaml", serializeArtifact(obj), "steering/interview.md");
  }

  // 2. Per-cycle interview files: steering/interviews/**/*.md
  const interviewsDir = path.join(sourceDir, "steering", "interviews");
  if (!fs.existsSync(interviewsDir)) {
    return;
  }

  const mdFiles = collectMdFiles(interviewsDir);
  for (const filePath of mdFiles) {
    const relToInterviewsDir = path.relative(interviewsDir, filePath);
    // relToInterviewsDir is e.g. "refine-018/_full.md"
    const relNoExt = relToInterviewsDir.replace(/\.md$/, "");
    // relNoExt is e.g. "refine-018/_full"

    // Skip _full.md files — compiled transcripts, not structured Q/A
    const basename = path.basename(relNoExt);
    if (basename === "_full") continue;

    const id = `interviews/${relNoExt}`;
    const sourcePath = `steering/interviews/${relToInterviewsDir}`;

    // Derive cycle from directory name if it matches refine-{NNN}
    const parts = relNoExt.split(path.sep);
    let cycle: number | null = null;
    let cycleStr = "000";
    if (parts.length > 1) {
      const dirMatch = parts[0].match(/^refine-(\d+)$/);
      if (dirMatch) {
        cycle = parseInt(dirMatch[1], 10);
        cycleStr = dirMatch[1].padStart(3, "0");
      }
    }

    const content = readFile(filePath);
    if (!content) continue;

    // Build id prefix for question IDs: e.g. "018" from refine-018/_general
    const idPrefix = cycleStr;
    const entries = parseInterviewEntries(content, idPrefix);

    const obj: Record<string, unknown> = {
      id,
      type: "interview",
      cycle,
      source_path: sourcePath,
      entries: entries.length > 0 ? entries : [],
      content_hash: "",
      token_count: 0,
    };

    const outRelPath = `interviews/${relNoExt}.yaml`;
    writeOutput(ctx, outRelPath, serializeArtifact(obj), sourcePath);
  }
}

// ---------------------------------------------------------------------------
// 13. Metrics
// ---------------------------------------------------------------------------

export function migrateMetrics(ctx: MigrationContext): void {
  const src = path.join(ctx.sourceDir, "metrics.jsonl");
  if (!fs.existsSync(src)) {
    return;
  }

  if (ctx.dryRun) {
    ctx.created.push(".ideate/metrics.jsonl (dry-run)");
    return;
  }

  const dest = path.join(ctx.ideateDir, "metrics.jsonl");
  fs.mkdirSync(ctx.ideateDir, { recursive: true });
  fs.copyFileSync(src, dest);
  ctx.created.push("metrics.jsonl");
}

// ---------------------------------------------------------------------------
// 9. Config
// ---------------------------------------------------------------------------

function writeConfig(ctx: MigrationContext): void {
  const config = JSON.stringify({ schema_version: 2 }, null, 2) + "\n";
  if (ctx.dryRun) {
    console.log(`[DRY RUN] Would create .ideate/config.json`);
    ctx.created.push("config.json");
    return;
  }
  fs.mkdirSync(ctx.ideateDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.ideateDir, "config.json"), config, "utf8");
  ctx.created.push("config.json");
}

// ---------------------------------------------------------------------------
// Public migration entry point (used by tests and by main)
// ---------------------------------------------------------------------------

export interface MigrationOptions {
  dryRun: boolean;
  force: boolean;
}

/**
 * Run the full migration from a v1/v2 specs directory to the v3 .ideate/ format.
 * All state is held in a MigrationContext passed explicitly to helper functions.
 */
export function runMigration(
  srcDir: string,
  targetParent: string,
  opts: MigrationOptions
): void {
  const ctx: MigrationContext = {
    errors: [],
    created: [],
    sourceDir: path.resolve(srcDir),
    ideateDir: path.join(path.resolve(targetParent), ".ideate"),
    dryRun: opts.dryRun,
    force: opts.force,
  };

  // Validate source directory
  if (!fs.existsSync(ctx.sourceDir)) {
    throw new Error(`Source specs directory does not exist: ${ctx.sourceDir}`);
  }

  // Check target
  if (fs.existsSync(ctx.ideateDir)) {
    if (!ctx.force) {
      throw new Error(
        `Target .ideate/ directory already exists at ${ctx.ideateDir}\n` +
          `Pass force: true to overwrite.`
      );
    }
    if (!ctx.dryRun) {
      fs.rmSync(ctx.ideateDir, { recursive: true, force: true });
    }
  }

  if (!ctx.dryRun) {
    fs.mkdirSync(ctx.ideateDir, { recursive: true });
  }

  console.log(
    ctx.dryRun
      ? `[DRY RUN] Migrating ${ctx.sourceDir} → ${ctx.ideateDir}`
      : `Migrating ${ctx.sourceDir} → ${ctx.ideateDir}`
  );

  // Run all migration steps
  writeConfig(ctx);
  migrateGuidingPrinciples(ctx);
  migrateConstraints(ctx);
  migrateWorkItems(ctx);
  migrateDomains(ctx);
  migrateResearch(ctx);
  migrateJournal(ctx);
  migrateArchiveCycles(ctx);
  migrateMetrics(ctx);
  // migratePlanArtifacts and migrateSteeringArtifacts produce holistic single-document
  // YAML artifacts (type: architecture, guiding_principles, etc.) for full-context
  // retrieval. migrateGuidingPrinciples and migrateConstraints (above) produce
  // per-item structured records (type: guiding_principle, type: constraint) for
  // structured querying. Both representations are intentional — different consumers
  // use each. The two do not share output paths.
  migratePlanArtifacts(ctx, ctx.sourceDir);
  migrateSteeringArtifacts(ctx, ctx.sourceDir);
  migrateInterviews(ctx, ctx.sourceDir);

  // Summary
  console.log(
    ctx.dryRun
      ? `\nSummary: ${ctx.created.length} files would be created, ${ctx.errors.length} warning(s)`
      : `\nSummary: ${ctx.created.length} files created, ${ctx.errors.length} warning(s)`
  );

  if (ctx.errors.length > 0) {
    console.log("\nWarnings:");
    for (const e of ctx.errors) {
      console.log(`  ${e}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main (CLI entry point — only runs when invoked directly)
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error(
      "Usage: migrate-to-v3.ts <source-specs-dir> <target-dir> [--dry-run] [--force]"
    );
    process.exit(1);
  }

  const cliSourceDir = args[0];
  const cliTargetParent = args[1];
  const cliDryRun = args.includes("--dry-run");
  const cliForce = args.includes("--force");

  try {
    runMigration(cliSourceDir, cliTargetParent, {
      dryRun: cliDryRun,
      force: cliForce,
    });
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Only run when this file is the CLI entry point (not when imported by tests)
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("migrate-to-v3.ts") ||
    process.argv[1].endsWith("migrate-to-v3.js"))
) {
  main();
}
