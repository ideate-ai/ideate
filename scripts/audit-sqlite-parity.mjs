#!/usr/bin/env node
/**
 * SQLite Indexer Parity Audit Script
 *
 * Reads 50+ YAML source files across all artifact types, queries the SQLite
 * index.db directly, and compares field-by-field to find discrepancies.
 *
 * Usage: node scripts/audit-sqlite-parity.mjs
 */

import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// Use artifact-server's node_modules for better-sqlite3 and yaml
const require = createRequire(
  path.resolve("mcp/artifact-server/node_modules/.package-lock.json")
);
const Database = require("better-sqlite3");
const yaml = require("yaml");

const IDEATE_DIR = path.resolve(".ideate");
const DB_PATH = path.join(IDEATE_DIR, "index.db");

// ---------------------------------------------------------------------------
// Sample selection
// ---------------------------------------------------------------------------

function pickN(arr, n) {
  if (arr.length <= n) return arr;
  const step = Math.floor(arr.length / n);
  const result = [];
  for (let i = 0; i < n; i++) {
    result.push(arr[i * step]);
  }
  return result;
}

function collectSample() {
  const files = [];

  // Work items (10)
  const wiDir = path.join(IDEATE_DIR, "work-items");
  if (fs.existsSync(wiDir)) {
    const wis = fs.readdirSync(wiDir).filter(f => f.match(/^WI-.*\.yaml$/)).map(f => path.join(wiDir, f));
    files.push(...pickN(wis, 10).map(f => ({ file: f, expectedType: "work_item" })));
  }

  // Findings (5) - look in cycles/*/findings/
  const cyclesDir = path.join(IDEATE_DIR, "cycles");
  if (fs.existsSync(cyclesDir)) {
    const allFindings = [];
    for (const cycle of fs.readdirSync(cyclesDir)) {
      const findingsDir = path.join(cyclesDir, cycle, "findings");
      if (fs.existsSync(findingsDir)) {
        for (const f of fs.readdirSync(findingsDir)) {
          if (f.match(/^FI-.*\.yaml$/)) {
            allFindings.push(path.join(findingsDir, f));
          }
        }
      }
    }
    files.push(...pickN(allFindings, 5).map(f => ({ file: f, expectedType: "finding" })));
  }

  // Domain policies (5)
  const polDir = path.join(IDEATE_DIR, "policies");
  if (fs.existsSync(polDir)) {
    const pols = fs.readdirSync(polDir).filter(f => f.match(/^P-.*\.yaml$/)).map(f => path.join(polDir, f));
    files.push(...pickN(pols, 5).map(f => ({ file: f, expectedType: "domain_policy" })));
  }

  // Domain decisions (5)
  const decDir = path.join(IDEATE_DIR, "decisions");
  if (fs.existsSync(decDir)) {
    const decs = fs.readdirSync(decDir).filter(f => f.match(/^D-.*\.yaml$/)).map(f => path.join(decDir, f));
    files.push(...pickN(decs, 5).map(f => ({ file: f, expectedType: "domain_decision" })));
  }

  // Guiding principles (3)
  const gpDir = path.join(IDEATE_DIR, "principles");
  if (fs.existsSync(gpDir)) {
    const gps = fs.readdirSync(gpDir).filter(f => f.match(/^GP-.*\.yaml$/)).map(f => path.join(gpDir, f));
    files.push(...pickN(gps, 3).map(f => ({ file: f, expectedType: "guiding_principle" })));
  }

  // Constraints (3)
  const cDir = path.join(IDEATE_DIR, "constraints");
  if (fs.existsSync(cDir)) {
    const cs = fs.readdirSync(cDir).filter(f => f.match(/^C-.*\.yaml$/)).map(f => path.join(cDir, f));
    files.push(...pickN(cs, 3).map(f => ({ file: f, expectedType: "constraint" })));
  }

  // Journal entries (3)
  if (fs.existsSync(cyclesDir)) {
    const allJournals = [];
    for (const cycle of fs.readdirSync(cyclesDir)) {
      const journalDir = path.join(cyclesDir, cycle, "journal");
      if (fs.existsSync(journalDir)) {
        for (const f of fs.readdirSync(journalDir)) {
          if (f.match(/^J-.*\.yaml$/)) {
            allJournals.push(path.join(journalDir, f));
          }
        }
      }
    }
    files.push(...pickN(allJournals, 3).map(f => ({ file: f, expectedType: "journal_entry" })));
  }

  // Research findings (3)
  const rfDir = path.join(IDEATE_DIR, "research");
  if (fs.existsSync(rfDir)) {
    const rfs = fs.readdirSync(rfDir).filter(f => f.match(/^RF-.*\.yaml$/)).map(f => path.join(rfDir, f));
    files.push(...pickN(rfs, 3).map(f => ({ file: f, expectedType: "research_finding" })));
  }

  // Interviews (3)
  const intDir = path.join(IDEATE_DIR, "interviews");
  if (fs.existsSync(intDir)) {
    const allInterviews = [];
    // Find interview YAML files (both flat and nested)
    function walkForInterviews(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkForInterviews(full);
        } else if (entry.name.endsWith(".yaml")) {
          allInterviews.push(full);
        }
      }
    }
    walkForInterviews(intDir);
    files.push(...pickN(allInterviews, 3).map(f => ({ file: f, expectedType: "interview" })));
  }

  // Phases (3)
  const phDir = path.join(IDEATE_DIR, "phases");
  if (fs.existsSync(phDir)) {
    const phs = fs.readdirSync(phDir).filter(f => f.match(/^PH-.*\.yaml$/)).map(f => path.join(phDir, f));
    files.push(...pickN(phs, 3).map(f => ({ file: f, expectedType: "phase" })));
  }

  // Projects (2)
  const prDir = path.join(IDEATE_DIR, "projects");
  if (fs.existsSync(prDir)) {
    const prs = fs.readdirSync(prDir).filter(f => f.match(/^PR-.*\.yaml$/)).map(f => path.join(prDir, f));
    files.push(...pickN(prs, 2).map(f => ({ file: f, expectedType: "project" })));
  }

  // Cycle summaries (2)
  if (fs.existsSync(cyclesDir)) {
    const allCS = [];
    for (const cycle of fs.readdirSync(cyclesDir)) {
      const csFile = path.join(cyclesDir, cycle, `CS-${cycle}.yaml`);
      if (fs.existsSync(csFile)) {
        allCS.push(csFile);
      }
    }
    files.push(...pickN(allCS, 2).map(f => ({ file: f, expectedType: "cycle_summary" })));
  }

  // Metrics events (3)
  const meDir = path.join(IDEATE_DIR, "metrics");
  if (fs.existsSync(meDir)) {
    const mes = fs.readdirSync(meDir).filter(f => f.match(/^ME-.*\.yaml$/)).map(f => path.join(meDir, f));
    files.push(...pickN(mes, 3).map(f => ({ file: f, expectedType: "metrics_event" })));
  }

  // Domain questions (3) - bonus type to get more coverage
  const qDir = path.join(IDEATE_DIR, "questions");
  if (fs.existsSync(qDir)) {
    const qs = fs.readdirSync(qDir).filter(f => f.match(/^Q-.*\.yaml$/)).map(f => path.join(qDir, f));
    files.push(...pickN(qs, 3).map(f => ({ file: f, expectedType: "domain_question" })));
  }

  return files;
}

// ---------------------------------------------------------------------------
// Hash computation (must match indexer.ts computeArtifactHash)
// ---------------------------------------------------------------------------

function computeArtifactHash(yamlObj) {
  const forHash = {};
  for (const [k, v] of Object.entries(yamlObj)) {
    if (k !== "content_hash" && k !== "token_count" && k !== "file_path") {
      forHash[k] = v;
    }
  }
  const serialized = yaml.stringify(forHash, { lineWidth: 0 });
  return crypto.createHash("sha256").update(serialized, "utf8").digest("hex");
}

function tokenCount(content) {
  return Math.floor(content.length / 4);
}

// ---------------------------------------------------------------------------
// TYPE_TO_EXTENSION_TABLE mapping (mirrors db.ts)
// ---------------------------------------------------------------------------

const TYPE_TO_TABLE = {
  work_item: "work_items",
  finding: "findings",
  domain_policy: "domain_policies",
  domain_decision: "domain_decisions",
  domain_question: "domain_questions",
  guiding_principle: "guiding_principles",
  constraint: "constraints",
  module_spec: "module_specs",
  research_finding: "research_findings",
  journal_entry: "journal_entries",
  decision_log: "document_artifacts",
  cycle_summary: "document_artifacts",
  review_output: "document_artifacts",
  review_manifest: "document_artifacts",
  architecture: "document_artifacts",
  overview: "document_artifacts",
  execution_strategy: "document_artifacts",
  guiding_principles: "document_artifacts",
  constraints: "document_artifacts",
  research: "document_artifacts",
  interview: "document_artifacts",
  domain_index: "document_artifacts",
  interview_question: "interview_questions",
  proxy_human_decision: "proxy_human_decisions",
  project: "projects",
  phase: "phases",
};

// ---------------------------------------------------------------------------
// Extension table fields (what the indexer should store per type)
// ---------------------------------------------------------------------------

const EXTENSION_FIELDS = {
  work_items: ["title", "complexity", "scope", "depends", "blocks", "criteria", "module", "domain", "phase", "notes", "work_item_type"],
  findings: ["severity", "work_item", "file_refs", "verdict", "cycle", "reviewer", "description", "suggestion", "addressed_by"],
  domain_policies: ["domain", "derived_from", "established", "amended", "amended_by", "description"],
  domain_decisions: ["domain", "cycle", "supersedes", "description", "rationale"],
  domain_questions: ["domain", "impact", "source", "resolution", "resolved_in", "description", "addressed_by"],
  guiding_principles: ["name", "description", "amendment_history"],
  constraints: ["category", "description"],
  module_specs: ["name", "scope", "provides", "requires", "boundary_rules"],
  research_findings: ["topic", "date", "content", "sources"],
  journal_entries: ["phase", "date", "title", "work_item", "content"],
  document_artifacts: ["title", "cycle", "content"],
  interview_questions: ["interview_id", "question", "answer", "domain", "seq"],
  proxy_human_decisions: ["cycle", "trigger", "triggered_by", "decision", "rationale", "timestamp", "status"],
  projects: ["name", "description", "intent", "scope_boundary", "success_criteria", "appetite", "steering", "horizon", "status"],
  phases: ["name", "description", "project", "phase_type", "intent", "steering", "status", "work_items"],
};

// Fields that are JSON-serialized by the indexer
const JSON_FIELDS = new Set([
  "scope", "depends", "blocks", "criteria", "file_refs", "derived_from",
  "amendment_history", "provides", "requires", "boundary_rules", "sources",
  "scope_boundary", "success_criteria", "horizon", "work_items", "triggered_by",
]);

// ---------------------------------------------------------------------------
// Edge type registry (mirrors schema.ts)
// ---------------------------------------------------------------------------

const EDGE_TYPE_REGISTRY = {
  depends_on: { source_types: ["work_item"], yaml_field: "depends" },
  blocks: { source_types: ["work_item"], yaml_field: "blocks" },
  belongs_to_module: { source_types: ["work_item"], yaml_field: "module" },
  belongs_to_domain: { source_types: ["work_item", "domain_policy", "domain_decision", "domain_question"], yaml_field: "domain" },
  derived_from: { source_types: ["domain_policy"], yaml_field: "derived_from" },
  relates_to: { source_types: ["finding"], yaml_field: "work_item" },
  addressed_by: { source_types: ["finding", "domain_question"], yaml_field: "addressed_by" },
  references: { source_types: [], yaml_field: null },
  amended_by: { source_types: ["domain_policy"], yaml_field: "amended_by" },
  supersedes: { source_types: ["domain_decision"], yaml_field: "supersedes" },
  triggered_by: { source_types: ["proxy_human_decision"], yaml_field: "triggered_by" },
  governed_by: { source_types: ["work_item", "module_spec", "constraint"], yaml_field: "governed_by" },
  informed_by: { source_types: ["work_item", "module_spec", "guiding_principle"], yaml_field: "informed_by" },
  belongs_to_project: { source_types: ["phase"], yaml_field: "project" },
  belongs_to_phase: { source_types: ["work_item"], yaml_field: "phase" },
};

// ---------------------------------------------------------------------------
// Main audit
// ---------------------------------------------------------------------------

function main() {
  const db = new Database(DB_PATH, { readonly: true });

  const sample = collectSample();
  console.log(`\nAudit sample: ${sample.length} files\n`);

  const defects = [];
  const summaryRows = [];
  let parseFails = 0;
  let notInDb = 0;

  for (const { file: filePath, expectedType } of sample) {
    const relPath = path.relative(IDEATE_DIR, filePath);
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      defects.push({ artifact: relPath, field: "file_read", severity: "critical", description: "Could not read YAML file" });
      continue;
    }

    let doc;
    try {
      doc = yaml.parse(content);
    } catch (e) {
      parseFails++;
      summaryRows.push({ id: relPath, type: expectedType, status: "PARSE_FAIL", defects: 1 });
      defects.push({ artifact: relPath, field: "yaml_parse", severity: "minor", description: `YAML parse error: ${e.message?.substring(0, 80)}` });
      continue;
    }

    if (!doc || typeof doc !== "object" || !doc.id) {
      parseFails++;
      summaryRows.push({ id: relPath, type: expectedType, status: "NO_ID", defects: 1 });
      defects.push({ artifact: relPath, field: "id", severity: "minor", description: "YAML doc has no 'id' field" });
      continue;
    }

    const artifactId = doc.id;
    const artifactType = doc.type || expectedType;

    // Query nodes table
    const nodeRow = db.prepare("SELECT * FROM nodes WHERE id = ?").get(artifactId);
    if (!nodeRow) {
      notInDb++;
      summaryRows.push({ id: artifactId, type: artifactType, status: "MISSING_IN_DB", defects: 1 });
      defects.push({ artifact: artifactId, field: "nodes_row", severity: "significant", description: "Artifact exists in YAML but not in SQLite nodes table" });
      continue;
    }

    let artifactDefects = 0;

    // --- Check nodes base table fields ---

    // 1. type
    if (nodeRow.type !== artifactType) {
      defects.push({ artifact: artifactId, field: "type", severity: "significant", description: `YAML type="${artifactType}" vs DB type="${nodeRow.type}"` });
      artifactDefects++;
    }

    // 2. status
    const yamlStatus = doc.status ?? null;
    const dbStatus = nodeRow.status ?? null;
    if (String(yamlStatus) !== String(dbStatus) && !(yamlStatus === null && dbStatus === null)) {
      defects.push({ artifact: artifactId, field: "status", severity: "minor", description: `YAML status="${yamlStatus}" vs DB status="${dbStatus}"` });
      artifactDefects++;
    }

    // 3. cycle_created
    const yamlCycleCreated = doc.cycle_created ?? null;
    const dbCycleCreated = nodeRow.cycle_created ?? null;
    if (yamlCycleCreated !== dbCycleCreated) {
      defects.push({ artifact: artifactId, field: "cycle_created", severity: "minor", description: `YAML cycle_created=${yamlCycleCreated} vs DB=${dbCycleCreated}` });
      artifactDefects++;
    }

    // 4. cycle_modified
    const yamlCycleModified = doc.cycle_modified ?? null;
    const dbCycleModified = nodeRow.cycle_modified ?? null;
    if (yamlCycleModified !== dbCycleModified) {
      defects.push({ artifact: artifactId, field: "cycle_modified", severity: "minor", description: `YAML cycle_modified=${yamlCycleModified} vs DB=${dbCycleModified}` });
      artifactDefects++;
    }

    // 5. token_count
    const expectedTokenCount = tokenCount(content);
    if (nodeRow.token_count !== expectedTokenCount) {
      defects.push({ artifact: artifactId, field: "token_count", severity: "minor", description: `Expected token_count=${expectedTokenCount} (chars/4), DB has ${nodeRow.token_count}` });
      artifactDefects++;
    }

    // 6. content_hash
    const expectedHash = computeArtifactHash(doc);
    if (nodeRow.content_hash !== expectedHash) {
      defects.push({ artifact: artifactId, field: "content_hash", severity: "significant", description: `Computed hash differs from DB hash. Computed=${expectedHash.substring(0, 12)}... DB=${nodeRow.content_hash?.substring(0, 12)}...` });
      artifactDefects++;
    }

    // 7. file_path
    if (nodeRow.file_path !== filePath) {
      defects.push({ artifact: artifactId, field: "file_path", severity: "minor", description: `YAML at "${filePath}" but DB file_path="${nodeRow.file_path}"` });
      artifactDefects++;
    }

    // --- Check extension table ---
    const extTable = TYPE_TO_TABLE[artifactType];
    if (extTable) {
      const extRow = db.prepare(`SELECT * FROM ${extTable} WHERE id = ?`).get(artifactId);
      if (!extRow) {
        defects.push({ artifact: artifactId, field: `${extTable}_row`, severity: "significant", description: `No extension row in ${extTable} table` });
        artifactDefects++;
      } else {
        // Check each expected extension field
        const fields = EXTENSION_FIELDS[extTable] || [];
        for (const field of fields) {
          const yamlVal = doc[field];
          const dbVal = extRow[field];

          if (JSON_FIELDS.has(field)) {
            // JSON-serialized field: compare parsed values
            let parsedDbVal = null;
            try {
              parsedDbVal = dbVal ? JSON.parse(dbVal) : null;
            } catch {
              parsedDbVal = dbVal; // not valid JSON, use raw
            }

            const normalizedYaml = yamlVal === undefined ? null : yamlVal;
            const normalizedDb = parsedDbVal === undefined ? null : parsedDbVal;

            // Deep comparison
            if (JSON.stringify(normalizedYaml) !== JSON.stringify(normalizedDb)) {
              // Only report if meaningfully different (both null/undefined is OK)
              if (!(normalizedYaml == null && normalizedDb == null)) {
                const yamlPreview = JSON.stringify(normalizedYaml)?.substring(0, 60) || "null";
                const dbPreview = JSON.stringify(normalizedDb)?.substring(0, 60) || "null";
                defects.push({
                  artifact: artifactId,
                  field: `${extTable}.${field}`,
                  severity: "minor",
                  description: `JSON field mismatch. YAML: ${yamlPreview} vs DB: ${dbPreview}`
                });
                artifactDefects++;
              }
            }
          } else {
            // Scalar field: direct comparison
            const normalizedYaml = yamlVal === undefined ? null : yamlVal;
            const normalizedDb = dbVal === undefined ? null : dbVal;

            // Handle numeric vs string coercion
            if (normalizedYaml !== normalizedDb) {
              if (!(normalizedYaml == null && normalizedDb == null)) {
                // Check if it's just type coercion (number vs string)
                if (String(normalizedYaml) !== String(normalizedDb)) {
                  defects.push({
                    artifact: artifactId,
                    field: `${extTable}.${field}`,
                    severity: "minor",
                    description: `Scalar mismatch. YAML: ${JSON.stringify(normalizedYaml)?.substring(0, 60)} vs DB: ${JSON.stringify(normalizedDb)?.substring(0, 60)}`
                  });
                  artifactDefects++;
                }
              }
            }
          }
        }

        // Check for YAML fields NOT in the extension table (missing columns)
        const yamlKeys = Object.keys(doc).filter(k => !["id", "type", "cycle_created", "cycle_modified", "content_hash", "token_count", "file_path", "status"].includes(k));
        for (const key of yamlKeys) {
          if (!fields.includes(key) && doc[key] !== undefined && doc[key] !== null) {
            // Check if this is an expected omission (e.g., 'entries' for interviews)
            if (key === "entries" && artifactType === "interview") continue;
            if (key === "title" && extTable === "document_artifacts") continue; // title IS in doc_artifacts
            // The field exists in YAML but has no column in the extension table
            defects.push({
              artifact: artifactId,
              field: `${extTable}.${key}`,
              severity: "minor",
              description: `YAML field "${key}" has no corresponding column in ${extTable} (value: ${JSON.stringify(doc[key])?.substring(0, 40)})`
            });
            artifactDefects++;
          }
        }
      }
    }

    // --- Check edges ---
    const dbEdges = db.prepare("SELECT * FROM edges WHERE source_id = ?").all(artifactId);

    for (const [edgeType, spec] of Object.entries(EDGE_TYPE_REGISTRY)) {
      if (spec.yaml_field === null) continue;
      if (!spec.source_types.includes(artifactType)) continue;

      const fieldValue = doc[spec.yaml_field];
      if (fieldValue === undefined || fieldValue === null) continue;

      const expectedTargets = [];
      if (Array.isArray(fieldValue)) {
        for (const item of fieldValue) {
          if (typeof item === "string" && item.trim()) {
            expectedTargets.push(item.trim());
          }
        }
      } else if (typeof fieldValue === "string" && fieldValue.trim()) {
        expectedTargets.push(fieldValue.trim());
      }

      for (const target of expectedTargets) {
        const edgeExists = dbEdges.some(e => e.edge_type === edgeType && e.target_id === target);
        if (!edgeExists) {
          defects.push({
            artifact: artifactId,
            field: `edge:${edgeType}`,
            severity: "significant",
            description: `Missing edge: ${artifactId} -[${edgeType}]-> ${target} (YAML field: ${spec.yaml_field}="${target}")`
          });
          artifactDefects++;
        }
      }
    }

    // Check for edges in DB that have no YAML backing
    for (const edge of dbEdges) {
      const spec = EDGE_TYPE_REGISTRY[edge.edge_type];
      if (!spec || spec.yaml_field === null) continue;
      if (!spec.source_types.includes(artifactType)) continue;

      const fieldValue = doc[spec.yaml_field];
      let expectedTargets = [];
      if (Array.isArray(fieldValue)) {
        expectedTargets = fieldValue.filter(v => typeof v === "string").map(v => v.trim());
      } else if (typeof fieldValue === "string" && fieldValue.trim()) {
        expectedTargets = [fieldValue.trim()];
      }

      if (!expectedTargets.includes(edge.target_id)) {
        defects.push({
          artifact: artifactId,
          field: `edge:${edge.edge_type}`,
          severity: "minor",
          description: `Phantom edge in DB: ${artifactId} -[${edge.edge_type}]-> ${edge.target_id} (not backed by YAML field "${spec.yaml_field}")`
        });
        artifactDefects++;
      }
    }

    // Check file_refs for work items
    if (artifactType === "work_item" && Array.isArray(doc.scope)) {
      const dbFileRefs = db.prepare("SELECT * FROM node_file_refs WHERE node_id = ?").all(artifactId);
      for (const entry of doc.scope) {
        if (entry && typeof entry === "object" && typeof entry.path === "string" && entry.path.trim()) {
          const refExists = dbFileRefs.some(r => r.file_path === entry.path.trim());
          if (!refExists) {
            defects.push({
              artifact: artifactId,
              field: "node_file_refs",
              severity: "minor",
              description: `Missing file ref: scope entry "${entry.path}" not in node_file_refs`
            });
            artifactDefects++;
          }
        }
      }
    }

    summaryRows.push({ id: artifactId, type: artifactType, status: artifactDefects > 0 ? "DEFECTS" : "OK", defects: artifactDefects });
  }

  db.close();

  // --- Output results ---
  console.log("=== SUMMARY TABLE ===");
  console.log("| Artifact ID | Type | Status | Defect Count |");
  console.log("|---|---|---|---|");
  for (const row of summaryRows) {
    console.log(`| ${row.id} | ${row.type} | ${row.status} | ${row.defects} |`);
  }

  console.log(`\n=== STATISTICS ===`);
  console.log(`Total sampled: ${sample.length}`);
  console.log(`Parse failures: ${parseFails}`);
  console.log(`Missing from DB: ${notInDb}`);
  console.log(`With defects: ${summaryRows.filter(r => r.status === "DEFECTS").length}`);
  console.log(`Clean (OK): ${summaryRows.filter(r => r.status === "OK").length}`);
  console.log(`Total defects found: ${defects.length}`);

  console.log(`\n=== DEFECT TABLE ===`);
  console.log("| # | Artifact | Field | Severity | Description |");
  console.log("|---|---|---|---|---|");
  defects.forEach((d, i) => {
    console.log(`| ${i + 1} | ${d.artifact} | ${d.field} | ${d.severity} | ${d.description} |`);
  });

  // Severity summary
  const bySeverity = {};
  for (const d of defects) {
    bySeverity[d.severity] = (bySeverity[d.severity] || 0) + 1;
  }
  console.log(`\n=== SEVERITY BREAKDOWN ===`);
  for (const [sev, count] of Object.entries(bySeverity)) {
    console.log(`${sev}: ${count}`);
  }

  // Category analysis
  const byField = {};
  for (const d of defects) {
    const cat = d.field.includes("edge:") ? "edges" : d.field.includes(".") ? "extension_fields" : d.field;
    byField[cat] = (byField[cat] || 0) + 1;
  }
  console.log(`\n=== CATEGORY BREAKDOWN ===`);
  for (const [cat, count] of Object.entries(byField)) {
    console.log(`${cat}: ${count}`);
  }
}

main();
