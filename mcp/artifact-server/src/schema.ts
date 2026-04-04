import Database from "better-sqlite3";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

// SQLite user_version for the artifact index schema. Note: CONFIG_SCHEMA_VERSION in config.ts is a separate version for the .ideate/config.json format (D-79).
export const CURRENT_SCHEMA_VERSION = 5;

// ---------------------------------------------------------------------------
// Edge type enumeration
// ---------------------------------------------------------------------------

export const EDGE_TYPES = [
  "depends_on",
  "blocks",
  "belongs_to_module",
  "belongs_to_domain",
  "derived_from",
  "relates_to",
  "addressed_by",
  "references",
  "amended_by",
  "supersedes",
  "triggered_by",
  "governed_by",
  "informed_by",
  "belongs_to_project",
  "belongs_to_phase",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Edge type registry — structured metadata for each edge type
// ---------------------------------------------------------------------------

export interface EdgeTypeSpec {
  description: string;
  source_types: string[]; // artifact type values matching ArtifactCommon.type
  target_types: string[]; // artifact type values (use "domain" for domain-name targets)
  yaml_field: string | null; // field name on source YAML, or null if set explicitly
}

export const EDGE_TYPE_REGISTRY: Record<EdgeType, EdgeTypeSpec> = {
  depends_on: {
    description: "Work item depends on another before it can start",
    source_types: ["work_item"],
    target_types: ["work_item"],
    yaml_field: "depends",
  },
  blocks: {
    description: "Work item blocks another from starting",
    source_types: ["work_item"],
    target_types: ["work_item"],
    yaml_field: "blocks",
  },
  belongs_to_module: {
    description: "Work item is scoped to a module",
    source_types: ["work_item"],
    target_types: ["module_spec"],
    yaml_field: "module",
  },
  belongs_to_domain: {
    description: "Artifact belongs to a named domain",
    source_types: ["work_item", "domain_policy", "domain_decision", "domain_question"],
    target_types: ["domain"],
    yaml_field: "domain",
  },
  derived_from: {
    description: "Domain policy is derived from a guiding principle",
    source_types: ["domain_policy"],
    target_types: ["guiding_principle"],
    yaml_field: "derived_from",
  },
  relates_to: {
    description: "Artifact relates to a specific work item",
    source_types: ["finding", "metrics_event", "journal_entry"],
    target_types: ["work_item"],
    yaml_field: "work_item",
  },
  addressed_by: {
    description: "Finding or question has been addressed by a work item",
    source_types: ["finding", "domain_question"],
    target_types: ["work_item"],
    yaml_field: "addressed_by",
  },
  references: {
    description: "Generic cross-reference between two artifacts",
    source_types: [],
    target_types: [],
    yaml_field: null,
  },
  amended_by: {
    description: "Domain policy has been superseded by a newer version",
    source_types: ["domain_policy"],
    target_types: ["domain_policy"],
    yaml_field: "amended_by",
  },
  supersedes: {
    description: "Domain decision supersedes an earlier decision",
    source_types: ["domain_decision"],
    target_types: ["domain_decision"],
    yaml_field: "supersedes",
  },
  triggered_by: {
    description: "Proxy-human decision was triggered by a finding or work item",
    source_types: ["proxy_human_decision"],
    target_types: ["finding", "work_item"],
    yaml_field: "triggered_by",
  },
  governed_by: {
    description: "Artifact is governed by a guiding principle, policy, or constraint",
    source_types: ["work_item", "module_spec", "constraint"],
    target_types: ["guiding_principle", "domain_policy", "constraint"],
    yaml_field: "governed_by",
  },
  informed_by: {
    description: "Artifact is informed by a decision, research finding, or domain question",
    source_types: ["work_item", "module_spec", "guiding_principle"],
    target_types: ["research_finding", "domain_decision", "domain_question"],
    yaml_field: "informed_by",
  },
  belongs_to_project: {
    description: "Phase belongs to a project",
    source_types: ["phase"],
    target_types: ["project"],
    yaml_field: "project",
  },
  belongs_to_phase: {
    description: "Work item belongs to a phase",
    source_types: ["work_item"],
    target_types: ["phase"],
    yaml_field: "phase",
  },
};

// ---------------------------------------------------------------------------
// Common fields shared by all artifact types
// ---------------------------------------------------------------------------

export interface ArtifactCommon {
  id: string;
  type: string;
  cycle_created: number;
  cycle_modified: number | null;
  content_hash: string;
  token_count: number | null;
  file_path: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Artifact type interfaces
// ---------------------------------------------------------------------------

export interface ScopeEntry {
  path: string;
  op: string;
}

export interface WorkItem extends ArtifactCommon {
  type: "work_item";
  title: string;
  complexity: "small" | "medium" | "large";
  scope: ScopeEntry[];
  depends: string[];
  blocks: string[];
  criteria: string[];
  module: string | null;
  domain: string | null;
  notes?: string;
  phase?: string | null;
  work_item_type: "feature" | "bug" | "spike" | "maintenance" | "chore";
}

export interface FileRef {
  path: string;
  line?: number;
}

export interface Finding extends ArtifactCommon {
  type: "finding";
  severity: "critical" | "significant" | "minor";
  work_item: string;
  file_refs: FileRef[];
  verdict: "pass" | "fail";
  cycle: number;
  reviewer: string;
  description?: string;
  suggestion?: string;
}

export interface DomainPolicy extends ArtifactCommon {
  type: "domain_policy";
  domain: string;
  derived_from: string[];
  established: string;
  amended: string | null;
  description: string;
}

export interface DomainDecision extends ArtifactCommon {
  type: "domain_decision";
  domain: string;
  cycle: number;
  supersedes: string | null;
  description: string;
  rationale: string;
}

export interface DomainQuestion extends ArtifactCommon {
  type: "domain_question";
  domain: string;
  impact: string;
  source: string;
  resolution: string | null;
  resolved_in: number | null;
  description: string;
  addressed_by: string | null;
}

export interface AmendmentEntry {
  cycle: number;
  change_summary: string;
}

export interface GuidingPrinciple extends ArtifactCommon {
  type: "guiding_principle";
  name: string;
  description: string;
  amendment_history: AmendmentEntry[];
}

export interface Constraint extends ArtifactCommon {
  type: "constraint";
  category: "technology" | "design" | "process" | "scope";
  description: string;
}

export interface ModuleSpec extends ArtifactCommon {
  type: "module_spec";
  name: string;
  scope: string;
  provides: string[];
  requires: string[];
  boundary_rules: string[];
}

export interface ResearchFinding extends ArtifactCommon {
  type: "research_finding";
  topic: string;
  date: string;
  content: string;
  sources: string[];
}

export interface JournalEntry extends ArtifactCommon {
  type: "journal_entry";
  phase: string;
  date: string;
  title: string;
  work_item: string | null;
  content: string;
}

export interface MetricsEvent extends ArtifactCommon {
  type: "metrics_event";
  event_name: string;
  timestamp: string;
  payload: Record<string, unknown>;
  // Token accounting
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  // Output quality signals
  outcome?: string;
  finding_count?: number;
  finding_severities?: string;
  first_pass_accepted?: number;
  rework_count?: number;
  // Cycle-level aggregates
  work_item_total_tokens?: number;
  cycle_total_tokens?: number;
  cycle_total_cost_estimate?: string;
  convergence_cycles?: number;
  // Context composition
  context_artifact_ids?: string;
}

export interface DocumentArtifact extends ArtifactCommon {
  type:
    | "decision_log"
    | "cycle_summary"
    | "review_manifest"
    | "architecture"
    | "overview"
    | "execution_strategy"
    | "guiding_principles"
    | "constraints"
    | "research"
    | "interview"
    | "review_output"
    | "domain_index";
  title: string | null;
  cycle: number | null;
  content: string | null;
}

export interface InterviewQuestion extends ArtifactCommon {
  type: "interview_question";
  interview_id: string;
  question: string;
  answer: string;
  domain: string | null;
  seq: number;
}

export interface ProxyHumanDecision extends ArtifactCommon {
  type: "proxy_human_decision";
  cycle: number;
  trigger: "andon" | "fallback" | "deferral";
  triggered_by: Array<{ type: string; id: string }>;
  decision: "approved" | "deferred" | "escalated";
  rationale: string;
  timestamp: string;
  status: "resolved" | "pending_user_input";
}

export interface Project extends ArtifactCommon {
  type: "project";
  name: string | null;
  description: string | null;
  intent: string;
  scope_boundary: { in: string[]; out: string[] };
  success_criteria: string[];
  appetite: number | null;
  steering: string | null;
  horizon: { current: string | null; next: string[]; later: string[] };
  status: string;
}

export interface Phase extends ArtifactCommon {
  type: "phase";
  name: string | null;
  description: string | null;
  project: string;
  phase_type: string;
  intent: string;
  steering: string | null;
  status: string;
  work_items: string[];
}

// ---------------------------------------------------------------------------
// Union type of all artifacts
// ---------------------------------------------------------------------------

export type Artifact =
  | WorkItem
  | Finding
  | DomainPolicy
  | DomainDecision
  | DomainQuestion
  | GuidingPrinciple
  | Constraint
  | ModuleSpec
  | ResearchFinding
  | JournalEntry
  | MetricsEvent
  | DocumentArtifact
  | InterviewQuestion
  | ProxyHumanDecision
  | Project
  | Phase;

// ---------------------------------------------------------------------------
// Edge interface
// ---------------------------------------------------------------------------

export interface Edge {
  id: number;
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  props: string; // JSON-encoded
}

// ---------------------------------------------------------------------------
// Node file reference
// ---------------------------------------------------------------------------

export interface NodeFileRef {
  node_id: string;
  file_path: string;
}

// ---------------------------------------------------------------------------
// createSchema — creates all SQLite tables in a single transaction
// ---------------------------------------------------------------------------

export function createSchema(db: Database.Database): void {
  const transaction = db.transaction(() => {
    // ----- nodes base table -----
    db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id             TEXT PRIMARY KEY,
        type           TEXT NOT NULL,
        cycle_created  INTEGER,
        cycle_modified INTEGER,
        content_hash   TEXT NOT NULL,
        token_count    INTEGER,
        file_path      TEXT NOT NULL,
        status         TEXT
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path)`);

    // ----- Extension tables (each references nodes(id) with ON DELETE CASCADE) -----

    // -- work_items --
    db.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id             TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        title          TEXT NOT NULL,
        complexity     TEXT,
        scope          TEXT,
        depends        TEXT,
        blocks         TEXT,
        criteria       TEXT,
        module         TEXT,
        domain         TEXT,
        phase          TEXT,
        notes          TEXT,
        work_item_type TEXT DEFAULT 'feature',
        resolution     TEXT
      )
    `);

    // -- findings --
    db.exec(`
      CREATE TABLE IF NOT EXISTS findings (
        id           TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        severity     TEXT NOT NULL,
        work_item    TEXT NOT NULL,
        file_refs    TEXT,
        verdict      TEXT NOT NULL,
        cycle        INTEGER NOT NULL,
        reviewer     TEXT NOT NULL,
        description  TEXT,
        suggestion   TEXT,
        addressed_by TEXT,
        title        TEXT
      )
    `);

    // -- domain_policies --
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_policies (
        id           TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        domain       TEXT NOT NULL,
        derived_from TEXT,
        established  TEXT,
        amended      TEXT,
        amended_by   TEXT,
        description  TEXT
      )
    `);

    // -- domain_decisions --
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_decisions (
        id          TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        domain      TEXT NOT NULL,
        cycle       INTEGER,
        supersedes  TEXT,
        description TEXT,
        rationale   TEXT,
        title       TEXT,
        source      TEXT
      )
    `);

    // -- domain_questions --
    db.exec(`
      CREATE TABLE IF NOT EXISTS domain_questions (
        id           TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        domain       TEXT NOT NULL,
        impact       TEXT,
        source       TEXT,
        resolution   TEXT,
        resolved_in  INTEGER,
        description  TEXT,
        addressed_by TEXT
      )
    `);

    // -- guiding_principles --
    db.exec(`
      CREATE TABLE IF NOT EXISTS guiding_principles (
        id                TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        name              TEXT NOT NULL,
        description       TEXT,
        amendment_history TEXT
      )
    `);

    // -- constraints --
    db.exec(`
      CREATE TABLE IF NOT EXISTS constraints (
        id          TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        category    TEXT NOT NULL,
        description TEXT
      )
    `);

    // -- module_specs --
    db.exec(`
      CREATE TABLE IF NOT EXISTS module_specs (
        id             TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        scope          TEXT,
        provides       TEXT,
        requires       TEXT,
        boundary_rules TEXT
      )
    `);

    // -- research_findings --
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_findings (
        id      TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        topic   TEXT NOT NULL,
        date    TEXT,
        content TEXT,
        sources TEXT
      )
    `);

    // -- journal_entries --
    db.exec(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id        TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        phase     TEXT,
        date      TEXT,
        title     TEXT,
        work_item TEXT,
        content   TEXT
      )
    `);

    // -- metrics_events --
    db.exec(`
      CREATE TABLE IF NOT EXISTS metrics_events (
        id                         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        event_name                 TEXT NOT NULL,
        timestamp                  TEXT,
        payload                    TEXT,
        input_tokens               INTEGER,
        output_tokens              INTEGER,
        cache_read_tokens          INTEGER,
        cache_write_tokens         INTEGER,
        outcome                    TEXT,
        finding_count              INTEGER,
        finding_severities         TEXT,
        first_pass_accepted        INTEGER,
        rework_count               INTEGER,
        work_item_total_tokens     INTEGER,
        cycle_total_tokens         INTEGER,
        cycle_total_cost_estimate  TEXT,
        convergence_cycles         INTEGER,
        context_artifact_ids       TEXT
      )
    `);

    // -- document_artifacts --
    db.exec(`
      CREATE TABLE IF NOT EXISTS document_artifacts (
        id      TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        title   TEXT,
        cycle   INTEGER,
        content TEXT
      )
    `);

    // -- interview_questions --
    db.exec(`
      CREATE TABLE IF NOT EXISTS interview_questions (
        id           TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        interview_id TEXT NOT NULL,
        question     TEXT NOT NULL,
        answer       TEXT NOT NULL,
        domain       TEXT,
        seq          INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_interview_questions_interview ON interview_questions(interview_id)`);

    // -- proxy_human_decisions --
    db.exec(`
      CREATE TABLE IF NOT EXISTS proxy_human_decisions (
        id        TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        cycle     INTEGER NOT NULL,
        trigger   TEXT NOT NULL,
        triggered_by TEXT,
        decision  TEXT NOT NULL,
        rationale TEXT,
        timestamp TEXT NOT NULL,
        status   TEXT NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_proxy_human_decisions_cycle ON proxy_human_decisions(cycle)`);

    // -- projects --
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id                TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        name              TEXT,
        description       TEXT,
        intent            TEXT NOT NULL,
        scope_boundary    TEXT,
        success_criteria  TEXT,
        appetite          INTEGER,
        steering          TEXT,
        horizon           TEXT,
        status            TEXT NOT NULL,
        current_phase_id  TEXT
      )
    `);

    // -- phases --
    db.exec(`
      CREATE TABLE IF NOT EXISTS phases (
        id         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
        name       TEXT,
        description TEXT,
        project    TEXT NOT NULL,
        phase_type TEXT NOT NULL,
        intent     TEXT NOT NULL,
        steering   TEXT,
        status         TEXT NOT NULL,
        work_items     TEXT,
        completed_date TEXT
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_phases_project ON phases(project)`);

    // ----- Universal edges table -----
    db.exec(`
      CREATE TABLE IF NOT EXISTS edges (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        edge_type TEXT NOT NULL,
        props     TEXT,
        UNIQUE(source_id, target_id, edge_type)
      )
    `);

    // ----- Edge indexes -----
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edges_source
        ON edges(source_id, edge_type)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_edges_target
        ON edges(target_id, edge_type)
    `);

    // ----- Node file references table -----
    db.exec(`
      CREATE TABLE IF NOT EXISTS node_file_refs (
        node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        PRIMARY KEY (node_id, file_path)
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_file_refs_path
        ON node_file_refs(file_path)
    `);

    // ----- Type-specific indexes -----
    db.exec(`CREATE INDEX IF NOT EXISTS idx_work_items_domain ON work_items(domain)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_findings_work_item ON findings(work_item, severity)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_domain_policies_domain ON domain_policies(domain)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_domain_questions_domain ON domain_questions(domain)`);

    db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });

  transaction();
}

// ---------------------------------------------------------------------------
// checkSchemaVersion — returns false if DB is stale (deletes DB file)
// ---------------------------------------------------------------------------

export function checkSchemaVersion(db: Database.Database, dbPath: string): boolean {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version === 0) {
    // Fresh DB — compatible
    return true;
  }
  if (version !== CURRENT_SCHEMA_VERSION) {
    db.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    return false;
  }
  return true;
}
