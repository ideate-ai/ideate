/**
 * equivalence-helpers.ts — Shared utilities for LocalAdapter vs RemoteAdapter
 * equivalence tests.
 *
 * Provides:
 *   - createDualAdapters()  initialises both adapters against the equivalence
 *     fixture and returns { local, remote, cleanup }
 *   - assertNodesEquivalent()      normalised Node comparison
 *   - assertEdgesEquivalent()      normalised, sorted Edge array comparison
 *   - assertQueryResultEquivalent() normalised QueryResult comparison
 */

import { expect } from "vitest";
import { execSync, execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { RemoteAdapter } from "../../src/adapters/remote/index.js";
import { rebuildIndex } from "../../src/indexer.js";
import type { Node, Edge, QueryResult } from "../../src/adapter.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the canonical equivalence fixture .ideate/ directory. */
export const FIXTURE_IDEATE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures/equivalence/.ideate"
);

/** GraphQL endpoint for the Dockerized test server. */
export const TEST_GRAPHQL_ENDPOINT = "http://localhost:4001/graphql";

/** Org and codebase IDs used for the equivalence test namespace. */
export const TEST_ORG_ID = "equivalence-test-org";
export const TEST_CODEBASE_ID = "equivalence-test-cb";

/** Bolt URI for the test Neo4j instance. */
export const TEST_NEO4J_URI = "bolt://localhost:7688";

/** Path to ideate-server for running the migration CLI. */
const IDEATE_SERVER_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../../../../../ideate-server"
);

// ---------------------------------------------------------------------------
// Server availability check
// ---------------------------------------------------------------------------

/**
 * Returns true if the test GraphQL server at TEST_GRAPHQL_ENDPOINT is
 * reachable (synchronous check using curl, matching the pattern in
 * remote-contract.test.ts).
 */
export function isTestServerAvailable(): boolean {
  try {
    const result = execSync(
      `curl -s -o /dev/null -w "%{http_code}" -X POST ${TEST_GRAPHQL_ENDPOINT} -H "Content-Type: application/json" -d '{"query":"{ __typename }"}'`,
      { timeout: 3000, encoding: "utf8" }
    );
    return result.trim() === "200";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Dual-adapter setup
// ---------------------------------------------------------------------------

export interface DualAdapters {
  local: LocalAdapter;
  remote: RemoteAdapter;
  cleanup: () => Promise<void>;
}

/**
 * Initialises both LocalAdapter (from fixture YAML via indexer) and
 * RemoteAdapter (fixture imported into Dockerized Neo4j via migration CLI).
 *
 * Steps:
 *   1. Copy fixture .ideate/ to a temp directory.
 *   2. Create SQLite DB + schema in that temp dir.
 *   3. Run rebuildIndex to populate SQLite from the fixture YAML files.
 *   4. Create LocalAdapter pointing at the temp dir.
 *   5. Purge any pre-existing equivalence-test data from Neo4j.
 *   6. Run the migration CLI to import fixture into Neo4j.
 *   7. Create RemoteAdapter pointing at localhost:4001.
 *
 * Returns cleanup() which closes the DB and removes the temp directory.
 *
 * NOTE: This function does not check whether the remote server is available.
 * Callers should guard with isTestServerAvailable() before calling.
 */
export async function createDualAdapters(): Promise<DualAdapters> {
  // ------------------------------------------------------------------
  // Local adapter setup
  // ------------------------------------------------------------------
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ideate-equivalence-")
  );

  // Copy fixture .ideate/ into the temp directory so tests don't modify
  // the checked-in fixture files.
  const tempIdeateDir = path.join(tmpDir, ".ideate");
  if (!fs.existsSync(FIXTURE_IDEATE_DIR)) {
    throw new Error(`Equivalence fixture not found: ${FIXTURE_IDEATE_DIR}`);
  }
  fs.cpSync(FIXTURE_IDEATE_DIR, tempIdeateDir, { recursive: true });

  // Create the SQLite database and schema.
  const dbPath = path.join(tmpDir, "index.db");
  const db = new Database(dbPath);
  createSchema(db);
  const drizzleDb = drizzle(db, { schema: dbSchema });

  // Populate the SQLite index from the fixture YAML files.
  rebuildIndex(db, drizzleDb, tempIdeateDir);

  const local = new LocalAdapter({ db, drizzleDb, ideateDir: tempIdeateDir });

  // ------------------------------------------------------------------
  // Remote adapter setup
  // ------------------------------------------------------------------

  // Purge any existing equivalence-test data so each test run starts clean.
  try {
    await fetch(TEST_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Org-Id": TEST_ORG_ID,
        "X-Codebase-Id": TEST_CODEBASE_ID,
      },
      body: JSON.stringify({
        query: `mutation { _purgeOrgData(codebaseId: "${TEST_CODEBASE_ID}") }`,
      }),
    });
  } catch {
    // Ignore purge errors — the server may not have prior data.
  }

  // Import fixture into Neo4j via the migration CLI.
  execFileSync(
    "npm",
    [
      "run", "migrate", "--",
      "migrate",
      "--source", tempIdeateDir,
      "--neo4j-uri", TEST_NEO4J_URI,
      "--neo4j-user", "neo4j",
      "--neo4j-password", "testpassword",
      "--org-id", TEST_ORG_ID,
      "--codebase-id", TEST_CODEBASE_ID,
    ],
    {
      cwd: IDEATE_SERVER_PATH,
      timeout: 60_000,
      stdio: "pipe",
    }
  );

  const remote = new RemoteAdapter({
    endpoint: TEST_GRAPHQL_ENDPOINT,
    org_id: TEST_ORG_ID,
    codebase_id: TEST_CODEBASE_ID,
  });

  // ------------------------------------------------------------------
  // Cleanup function
  // ------------------------------------------------------------------
  const cleanup = async (): Promise<void> => {
    try {
      await local.shutdown();
    } catch {
      // ignore
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      await remote.shutdown();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { local, remote, cleanup };
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Options controlling which fields are included in node comparisons.
 */
export interface NodeCompareOptions {
  /**
   * Skip content_hash comparison (default: true).
   * LocalAdapter computes the hash from YAML file bytes; RemoteAdapter from
   * stored properties. The values are not guaranteed to match.
   */
  skipContentHash?: boolean;
  /**
   * Skip token_count comparison (default: true).
   * Both backends derive this from the serialised content, but the
   * serialisation format may differ slightly.
   */
  skipTokenCount?: boolean;
}

const DEFAULT_NODE_COMPARE_OPTIONS: Required<NodeCompareOptions> = {
  skipContentHash: true,
  skipTokenCount: true,
};

/** Returns a normalised copy of a Node with selected computed fields removed. */
function normaliseNode(
  node: Node,
  options: Required<NodeCompareOptions>
): Partial<Node> {
  const copy: Partial<Node> = { ...node };
  if (options.skipContentHash) {
    delete copy.content_hash;
  }
  if (options.skipTokenCount) {
    delete copy.token_count;
  }
  return copy;
}

// ---------------------------------------------------------------------------
// Public comparison utilities
// ---------------------------------------------------------------------------

/**
 * Asserts that two Node objects are equivalent, normalising away fields that
 * are expected to differ between backends (content_hash and token_count by
 * default).
 */
export function assertNodesEquivalent(
  local: Node,
  remote: Node,
  options: NodeCompareOptions = {}
): void {
  const opts = { ...DEFAULT_NODE_COMPARE_OPTIONS, ...options };
  const normLocal = normaliseNode(local, opts);
  const normRemote = normaliseNode(remote, opts);
  expect(normLocal).toEqual(normRemote);
}

/**
 * Asserts that two Edge arrays are equivalent.
 *
 * Edges are sorted by (source_id, target_id, edge_type) before comparison so
 * different orderings from the two backends do not cause false failures.
 */
/** Containment edge types created by the Neo4j migration for multi-tenant
 *  hierarchy. These don't exist in LocalAdapter's SQLite model. */
const CONTAINMENT_EDGE_TYPES = new Set([
  "OWNS_CODEBASE", "OWNS_PROJECT", "HAS_PHASE", "HAS_WORK_ITEM",
  "OWNS_KNOWLEDGE", "REFERENCES_CODEBASE",
  // lowercase variants (adapter normalizes to lowercase)
  "owns_codebase", "owns_project", "has_phase", "has_work_item",
  "owns_knowledge", "references_codebase",
]);

export function assertEdgesEquivalent(
  local: Edge[],
  remote: Edge[]
): void {
  const strip = (e: Edge) => ({
    source_id: e.source_id,
    target_id: e.target_id,
    edge_type: e.edge_type,
  });
  // Filter out containment edges that only exist in the Neo4j model
  const filterContainment = (edges: Edge[]) =>
    edges.filter(e => !CONTAINMENT_EDGE_TYPES.has(e.edge_type));
  const sort = (edges: Edge[]) =>
    [...edges].map(strip).sort((a, b) => {
      if (a.source_id !== b.source_id) return a.source_id.localeCompare(b.source_id);
      if (a.target_id !== b.target_id) return a.target_id.localeCompare(b.target_id);
      return a.edge_type.localeCompare(b.edge_type);
    });

  expect(sort(filterContainment(local))).toEqual(sort(filterContainment(remote)));
}

/**
 * Asserts that two QueryResult objects are equivalent.
 *
 * Nodes in the result are sorted by node.id before comparison.
 * content_hash and token_count fields inside each NodeMeta are stripped with
 * the same defaults as assertNodesEquivalent.
 */
export function assertQueryResultEquivalent(
  local: QueryResult,
  remote: QueryResult,
  options: NodeCompareOptions = {}
): void {
  const opts = { ...DEFAULT_NODE_COMPARE_OPTIONS, ...options };

  const normaliseResultNode = (
    entry: QueryResult["nodes"][number]
  ) => {
    const nodeCopy: Partial<typeof entry.node> = { ...entry.node };
    if (opts.skipContentHash) {
      delete nodeCopy.content_hash;
    }
    if (opts.skipTokenCount) {
      delete nodeCopy.token_count;
    }
    // Strip graph-traversal context fields and summary (presentation text
    // that differs between adapters — LocalAdapter returns "", RemoteAdapter
    // derives from content)
    const { edge_type: _et, direction: _dir, depth: _dep, summary: _sum, ...rest } = entry;
    return { ...rest, node: nodeCopy as typeof entry.node, summary: "" };
  };

  const sort = (result: QueryResult): QueryResult => ({
    ...result,
    nodes: [...result.nodes]
      .map(normaliseResultNode)
      .sort((a, b) => a.node.id.localeCompare(b.node.id)),
  });

  expect(sort(local)).toEqual(sort(remote));
}
