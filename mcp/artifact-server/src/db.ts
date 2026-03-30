import { sqliteTable, text, integer, primaryKey, unique } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// nodes — base table shared by all artifact types
// ---------------------------------------------------------------------------

export const nodes = sqliteTable("nodes", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  cycle_created: integer("cycle_created"),
  cycle_modified: integer("cycle_modified"),
  content_hash: text("content_hash").notNull(),
  token_count: integer("token_count"),
  file_path: text("file_path").notNull(),
  status: text("status"),
});

// ---------------------------------------------------------------------------
// Extension tables — each has id as FK referencing nodes.id
// ---------------------------------------------------------------------------

export const workItems = sqliteTable("work_items", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  complexity: text("complexity"),
  scope: text("scope"),
  depends: text("depends"),
  blocks: text("blocks"),
  criteria: text("criteria"),
  module: text("module"),
  domain: text("domain"),
  phase: text("phase"),
  notes: text("notes"),
});

export const findings = sqliteTable("findings", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  severity: text("severity").notNull(),
  work_item: text("work_item").notNull(),
  file_refs: text("file_refs"),
  verdict: text("verdict").notNull(),
  cycle: integer("cycle").notNull(),
  reviewer: text("reviewer").notNull(),
  description: text("description"),
  suggestion: text("suggestion"),
  addressed_by: text("addressed_by"),
});

export const domainPolicies = sqliteTable("domain_policies", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  derived_from: text("derived_from"),
  established: text("established"),
  amended: text("amended"),
  amended_by: text("amended_by"),
  description: text("description"),
});

export const domainDecisions = sqliteTable("domain_decisions", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  cycle: integer("cycle"),
  supersedes: text("supersedes"),
  description: text("description"),
  rationale: text("rationale"),
});

export const domainQuestions = sqliteTable("domain_questions", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  impact: text("impact"),
  source: text("source"),
  resolution: text("resolution"),
  resolved_in: integer("resolved_in"),
  description: text("description"),
  addressed_by: text("addressed_by"),
});

export const guidingPrinciples = sqliteTable("guiding_principles", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  amendment_history: text("amendment_history"),
});

export const constraints = sqliteTable("constraints", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  description: text("description"),
});

export const moduleSpecs = sqliteTable("module_specs", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  scope: text("scope"),
  provides: text("provides"),
  requires: text("requires"),
  boundary_rules: text("boundary_rules"),
});

export const researchFindings = sqliteTable("research_findings", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  topic: text("topic").notNull(),
  date: text("date"),
  content: text("content"),
  sources: text("sources"),
});

export const journalEntries = sqliteTable("journal_entries", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  phase: text("phase"),
  date: text("date"),
  title: text("title"),
  work_item: text("work_item"),
  content: text("content"),
});

export const metricsEvents = sqliteTable("metrics_events", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  event_name: text("event_name").notNull(),
  timestamp: text("timestamp"),
  payload: text("payload"),
  // Token accounting
  input_tokens: integer("input_tokens"),
  output_tokens: integer("output_tokens"),
  cache_read_tokens: integer("cache_read_tokens"),
  cache_write_tokens: integer("cache_write_tokens"),
  // Output quality signals
  outcome: text("outcome"),
  finding_count: integer("finding_count"),
  finding_severities: text("finding_severities"),
  first_pass_accepted: integer("first_pass_accepted"),
  rework_count: integer("rework_count"),
  // Cycle-level aggregates
  work_item_total_tokens: integer("work_item_total_tokens"),
  cycle_total_tokens: integer("cycle_total_tokens"),
  cycle_total_cost_estimate: text("cycle_total_cost_estimate"),
  convergence_cycles: integer("convergence_cycles"),
  // Context composition
  context_artifact_ids: text("context_artifact_ids"),
});

export const documentArtifacts = sqliteTable("document_artifacts", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  title: text("title"),
  cycle: integer("cycle"),
  content: text("content"),
});

export const interviewQuestions = sqliteTable("interview_questions", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  interview_id: text("interview_id").notNull(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  domain: text("domain"),
  seq: integer("seq").notNull(),
});

export const proxyHumanDecisions = sqliteTable("proxy_human_decisions", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  cycle: integer("cycle").notNull(),
  trigger: text("trigger").notNull(),
  triggered_by: text("triggered_by"),
  decision: text("decision").notNull(),
  rationale: text("rationale"),
  timestamp: text("timestamp").notNull(),
  status: text("status").notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  intent: text("intent").notNull(),
  scope_boundary: text("scope_boundary"),
  success_criteria: text("success_criteria"),
  appetite: integer("appetite"),
  steering: text("steering"),
  horizon: text("horizon"),
  status: text("status").notNull(),
});

export const phases = sqliteTable("phases", {
  id: text("id").primaryKey().references(() => nodes.id, { onDelete: "cascade" }),
  project: text("project").notNull(),
  phase_type: text("phase_type").notNull(),
  intent: text("intent").notNull(),
  steering: text("steering"),
  status: text("status").notNull(),
  work_items: text("work_items"),
});

// ---------------------------------------------------------------------------
// edges — universal edge table (no source_type / target_type)
// ---------------------------------------------------------------------------

export const edges = sqliteTable("edges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  source_id: text("source_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  target_id: text("target_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  edge_type: text("edge_type").notNull(),
  props: text("props"),
}, (t) => ({
  uniqEdge: unique().on(t.source_id, t.target_id, t.edge_type),
}));

// ---------------------------------------------------------------------------
// nodeFileRefs — file references per node (no node_type column)
// ---------------------------------------------------------------------------

export const nodeFileRefs = sqliteTable("node_file_refs", {
  node_id: text("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  file_path: text("file_path").notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.node_id, t.file_path] }),
}));

// ---------------------------------------------------------------------------
// AnyTable — union of all extension tables (excludes nodes itself)
// ---------------------------------------------------------------------------

export type AnyTable =
  | typeof workItems
  | typeof findings
  | typeof domainPolicies
  | typeof domainDecisions
  | typeof domainQuestions
  | typeof guidingPrinciples
  | typeof constraints
  | typeof moduleSpecs
  | typeof researchFindings
  | typeof journalEntries
  | typeof metricsEvents
  | typeof documentArtifacts
  | typeof interviewQuestions
  | typeof proxyHumanDecisions
  | typeof projects
  | typeof phases;

// ---------------------------------------------------------------------------
// TYPE_TO_EXTENSION_TABLE — maps YAML type string → Drizzle extension table
// Used by buildRow dispatch in indexer.ts
// ---------------------------------------------------------------------------

export const TYPE_TO_EXTENSION_TABLE: Record<string, AnyTable> = {
  work_item:          workItems,
  finding:            findings,
  domain_policy:      domainPolicies,
  domain_decision:    domainDecisions,
  domain_question:    domainQuestions,
  guiding_principle:  guidingPrinciples,
  constraint:         constraints,
  module_spec:        moduleSpecs,
  research_finding:   researchFindings,
  journal_entry:      journalEntries,
  metrics_event:      metricsEvents,
  decision_log:       documentArtifacts,
  cycle_summary:      documentArtifacts,
  review_output:      documentArtifacts,
  review_manifest:    documentArtifacts,
  architecture:       documentArtifacts,
  overview:           documentArtifacts,
  execution_strategy: documentArtifacts,
  guiding_principles: documentArtifacts,
  constraints:        documentArtifacts,
  research:           documentArtifacts,
  interview:          documentArtifacts,
  domain_index:       documentArtifacts,
  interview_question: interviewQuestions,
  proxy_human_decision: proxyHumanDecisions,
  project:            projects,
  phase:              phases,
};
