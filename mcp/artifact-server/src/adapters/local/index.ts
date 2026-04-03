// adapters/local/index.ts — LocalAdapter module exports
//
// Exports all LocalAdapter implementations for the local (SQLite + YAML)
// storage backend.
//
// LocalAdapter: full StorageAdapter implementation combining write (WI-552),
// read/query (WI-553), and traversal (WI-554) operations.
// Write methods are fully implemented. Read/query/traversal stubs will be
// filled in by subsequent work items.

import type {
  StorageAdapter,
  Node,
  NodeType,
  Edge,
  TraversalOptions,
  TraversalResult,
  GraphQuery,
  QueryResult,
  NodeFilter,
} from "../../adapter.js";
import { LocalWriterAdapter, type LocalWriterConfig } from "./writer.js";
import { LocalReaderAdapter } from "./reader.js";

// ---------------------------------------------------------------------------
// LocalAdapter — full StorageAdapter implementation for local .ideate/ storage
// ---------------------------------------------------------------------------

export class LocalAdapter extends LocalWriterAdapter implements StorageAdapter {
  private reader: LocalReaderAdapter;

  constructor(config: LocalWriterConfig) {
    super(config);
    this.reader = new LocalReaderAdapter(this.db, this.drizzleDb, this.ideateDir);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // LocalAdapter is initialized externally (schema creation, index rebuild,
    // watcher setup happen in server.ts). This is a no-op for now.
  }

  async shutdown(): Promise<void> {
    // Best-effort shutdown: no pending writes to flush in synchronous SQLite.
  }

  // -------------------------------------------------------------------------
  // Node CRUD — read operations (WI-553 scope)
  // -------------------------------------------------------------------------

  async getNode(id: string): Promise<Node | null> {
    return this.reader.getNode(id);
  }

  async getNodes(ids: string[]): Promise<Map<string, Node>> {
    return this.reader.getNodes(ids);
  }

  async readNodeContent(id: string): Promise<string> {
    return this.reader.readNodeContent(id);
  }

  // -------------------------------------------------------------------------
  // Edge CRUD — read operations (WI-553 scope)
  // -------------------------------------------------------------------------

  async getEdges(
    id: string,
    direction: "outgoing" | "incoming" | "both"
  ): Promise<Edge[]> {
    return this.reader.getEdges(id, direction);
  }

  // -------------------------------------------------------------------------
  // Graph traversal (WI-554 scope)
  // -------------------------------------------------------------------------

  async traverse(_options: TraversalOptions): Promise<TraversalResult> {
    throw new Error("LocalAdapter.traverse: not yet implemented (WI-554)");
  }

  async queryGraph(
    query: GraphQuery,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    return this.reader.queryGraph(query, limit, offset);
  }

  // -------------------------------------------------------------------------
  // Filtered queries (WI-553 scope)
  // -------------------------------------------------------------------------

  async queryNodes(
    filter: NodeFilter,
    limit: number,
    offset: number
  ): Promise<QueryResult> {
    return this.reader.queryNodes(filter, limit, offset);
  }

  // -------------------------------------------------------------------------
  // ID generation (WI-553 scope)
  //
  // Combines writer-specific ID generation (journal_entry, finding) with
  // reader-based ID generation for other artifact types.
  // -------------------------------------------------------------------------

  async nextId(type: NodeType, cycle?: number): Promise<string> {
    // Types handled by LocalWriterAdapter (cycle-based journal / finding IDs)
    if (type === "journal_entry" || type === "finding") {
      return super.nextId(type, cycle);
    }
    // All other types handled by LocalReaderAdapter
    return this.reader.nextId(type, cycle);
  }

  // -------------------------------------------------------------------------
  // Aggregation queries (WI-553 scope)
  // -------------------------------------------------------------------------

  async countNodes(
    filter: NodeFilter,
    group_by: "status" | "type" | "domain" | "severity"
  ): Promise<Array<{ key: string; count: number }>> {
    return this.reader.countNodes(filter, group_by);
  }

  async getDomainState(
    domains?: string[]
  ): Promise<Map<string, {
    policies: Array<{ id: string; description: string | null; status: string | null }>;
    decisions: Array<{ id: string; description: string | null; status: string | null }>;
    questions: Array<{ id: string; description: string | null; status: string | null }>;
  }>> {
    return this.reader.getDomainState(domains);
  }

  async getConvergenceData(cycle: number): Promise<{
    findings_by_severity: Record<string, number>;
    cycle_summary_content: string | null;
  }> {
    return this.reader.getConvergenceData(cycle);
  }
}

// ---------------------------------------------------------------------------
// Re-export previously existing adapter sub-components
// ---------------------------------------------------------------------------

export { LocalContextAdapter } from "./context.js";
export type {
  DocumentArtifactRow,
  GuidingPrincipleRow,
  ConstraintRow,
  ProjectRow,
  PhaseRow,
} from "./context.js";

export { LocalReaderAdapter } from "./reader.js";
export { LocalWriterAdapter } from "./writer.js";
export type { LocalWriterConfig };
