// node-type-registry.ts — Single source of truth for node type metadata
//
// Before this file existed, extension-table metadata was duplicated across:
//   - db.ts (TYPE_TO_EXTENSION_TABLE)
//   - reader.ts (TYPE_EXTENSION_INFO map)
//   - reader.ts / query.ts (TYPE_PREFIX_MAP)
//   - query.ts (VALID_TYPES derived from TYPE_TO_EXTENSION_TABLE)
//   - writer.ts (if/else dispatch over types)
//
// Adding a new node type required touching 5-7 places with no compile-time
// check that all were updated consistently.  NODE_TYPE_REGISTRY consolidates
// all per-type metadata in one place.  The `satisfies Record<NodeType,
// NodeTypeSpec>` annotation causes tsc to error if any NodeType is missing a
// registry entry, providing exhaustiveness at compile time.
//
// Migration: WI-899 will update reader.ts, query.ts, and writer.ts to consume
// this registry instead of their local maps.  This file is additive only —
// no behavioral change in WI-898.

import type { NodeType } from "./adapter.js";
import type { AnyTable } from "./db.js";
import * as tables from "./db.js";

// ---------------------------------------------------------------------------
// NodeTypeSpec — per-type metadata record
// ---------------------------------------------------------------------------

/** Drizzle table reference for an extension table, or null when the type has
 *  no extension table (document-only or singleton types stored in the base
 *  nodes table with optional document_artifacts row). */
export type ExtensionTableRef = AnyTable | null;

export interface NodeTypeSpec {
  /**
   * The Drizzle ORM extension table for this node type, or null if the type
   * has no extension table (stored only in the base `nodes` row, or stored in
   * `document_artifacts` for document-subtype nodes that share a table).
   *
   * When non-null, this is the authoritative table reference for JOIN
   * generation in reader.ts and writer.ts dispatch.
   */
  extensionTable: ExtensionTableRef;

  /**
   * The extension table name as a SQL string, or null when extensionTable is
   * null.  Provided as a convenience for raw-SQL consumers (reader.ts) so they
   * do not need to extract the table name from the Drizzle object.
   */
  extensionTableName: string | null;

  /**
   * The ID prefix for this node type, e.g. "WI-", "F-", "GP-".
   * null means the type does not use prefix-based IDs (e.g. autopilot_state).
   */
  idPrefix: string | null;

  /**
   * The padding width used when formatting the numeric suffix of generated IDs.
   * e.g. padWidth: 3 produces "WI-001"; padWidth: 2 produces "GP-01".
   * null when idPrefix is null.
   */
  idPadWidth: number | null;

  /**
   * SQL expression fragment (aliasing extension table as `e`, base table as
   * `n`) used to build the one-line summary string for query results.
   * null when the type has no extension table or meaningful summary.
   *
   * Example: "e.title" → uses the title column directly.
   * Example: "e.severity || ' — ' || e.verdict" → concatenation expression.
   */
  summarySelector: string | null;

  /**
   * Whether this node type is listable via ideate_artifact_query(type: X).
   * Types backed by an extension table are generally queryable.
   * Types without an extension table (autopilot_state) are not.
   */
  isQueryable: boolean;
}

// ---------------------------------------------------------------------------
// NODE_TYPE_REGISTRY
//
// The `satisfies Record<NodeType, NodeTypeSpec>` annotation is the key
// compile-time safety guarantee: if a new NodeType is added to adapter.ts
// without a corresponding entry here, tsc emits a type error.
// ---------------------------------------------------------------------------

export const NODE_TYPE_REGISTRY = {
  // -------------------------------------------------------------------------
  // Structured artifact types — each has its own extension table
  // -------------------------------------------------------------------------

  work_item: {
    extensionTable: tables.workItems,
    extensionTableName: "work_items",
    idPrefix: "WI-",
    idPadWidth: 3,
    summarySelector: "e.title",
    isQueryable: true,
  },

  finding: {
    extensionTable: tables.findings,
    extensionTableName: "findings",
    idPrefix: "F-",
    idPadWidth: 3,
    summarySelector: "e.severity || ' — ' || e.verdict || ' by ' || e.reviewer",
    isQueryable: true,
  },

  domain_policy: {
    extensionTable: tables.domainPolicies,
    extensionTableName: "domain_policies",
    idPrefix: "P-",
    idPadWidth: 2,
    summarySelector: "e.description",
    isQueryable: true,
  },

  domain_decision: {
    extensionTable: tables.domainDecisions,
    extensionTableName: "domain_decisions",
    idPrefix: "D-",
    idPadWidth: 2,
    summarySelector: "e.description",
    isQueryable: true,
  },

  domain_question: {
    extensionTable: tables.domainQuestions,
    extensionTableName: "domain_questions",
    idPrefix: "Q-",
    idPadWidth: 2,
    summarySelector: "e.description",
    isQueryable: true,
  },

  guiding_principle: {
    extensionTable: tables.guidingPrinciples,
    extensionTableName: "guiding_principles",
    idPrefix: "GP-",
    idPadWidth: 2,
    summarySelector: "e.name",
    isQueryable: true,
  },

  constraint: {
    extensionTable: tables.constraints,
    extensionTableName: "constraints",
    idPrefix: "C-",
    idPadWidth: 2,
    summarySelector: "e.category || ': ' || e.description",
    isQueryable: true,
  },

  module_spec: {
    extensionTable: tables.moduleSpecs,
    extensionTableName: "module_specs",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "e.name",
    isQueryable: true,
  },

  research_finding: {
    extensionTable: tables.researchFindings,
    extensionTableName: "research_findings",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "e.topic",
    isQueryable: true,
  },

  journal_entry: {
    extensionTable: tables.journalEntries,
    extensionTableName: "journal_entries",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "'[' || e.phase || '] ' || e.title",
    isQueryable: true,
  },

  interview_question: {
    extensionTable: tables.interviewQuestions,
    extensionTableName: "interview_questions",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "e.interview_id || ': ' || e.question",
    isQueryable: true,
  },

  proxy_human_decision: {
    extensionTable: tables.proxyHumanDecisions,
    extensionTableName: "proxy_human_decisions",
    idPrefix: "PHD-",
    idPadWidth: 2,
    summarySelector: "e.trigger || ' → ' || e.decision || ' [' || e.status || ']'",
    isQueryable: true,
  },

  project: {
    extensionTable: tables.projects,
    extensionTableName: "projects",
    idPrefix: "PR-",
    idPadWidth: 3,
    summarySelector: "COALESCE(e.name, SUBSTR(e.intent, 1, 40))",
    isQueryable: true,
  },

  phase: {
    extensionTable: tables.phases,
    extensionTableName: "phases",
    idPrefix: "PH-",
    idPadWidth: 3,
    summarySelector: "COALESCE(e.name, e.phase_type || ': ' || SUBSTR(e.intent, 1, 40))",
    isQueryable: true,
  },

  // -------------------------------------------------------------------------
  // Document artifact subtypes — all stored in the document_artifacts table.
  // These share an extension table; each subtype is differentiated by the
  // `type` column on the base `nodes` row.
  // -------------------------------------------------------------------------

  decision_log: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  cycle_summary: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  review_manifest: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  review_output: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  architecture: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  overview: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  execution_strategy: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  guiding_principles: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  constraints: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  research: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  interview: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  domain_index: {
    extensionTable: tables.documentArtifacts,
    extensionTableName: "document_artifacts",
    idPrefix: null,
    idPadWidth: null,
    summarySelector: "COALESCE(e.title, n.type)",
    isQueryable: true,
  },

  // -------------------------------------------------------------------------
  // autopilot_state — singleton managed via ideate_manage_autopilot_state.
  //
  // This type is intentionally excluded from the queryable set because it is
  // a singleton state artifact, not a collection of queryable records.
  // It lives as a plain YAML file and is stored only in the base `nodes` row
  // (no extension table).  ideate_artifact_query(type: "autopilot_state")
  // silently returns zero results in the current implementation; registering
  // extensionTable: null and isQueryable: false makes this exclusion EXPLICIT
  // and documented, resolving the S2 asymmetry identified in cycle 28.
  //
  // If autopilot_state ever grows structured fields that need querying or
  // indexing, add an extension table here and update isQueryable to true.
  // -------------------------------------------------------------------------

  autopilot_state: {
    extensionTable: null,
    extensionTableName: null,
    idPrefix: null,
    idPadWidth: null,
    summarySelector: null,
    isQueryable: false,
  },
} as const satisfies Record<NodeType, NodeTypeSpec>;

// ---------------------------------------------------------------------------
// Derived utilities — computed once from the registry
// ---------------------------------------------------------------------------

/**
 * Set of NodeType values for which ideate_artifact_query is supported.
 * Derived from NODE_TYPE_REGISTRY.isQueryable — single source of truth.
 */
export const QUERYABLE_NODE_TYPES: ReadonlySet<NodeType> = new Set(
  (Object.entries(NODE_TYPE_REGISTRY) as Array<[NodeType, NodeTypeSpec]>)
    .filter(([, spec]) => spec.isQueryable)
    .map(([type]) => type)
);

/**
 * Map from NodeType to idPrefix for types that have one.
 * Derived from NODE_TYPE_REGISTRY — single source of truth for ID generation.
 */
export const NODE_TYPE_ID_PREFIXES: ReadonlyMap<NodeType, { prefix: string; padWidth: number }> = new Map(
  (Object.entries(NODE_TYPE_REGISTRY) as Array<[NodeType, NodeTypeSpec]>)
    .filter(([, spec]) => spec.idPrefix !== null && spec.idPadWidth !== null)
    .map(([type, spec]) => [
      type,
      { prefix: spec.idPrefix as string, padWidth: spec.idPadWidth as number },
    ])
);

/**
 * Maps YAML type string → Drizzle extension table reference.
 * Derived from NODE_TYPE_REGISTRY — replaces the duplicate literal in db.ts.
 *
 * Consumers: indexer.ts, adapters/local/writer.ts, tools/write.ts.
 * Note: types with extensionTable === null (autopilot_state) are excluded
 * because they have no extension table to map to.
 */
export const TYPE_TO_EXTENSION_TABLE: Record<string, AnyTable | undefined> = Object.fromEntries(
  (Object.entries(NODE_TYPE_REGISTRY) as Array<[NodeType, NodeTypeSpec]>)
    .filter(([, spec]) => spec.extensionTable !== null)
    .map(([type, spec]) => [type, spec.extensionTable as AnyTable])
);
