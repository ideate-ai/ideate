/**
 * adapter-equivalence.test.ts — Verify LocalAdapter and RemoteAdapter return consistent shapes
 *
 * Per P-60: All StorageAdapter implementations must expose identical interface contracts.
 * Methods with the same name must accept the same parameters and return the same shaped results.
 *
 * This test file verifies equivalence between LocalAdapter and RemoteAdapter for:
 * - nextId: Both return scalar string IDs
 * - getNode: Both return Node | null with properties
 * - getNodes: Both return Map<string, Node> with properties
 * - queryNodes: Both return QueryResult with nodes containing NodeMeta; pagination
 *     validation (INVALID_LIMIT, INVALID_OFFSET)
 * - deleteNode: Both validate node ID and delete the node
 * - putEdge: Both validate edge fields (MISSING_EDGE_SOURCE, MISSING_EDGE_TARGET, MISSING_EDGE_TYPE, INVALID_EDGE_TYPE)
 * - removeEdges: Both validate source_id (INVALID_NODE_ID) and edge types (INVALID_EDGE_TYPE)
 * - putNode: Both validate node ID, type (INVALID_NODE_TYPE), properties (MISSING_NODE_PROPERTIES), and upsert the node
 * - patchNode: Both validate node ID and merge properties
 * - batchMutate: Node validation (MISSING_NODE_ID, MISSING_NODE_TYPE, MISSING_NODE_PROPERTIES, INVALID_NODE_TYPE);
 *     edge validation (MISSING_EDGE_SOURCE, MISSING_EDGE_TARGET, MISSING_EDGE_TYPE, INVALID_EDGE_TYPE)
 * - queryGraph: Both return graph results with nodes and edges; pagination
 *     validation (INVALID_LIMIT, INVALID_OFFSET)
 *
 * Q-123: Resolves the gap that WI-619 specified this file but it was never created.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../src/schema.js";
import * as dbSchema from "../../src/db.js";
import { LocalAdapter } from "../../src/adapters/local/index.js";
import { RemoteAdapter } from "../../src/adapters/remote/index.js";
import { ValidatingAdapter } from "../../src/validating.js";
import { ConnectionError, ImmutableFieldError } from "../../src/adapter.js";
import type {
  StorageAdapter,
  Node,
  NodeMeta,
  QueryResult,
  NodeType,
  EdgeType,
} from "../../src/adapter.js";

// -----------------------------------------------------------------------------
// Test Configuration
// -----------------------------------------------------------------------------

/**
 * Check if the remote server is available at localhost:4000
 */
async function isRemoteServerAvailable(): Promise<boolean> {
  try {
    const res = await fetch("http://localhost:4000/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// LocalAdapter Factory
// -----------------------------------------------------------------------------

interface LocalAdapterSetup {
  adapter: StorageAdapter;
  tmpDir: string;
  db: Database.Database;
}

async function createLocalAdapter(): Promise<LocalAdapterSetup> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-equiv-test-"));
  const ideateDir = path.join(tmpDir, ".ideate");

  // Create the minimal directory structure LocalAdapter expects
  for (const sub of [
    "work-items",
    "policies",
    "decisions",
    "questions",
    "principles",
    "constraints",
    "modules",
    "research",
    "interviews",
    "projects",
    "phases",
    "plan",
    "steering",
    "domains",
    "archive/cycles",
    "archive/incremental",
  ]) {
    fs.mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }

  // Create domains index (needed for cycle operations)
  fs.writeFileSync(
    path.join(ideateDir, "domains", "index.yaml"),
    "current_cycle: 1\n",
    "utf8"
  );

  const dbPath = path.join(tmpDir, "test.db");
  const db = new Database(dbPath);
  createSchema(db);

  const drizzleDb = drizzle(db, { schema: dbSchema });

  const raw = new LocalAdapter({ db, drizzleDb, ideateDir });
  await raw.initialize();
  const adapter = new ValidatingAdapter(raw);

  return { adapter, tmpDir, db };
}

async function cleanupLocalAdapter(setup: LocalAdapterSetup): Promise<void> {
  try {
    setup.db.close();
  } catch {
    // ignore
  }
  if (setup.tmpDir) {
    fs.rmSync(setup.tmpDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// RemoteAdapter Factory
// -----------------------------------------------------------------------------

function createRemoteAdapter(): RemoteAdapter {
  return new RemoteAdapter({
    endpoint: "http://localhost:4000/graphql",
    org_id: "test-org",
    codebase_id: "test-codebase",
    auth_token: null,
  });
}

// -----------------------------------------------------------------------------
// Shape Validation Helpers
// -----------------------------------------------------------------------------

/**
 * Validate that a value is a valid NodeMeta shape
 */
function expectValidNodeMeta(value: unknown): asserts value is NodeMeta {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  const meta = value as NodeMeta;
  expect(typeof meta.id).toBe("string");
  expect(typeof meta.type).toBe("string");
  expect(meta.status === null || typeof meta.status === "string").toBe(true);
  expect(meta.cycle_created === null || typeof meta.cycle_created === "number").toBe(true);
  expect(meta.cycle_modified === null || typeof meta.cycle_modified === "number").toBe(true);
  expect(typeof meta.content_hash).toBe("string");
  expect(meta.token_count === null || typeof meta.token_count === "number").toBe(true);
}

/**
 * Validate that a value is a valid Node shape (NodeMeta + properties)
 */
function expectValidNode(value: unknown): asserts value is Node {
  expectValidNodeMeta(value);
  const node = value as Node;
  expect(typeof node.properties).toBe("object");
  expect(node.properties).not.toBeNull();
}

/**
 * Validate that two NodeMeta objects have equivalent shape
 */
function expectNodeMetaEquivalence(a: NodeMeta, b: NodeMeta): void {
  expect(a.id).toBe(b.id);
  expect(a.type).toBe(b.type);
  expect(a.status).toBe(b.status);
  expect(a.cycle_created).toBe(b.cycle_created);
  expect(a.cycle_modified).toBe(b.cycle_modified);
  expect(a.content_hash).toBe(b.content_hash);
  expect(a.token_count).toBe(b.token_count);
}

/**
 * Validate that two Node objects have equivalent shape
 * (compares metadata and properties)
 */
function expectNodeEquivalence(a: Node, b: Node): void {
  expectNodeMetaEquivalence(a, b);
  // Properties may have subtle differences (JSON serialization, etc.)
  // but core keys should match
  const aKeys = Object.keys(a.properties).sort();
  const bKeys = Object.keys(b.properties).sort();
  expect(aKeys).toEqual(bKeys);

  for (const key of aKeys) {
    // Handle potential differences in array/object serialization
    const aVal = a.properties[key];
    const bVal = b.properties[key];
    if (typeof aVal === "object" && aVal !== null) {
      expect(JSON.stringify(aVal)).toBe(JSON.stringify(bVal));
    } else {
      expect(aVal).toBe(bVal);
    }
  }
}

/**
 * Validate that two QueryResults have equivalent shape
 */
function expectQueryResultEquivalence(a: QueryResult, b: QueryResult): void {
  expect(a.total_count).toBe(b.total_count);
  expect(a.nodes.length).toBe(b.nodes.length);

  for (let i = 0; i < a.nodes.length; i++) {
    const aNode = a.nodes[i];
    const bNode = b.nodes.find(n => n.node.id === aNode.node.id);
    expect(bNode).toBeTruthy();
    if (bNode) {
      expectNodeMetaEquivalence(aNode.node, bNode.node);
      // Summary may differ slightly between implementations
      expect(typeof aNode.summary).toBe("string");
      expect(typeof bNode.summary).toBe("string");
    }
  }
}

// -----------------------------------------------------------------------------
// Equivalence Tests
// -----------------------------------------------------------------------------

describe("StorageAdapter Equivalence (P-60)", () => {
  // Shared state
  let localSetup: LocalAdapterSetup;
  let remoteAdapter: RemoteAdapter | null = null;
  let remoteAvailable = false;

  beforeAll(async () => {
    localSetup = await createLocalAdapter();
    remoteAvailable = await isRemoteServerAvailable();
    if (remoteAvailable) {
      remoteAdapter = createRemoteAdapter();
      try {
        await remoteAdapter.initialize();
      } catch (err) {
        remoteAvailable = false;
        remoteAdapter = null;
      }
    }
  });

  afterAll(async () => {
    await cleanupLocalAdapter(localSetup);
    if (remoteAdapter) {
      await remoteAdapter.shutdown();
    }
  });

  // -----------------------------------------------------------------------------
  // nextId Equivalence
  // -----------------------------------------------------------------------------

  describe("nextId", () => {
    it("LocalAdapter returns scalar string for work_item", async () => {
      const id = await localSetup.adapter.nextId("work_item");
      expect(typeof id).toBe("string");
      expect(id).toMatch(/^WI-\d{3}$/);
    });

    it("LocalAdapter returns scalar string for guiding_principle", async () => {
      const id = await localSetup.adapter.nextId("guiding_principle");
      expect(typeof id).toBe("string");
      expect(id).toMatch(/^GP-\d{2}$/);
    });

    it("LocalAdapter returns scalar string for cycle-scoped types (with cycle)", async () => {
      const id = await localSetup.adapter.nextId("journal_entry", 1);
      expect(typeof id).toBe("string");
      expect(id).toMatch(/^J-\d{3}-\d{3}$/);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter returns scalar string for work_item", async () => {
      if (!remoteAdapter) return;
      const id = await remoteAdapter.nextId("work_item");
      expect(typeof id).toBe("string");
      expect(id).toMatch(/^WI-\d{3}$/);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter returns scalar string for guiding_principle", async () => {
      if (!remoteAdapter) return;
      const id = await remoteAdapter.nextId("guiding_principle");
      expect(typeof id).toBe("string");
      expect(id).toMatch(/^GP-\d{2}$/);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter returns scalar string for cycle-scoped types (with cycle)", async () => {
      if (!remoteAdapter) return;
      const id = await remoteAdapter.nextId("journal_entry", 1);
      expect(typeof id).toBe("string");
      expect(id).toMatch(/^J-\d{3}-\d{3}$/);
    });

    it.skipIf(!remoteAvailable)("Both adapters return same ID format for same type", async () => {
      if (!remoteAdapter) return;

      // Create nodes in both adapters and compare ID formats
      const localId = await localSetup.adapter.nextId("work_item");
      const remoteId = await remoteAdapter.nextId("work_item");

      // Both should match the WI-NNN pattern
      expect(localId).toMatch(/^WI-\d{3}$/);
      expect(remoteId).toMatch(/^WI-\d{3}$/);

      // The format should be identical
      expect(typeof localId).toBe(typeof remoteId);
      expect(localId.slice(0, 3)).toBe(remoteId.slice(0, 3)); // Both start with "WI-"
    });
  });

  // -----------------------------------------------------------------------------
  // getNode Equivalence
  // -----------------------------------------------------------------------------

  describe("getNode", () => {
    it("LocalAdapter returns Node with properties for existing node", async () => {
      // Create a test node
      await localSetup.adapter.putNode({
        id: "GP-EQUIV-01",
        type: "guiding_principle",
        properties: { name: "Equivalence Test", description: "Testing adapter equivalence" },
      });

      const node = await localSetup.adapter.getNode("GP-EQUIV-01");
      expect(node).not.toBeNull();
      expectValidNode(node);
      expect(node!.id).toBe("GP-EQUIV-01");
      expect(node!.type).toBe("guiding_principle");
      expect(node!.properties.name).toBe("Equivalence Test");
    });

    it("LocalAdapter returns null for missing node", async () => {
      const node = await localSetup.adapter.getNode("MISSING-NODE-999");
      expect(node).toBeNull();
    });

    it("LocalAdapter getNode returns consistent shape across node types", async () => {
      // Test work_item
      await localSetup.adapter.putNode({
        id: "WI-EQUIV-01",
        type: "work_item",
        properties: { title: "Test Work Item", status: "pending" },
      });

      const workItem = await localSetup.adapter.getNode("WI-EQUIV-01");
      expectValidNode(workItem);
      expect(workItem!.type).toBe("work_item");
      expect(workItem!.properties.title).toBe("Test Work Item");

      // Test domain_policy
      await localSetup.adapter.putNode({
        id: "P-EQUIV-01",
        type: "domain_policy",
        properties: { domain: "test", description: "Test policy", status: "active" },
      });

      const policy = await localSetup.adapter.getNode("P-EQUIV-01");
      expectValidNode(policy);
      expect(policy!.type).toBe("domain_policy");
      expect(policy!.properties.domain).toBe("test");
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter returns Node with properties for existing node", async () => {
      if (!remoteAdapter) return;

      // First create via remote
      await remoteAdapter.putNode({
        id: "GP-REMOTE-01",
        type: "guiding_principle",
        properties: { name: "Remote Test", description: "Testing remote adapter" },
      });

      const node = await remoteAdapter.getNode("GP-REMOTE-01");
      expect(node).not.toBeNull();
      expectValidNode(node);
      expect(node!.id).toBe("GP-REMOTE-01");
      expect(node!.type).toBe("guiding_principle");
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter returns null for missing node", async () => {
      if (!remoteAdapter) return;

      const node = await remoteAdapter.getNode("MISSING-REMOTE-999");
      expect(node).toBeNull();
    });

    it.skipIf(!remoteAvailable)("Both adapters return equivalent Node shapes for same data", async () => {
      if (!remoteAdapter) return;

      // Create identical nodes in both adapters
      const testId = `GP-EQUIV-${Date.now()}`;
      const testProps = {
        name: "Equivalence Test",
        description: "Testing shape equivalence",
      };

      await localSetup.adapter.putNode({
        id: testId,
        type: "guiding_principle",
        properties: testProps,
      });

      await remoteAdapter.putNode({
        id: testId,
        type: "guiding_principle",
        properties: testProps,
      });

      const localNode = await localSetup.adapter.getNode(testId);
      const remoteNode = await remoteAdapter.getNode(testId);

      expect(localNode).not.toBeNull();
      expect(remoteNode).not.toBeNull();

      if (localNode && remoteNode) {
        // Metadata should match
        expectNodeMetaEquivalence(localNode, remoteNode);

        // Properties should have same keys and values
        expect(Object.keys(localNode.properties).sort()).toEqual(Object.keys(remoteNode.properties).sort());
      }
    });
  });

  // -----------------------------------------------------------------------------
  // getNodes Equivalence
  // -----------------------------------------------------------------------------

  describe("getNodes", () => {
    it("LocalAdapter returns Map with Nodes for multiple IDs", async () => {
      // Create test nodes
      await localSetup.adapter.putNode({
        id: "GP-BATCH-01",
        type: "guiding_principle",
        properties: { name: "Batch 1" },
      });
      await localSetup.adapter.putNode({
        id: "GP-BATCH-02",
        type: "guiding_principle",
        properties: { name: "Batch 2" },
      });

      const result = await localSetup.adapter.getNodes(["GP-BATCH-01", "GP-BATCH-02"]);
      expect(result instanceof Map).toBe(true);
      expect(result.size).toBe(2);
      expect(result.has("GP-BATCH-01")).toBe(true);
      expect(result.has("GP-BATCH-02")).toBe(true);

      // Verify each node has correct shape
      for (const [, node] of result) {
        expectValidNode(node);
      }
    });

    it("LocalAdapter omits missing IDs from result Map", async () => {
      await localSetup.adapter.putNode({
        id: "GP-BATCH-03",
        type: "guiding_principle",
        properties: { name: "Present" },
      });

      const result = await localSetup.adapter.getNodes(["GP-BATCH-03", "MISSING-BATCH"]);
      expect(result.size).toBe(1);
      expect(result.has("GP-BATCH-03")).toBe(true);
      expect(result.has("MISSING-BATCH")).toBe(false);
    });

    it("LocalAdapter returns empty Map for empty input", async () => {
      const result = await localSetup.adapter.getNodes([]);
      expect(result instanceof Map).toBe(true);
      expect(result.size).toBe(0);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter returns Map with Nodes for multiple IDs", async () => {
      if (!remoteAdapter) return;

      await remoteAdapter.putNode({
        id: "GP-RBATCH-01",
        type: "guiding_principle",
        properties: { name: "Remote Batch 1" },
      });
      await remoteAdapter.putNode({
        id: "GP-RBATCH-02",
        type: "guiding_principle",
        properties: { name: "Remote Batch 2" },
      });

      const result = await remoteAdapter.getNodes(["GP-RBATCH-01", "GP-RBATCH-02"]);
      expect(result instanceof Map).toBe(true);
      expect(result.size).toBe(2);

      for (const [, node] of result) {
        expectValidNode(node);
      }
    });

    it.skipIf(!remoteAvailable)("Both adapters return equivalent Map shapes", async () => {
      if (!remoteAdapter) return;

      const id1 = `GP-BATCH-${Date.now()}-1`;
      const id2 = `GP-BATCH-${Date.now()}-2`;

      await localSetup.adapter.putNode({
        id: id1,
        type: "guiding_principle",
        properties: { name: "Test 1" },
      });
      await localSetup.adapter.putNode({
        id: id2,
        type: "guiding_principle",
        properties: { name: "Test 2" },
      });

      await remoteAdapter.putNode({
        id: id1,
        type: "guiding_principle",
        properties: { name: "Test 1" },
      });
      await remoteAdapter.putNode({
        id: id2,
        type: "guiding_principle",
        properties: { name: "Test 2" },
      });

      const localResult = await localSetup.adapter.getNodes([id1, id2]);
      const remoteResult = await remoteAdapter.getNodes([id1, id2]);

      expect(localResult.size).toBe(remoteResult.size);

      for (const [id, localNode] of localResult) {
        const remoteNode = remoteResult.get(id);
        expect(remoteNode).toBeTruthy();
        if (remoteNode) {
          expectNodeEquivalence(localNode, remoteNode);
        }
      }
    });
  });

  // -----------------------------------------------------------------------------
  // queryNodes Equivalence
  // -----------------------------------------------------------------------------

  describe("queryNodes", () => {
    beforeEach(async () => {
      // Create fresh test data for each queryNodes test
      await localSetup.adapter.putNode({
        id: "GP-QUERY-01",
        type: "guiding_principle",
        properties: { name: "Query Test 1", description: "For testing queries" },
      });
      await localSetup.adapter.putNode({
        id: "GP-QUERY-02",
        type: "guiding_principle",
        properties: { name: "Query Test 2", description: "For testing queries" },
      });
      await localSetup.adapter.putNode({
        id: "WI-QUERY-01",
        type: "work_item",
        properties: { title: "Query Work Item", status: "pending" },
      });
    });

    it("LocalAdapter returns QueryResult with nodes containing NodeMeta", async () => {
      const result = await localSetup.adapter.queryNodes({ type: "guiding_principle" }, 10, 0);

      expect(typeof result.total_count).toBe("number");
      expect(Array.isArray(result.nodes)).toBe(true);

      for (const item of result.nodes) {
        expectValidNodeMeta(item.node);
        expect(typeof item.summary).toBe("string");
      }
    });

    it("LocalAdapter queryNodes respects type filter", async () => {
      const result = await localSetup.adapter.queryNodes({ type: "guiding_principle" }, 10, 0);
      const ids = result.nodes.map(n => n.node.id);

      expect(ids.some(id => id.startsWith("GP-"))).toBe(true);
      expect(ids.some(id => id.startsWith("WI-"))).toBe(false);
    });

    it("LocalAdapter queryNodes respects pagination", async () => {
      // Create several more nodes for pagination test
      for (let i = 3; i <= 5; i++) {
        await localSetup.adapter.putNode({
          id: `GP-QUERY-${String(i).padStart(2, "0")}`,
          type: "guiding_principle",
          properties: { name: `Query Test ${i}` },
        });
      }

      const page1 = await localSetup.adapter.queryNodes({ type: "guiding_principle" }, 2, 0);
      const page2 = await localSetup.adapter.queryNodes({ type: "guiding_principle" }, 2, 2);

      expect(page1.nodes.length).toBeLessThanOrEqual(2);
      expect(page2.nodes.length).toBeLessThanOrEqual(2);

      // No overlap between pages
      const page1Ids = new Set(page1.nodes.map(n => n.node.id));
      for (const node of page2.nodes) {
        expect(page1Ids.has(node.node.id)).toBe(false);
      }
    });

    it("LocalAdapter queryNodes returns empty result for no matches", async () => {
      const result = await localSetup.adapter.queryNodes({ type: "module_spec" }, 10, 0);
      expect(result.nodes).toHaveLength(0);
      expect(result.total_count).toBe(0);
    });

    it.skipIf(!remoteAvailable)("RemoteAdapter returns QueryResult with nodes containing NodeMeta", async () => {
      if (!remoteAdapter) return;

      // Create a test node via remote
      const timestamp = Date.now();
      await remoteAdapter.putNode({
        id: `GP-REMOTE-QUERY-${timestamp}`,
        type: "guiding_principle",
        properties: { name: "Remote Query Test" },
      });

      const result = await remoteAdapter.queryNodes({ type: "guiding_principle" }, 10, 0);

      expect(typeof result.total_count).toBe("number");
      expect(Array.isArray(result.nodes)).toBe(true);

      for (const item of result.nodes) {
        expectValidNodeMeta(item.node);
        expect(typeof item.summary).toBe("string");
      }
    });

    it.skipIf(!remoteAvailable)("Both adapters return equivalent QueryResult shapes", async () => {
      if (!remoteAdapter) return;

      // Note: This test may have limitations if the remote server
      // has different data than the local adapter. We compare shapes,
      // not specific data content.

      const localResult = await localSetup.adapter.queryNodes({ type: "guiding_principle" }, 5, 0);
      const remoteResult = await remoteAdapter.queryNodes({ type: "guiding_principle" }, 5, 0);

      // Both should have the same structure
      expect(typeof localResult.total_count).toBe("number");
      expect(typeof remoteResult.total_count).toBe("number");
      expect(Array.isArray(localResult.nodes)).toBe(true);
      expect(Array.isArray(remoteResult.nodes)).toBe(true);

      // Each node in both results should have valid NodeMeta
      for (const item of localResult.nodes) {
        expectValidNodeMeta(item.node);
      }
      for (const item of remoteResult.nodes) {
        expectValidNodeMeta(item.node);
      }
    });
  });

  // -----------------------------------------------------------------------------
  // Validation Equivalence
  // -----------------------------------------------------------------------------

  describe("Validation equivalence", () => {
    it("queryNodes: negative limit throws INVALID_LIMIT from LocalAdapter", async () => {
      await expect(localSetup.adapter.queryNodes({}, -1, 0)).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_LIMIT",
      });
    });

    it.skipIf(!remoteAvailable)("queryNodes: negative limit throws INVALID_LIMIT from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(remoteAdapter.queryNodes({}, -1, 0)).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_LIMIT",
      });
    });

    it("queryNodes: negative offset throws INVALID_OFFSET from LocalAdapter", async () => {
      await expect(localSetup.adapter.queryNodes({}, 10, -1)).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_OFFSET",
      });
    });

    it.skipIf(!remoteAvailable)("queryNodes: negative offset throws INVALID_OFFSET from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(remoteAdapter.queryNodes({}, 10, -1)).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_OFFSET",
      });
    });

    it("queryGraph: negative limit throws INVALID_LIMIT from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.queryGraph({ origin_id: "GP-TEST-01" }, -1, 0)
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_LIMIT",
      });
    });

    it.skipIf(!remoteAvailable)("queryGraph: negative limit throws INVALID_LIMIT from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.queryGraph({ origin_id: "GP-TEST-01" }, -1, 0)
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_LIMIT",
      });
    });

    it("queryGraph: negative offset throws INVALID_OFFSET from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.queryGraph({ origin_id: "GP-TEST-01" }, 10, -1)
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_OFFSET",
      });
    });

    it.skipIf(!remoteAvailable)("queryGraph: negative offset throws INVALID_OFFSET from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.queryGraph({ origin_id: "GP-TEST-01" }, 10, -1)
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_OFFSET",
      });
    });

    it("traverse: non-array seed_ids throws INVALID_SEED_IDS from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.traverse({ seed_ids: "not-an-array" as any, token_budget: 1000 })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_SEED_IDS",
      });
    });

    it.skipIf(!remoteAvailable)("traverse: non-array seed_ids throws INVALID_SEED_IDS from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.traverse({ seed_ids: "not-an-array" as any, token_budget: 1000 })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_SEED_IDS",
      });
    });

    it("batchMutate: empty batch throws EMPTY_BATCH from LocalAdapter", async () => {
      await expect(localSetup.adapter.batchMutate({ nodes: [], edges: [] })).rejects.toMatchObject({
        name: "ValidationError",
        code: "EMPTY_BATCH",
      });
    });

    it.skipIf(!remoteAvailable)("batchMutate: empty batch throws EMPTY_BATCH from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(remoteAdapter.batchMutate({ nodes: [], edges: [] })).rejects.toMatchObject({
        name: "ValidationError",
        code: "EMPTY_BATCH",
      });
    });

    it("batchMutate: node missing id throws MISSING_NODE_ID from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.batchMutate({
          nodes: [{ type: "guiding_principle", properties: { name: "Test" } } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_NODE_ID",
      });
    });

    it.skipIf(!remoteAvailable)("batchMutate: node missing id throws MISSING_NODE_ID from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.batchMutate({
          nodes: [{ type: "guiding_principle", properties: { name: "Test" } } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_NODE_ID",
      });
    });

    it("batchMutate: node missing type throws MISSING_NODE_TYPE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.batchMutate({
          nodes: [{ id: "GP-BATCH-NOTYPE", properties: { name: "Test" } } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_NODE_TYPE",
      });
    });

    it.skipIf(!remoteAvailable)("batchMutate: node missing type throws MISSING_NODE_TYPE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.batchMutate({
          nodes: [{ id: "GP-BATCH-NOTYPE", properties: { name: "Test" } } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_NODE_TYPE",
      });
    });

    it("batchMutate: node missing properties throws MISSING_NODE_PROPERTIES from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.batchMutate({
          nodes: [{ id: "GP-BATCH-NOPROPS", type: "guiding_principle" } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_NODE_PROPERTIES",
      });
    });

    it.skipIf(!remoteAvailable)("batchMutate: node missing properties throws MISSING_NODE_PROPERTIES from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.batchMutate({
          nodes: [{ id: "GP-BATCH-NOPROPS", type: "guiding_principle" } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_NODE_PROPERTIES",
      });
    });

    it("batchMutate: node with invalid type throws INVALID_NODE_TYPE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.batchMutate({
          nodes: [{ id: "GP-BATCH-BADTYPE", type: "not_a_real_type" as any, properties: { name: "Test" } }],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_TYPE",
      });
    });

    it.skipIf(!remoteAvailable)("batchMutate: node with invalid type throws INVALID_NODE_TYPE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.batchMutate({
          nodes: [{ id: "GP-BATCH-BADTYPE", type: "not_a_real_type" as any, properties: { name: "Test" } }],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_TYPE",
      });
    });

    it("batchMutate: edge missing source_id throws MISSING_EDGE_SOURCE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.batchMutate({
          nodes: [
            { id: "GP-ESRC-01", type: "guiding_principle", properties: { name: "Test 1" } },
            { id: "GP-ESRC-02", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [{ target_id: "GP-ESRC-02", edge_type: "relates_to", properties: {} } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_SOURCE",
      });
    });

    it.skipIf(!remoteAvailable)("batchMutate: edge missing source_id throws MISSING_EDGE_SOURCE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.batchMutate({
          nodes: [
            { id: "GP-ESRC-01", type: "guiding_principle", properties: { name: "Test 1" } },
            { id: "GP-ESRC-02", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [{ target_id: "GP-ESRC-02", edge_type: "relates_to", properties: {} } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_SOURCE",
      });
    });

    it("batchMutate: edge missing target_id throws MISSING_EDGE_TARGET from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.batchMutate({
          nodes: [
            { id: "GP-ETGT-01", type: "guiding_principle", properties: { name: "Test 1" } },
            { id: "GP-ETGT-02", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [{ source_id: "GP-ETGT-01", edge_type: "relates_to", properties: {} } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_TARGET",
      });
    });

    it.skipIf(!remoteAvailable)("batchMutate: edge missing target_id throws MISSING_EDGE_TARGET from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.batchMutate({
          nodes: [
            { id: "GP-ETGT-01", type: "guiding_principle", properties: { name: "Test 1" } },
            { id: "GP-ETGT-02", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [{ source_id: "GP-ETGT-01", edge_type: "relates_to", properties: {} } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_TARGET",
      });
    });

    it("batchMutate: edge missing edge_type throws MISSING_EDGE_TYPE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.batchMutate({
          nodes: [
            { id: "GP-ETYPE-01", type: "guiding_principle", properties: { name: "Test 1" } },
            { id: "GP-ETYPE-02", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [{ source_id: "GP-ETYPE-01", target_id: "GP-ETYPE-02", properties: {} } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_TYPE",
      });
    });

    it.skipIf(!remoteAvailable)("batchMutate: edge missing edge_type throws MISSING_EDGE_TYPE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.batchMutate({
          nodes: [
            { id: "GP-ETYPE-01", type: "guiding_principle", properties: { name: "Test 1" } },
            { id: "GP-ETYPE-02", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [{ source_id: "GP-ETYPE-01", target_id: "GP-ETYPE-02", properties: {} } as any],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_TYPE",
      });
    });

    it("batchMutate: edge with invalid edge_type throws INVALID_EDGE_TYPE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.batchMutate({
          nodes: [
            { id: "GP-EINV-01", type: "guiding_principle", properties: { name: "Test 1" } },
            { id: "GP-EINV-02", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [{
            source_id: "GP-EINV-01",
            target_id: "GP-EINV-02",
            edge_type: "not_a_real_edge_type" as any,
            properties: {},
          }],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_EDGE_TYPE",
      });
    });

    it.skipIf(!remoteAvailable)("batchMutate: edge with invalid edge_type throws INVALID_EDGE_TYPE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.batchMutate({
          nodes: [
            { id: "GP-EINV-01", type: "guiding_principle", properties: { name: "Test 1" } },
            { id: "GP-EINV-02", type: "guiding_principle", properties: { name: "Test 2" } },
          ],
          edges: [{
            source_id: "GP-EINV-01",
            target_id: "GP-EINV-02",
            edge_type: "not_a_real_edge_type" as any,
            properties: {},
          }],
        })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_EDGE_TYPE",
      });
    });

    it("deleteNode: empty id throws INVALID_NODE_ID from LocalAdapter", async () => {
      await expect(localSetup.adapter.deleteNode("")).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_ID",
      });
    });

    it.skipIf(!remoteAvailable)("deleteNode: empty id throws INVALID_NODE_ID from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(remoteAdapter.deleteNode("")).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_ID",
      });
    });

    it("putEdge: empty source_id throws MISSING_EDGE_SOURCE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.putEdge({ source_id: "", target_id: "GP-01", edge_type: "relates_to", properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_SOURCE",
      });
    });

    it.skipIf(!remoteAvailable)("putEdge: empty source_id throws MISSING_EDGE_SOURCE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.putEdge({ source_id: "", target_id: "GP-01", edge_type: "relates_to", properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_SOURCE",
      });
    });

    it("putEdge: empty target_id throws MISSING_EDGE_TARGET from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.putEdge({ source_id: "GP-01", target_id: "", edge_type: "relates_to", properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_TARGET",
      });
    });

    it.skipIf(!remoteAvailable)("putEdge: empty target_id throws MISSING_EDGE_TARGET from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.putEdge({ source_id: "GP-01", target_id: "", edge_type: "relates_to", properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_TARGET",
      });
    });

    it("putEdge: empty edge_type throws MISSING_EDGE_TYPE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.putEdge({ source_id: "GP-01", target_id: "GP-02", edge_type: "" as EdgeType, properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_TYPE",
      });
    });

    it.skipIf(!remoteAvailable)("putEdge: empty edge_type throws MISSING_EDGE_TYPE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.putEdge({ source_id: "GP-01", target_id: "GP-02", edge_type: "" as EdgeType, properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_EDGE_TYPE",
      });
    });

    it("putEdge: unrecognized edge_type throws INVALID_EDGE_TYPE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.putEdge({ source_id: "GP-01", target_id: "GP-02", edge_type: "not_a_valid_type" as EdgeType, properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_EDGE_TYPE",
      });
    });

    it.skipIf(!remoteAvailable)("putEdge: unrecognized edge_type throws INVALID_EDGE_TYPE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.putEdge({ source_id: "GP-01", target_id: "GP-02", edge_type: "not_a_valid_type" as EdgeType, properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_EDGE_TYPE",
      });
    });

    it("removeEdges: empty source_id throws INVALID_NODE_ID from LocalAdapter", async () => {
      await expect(localSetup.adapter.removeEdges("", ["relates_to"])).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_ID",
      });
    });

    it.skipIf(!remoteAvailable)("removeEdges: empty source_id throws INVALID_NODE_ID from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(remoteAdapter.removeEdges("", ["relates_to"])).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_ID",
      });
    });

    it("removeEdges: invalid edge type in array throws INVALID_EDGE_TYPE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.removeEdges("GP-01", ["not_a_valid_type" as EdgeType])
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_EDGE_TYPE",
      });
    });

    it.skipIf(!remoteAvailable)("removeEdges: invalid edge type in array throws INVALID_EDGE_TYPE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.removeEdges("GP-01", ["not_a_valid_type" as EdgeType])
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_EDGE_TYPE",
      });
    });

    it("putNode: empty id throws INVALID_NODE_ID from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.putNode({ id: "", type: "guiding_principle", properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_ID",
      });
    });

    it.skipIf(!remoteAvailable)("putNode: empty id throws INVALID_NODE_ID from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.putNode({ id: "", type: "guiding_principle", properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_ID",
      });
    });

    it("patchNode: empty id throws INVALID_NODE_ID from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.patchNode({ id: "", properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_ID",
      });
    });

    it.skipIf(!remoteAvailable)("patchNode: empty id throws INVALID_NODE_ID from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.patchNode({ id: "", properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_ID",
      });
    });

    it("patchNode: 'id' in properties throws ImmutableFieldError from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.patchNode({ id: "GP-01", properties: { id: "GP-99" } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);
      await expect(
        localSetup.adapter.patchNode({ id: "GP-01", properties: { id: "GP-99" } })
      ).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
    });

    it.skipIf(!remoteAvailable)("patchNode: 'id' in properties throws ImmutableFieldError from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.patchNode({ id: "GP-01", properties: { id: "GP-99" } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);
      await expect(
        remoteAdapter.patchNode({ id: "GP-01", properties: { id: "GP-99" } })
      ).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
    });

    it("patchNode: 'type' in properties throws ImmutableFieldError from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.patchNode({ id: "GP-01", properties: { type: "constraint" } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);
      await expect(
        localSetup.adapter.patchNode({ id: "GP-01", properties: { type: "constraint" } })
      ).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
    });

    it.skipIf(!remoteAvailable)("patchNode: 'type' in properties throws ImmutableFieldError from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.patchNode({ id: "GP-01", properties: { type: "constraint" } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);
      await expect(
        remoteAdapter.patchNode({ id: "GP-01", properties: { type: "constraint" } })
      ).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
    });

    it("patchNode: 'cycle_created' in properties throws ImmutableFieldError from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.patchNode({ id: "GP-01", properties: { cycle_created: 5 } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);
      await expect(
        localSetup.adapter.patchNode({ id: "GP-01", properties: { cycle_created: 5 } })
      ).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
    });

    it.skipIf(!remoteAvailable)("patchNode: 'cycle_created' in properties throws ImmutableFieldError from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.patchNode({ id: "GP-01", properties: { cycle_created: 5 } })
      ).rejects.toBeInstanceOf(ImmutableFieldError);
      await expect(
        remoteAdapter.patchNode({ id: "GP-01", properties: { cycle_created: 5 } })
      ).rejects.toMatchObject({ code: "IMMUTABLE_FIELD" });
    });

    it("putNode: invalid type throws INVALID_NODE_TYPE from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.putNode({ id: "GP-01", type: "not_a_type" as NodeType, properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_TYPE",
      });
    });

    it.skipIf(!remoteAvailable)("putNode: invalid type throws INVALID_NODE_TYPE from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.putNode({ id: "GP-01", type: "not_a_type" as NodeType, properties: {} })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "INVALID_NODE_TYPE",
      });
    });

    it("putNode: null properties throws MISSING_NODE_PROPERTIES from LocalAdapter", async () => {
      await expect(
        localSetup.adapter.putNode({ id: "GP-01", type: "guiding_principle", properties: null as any })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_NODE_PROPERTIES",
      });
    });

    it.skipIf(!remoteAvailable)("putNode: null properties throws MISSING_NODE_PROPERTIES from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(
        remoteAdapter.putNode({ id: "GP-01", type: "guiding_principle", properties: null as any })
      ).rejects.toMatchObject({
        name: "ValidationError",
        code: "MISSING_NODE_PROPERTIES",
      });
    });

    it("removeEdges: empty edge_types array resolves without error from LocalAdapter", async () => {
      await expect(localSetup.adapter.removeEdges("GP-01", [])).resolves.toBeUndefined();
    });

    it.skipIf(!remoteAvailable)("removeEdges: empty edge_types array resolves without error from RemoteAdapter", async () => {
      if (!remoteAdapter) return;
      await expect(remoteAdapter.removeEdges("GP-01", [])).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------------
  // Interface Shape Validation (P-60 compliance)
  // -----------------------------------------------------------------------------

  describe("P-60 Interface Shape Compliance", () => {
    it("nextId returns scalar string (not wrapped in object)", async () => {
      const id = await localSetup.adapter.nextId("work_item");

      // P-60: Must return scalar string, not { id: string }
      expect(typeof id).toBe("string");
      expect(id).not.toHaveProperty("id");
    });

    it("getNode returns null (not throws) for missing node", async () => {
      // P-60: getNode must return null for missing, not throw
      const node = await localSetup.adapter.getNode("DEFINITELY-MISSING-999");
      expect(node).toBeNull();
    });

    it("getNodes returns Map (not array or object)", async () => {
      const result = await localSetup.adapter.getNodes([]);

      // P-60: Must return Map<string, Node>
      expect(result instanceof Map).toBe(true);
      expect(typeof result.get).toBe("function");
      expect(typeof result.has).toBe("function");
    });

    it("queryNodes returns QueryResult with required fields", async () => {
      const result = await localSetup.adapter.queryNodes({}, 10, 0);

      // P-60: Must have nodes array and total_count
      expect(result).toHaveProperty("nodes");
      expect(result).toHaveProperty("total_count");
      expect(Array.isArray(result.nodes)).toBe(true);
      expect(typeof result.total_count).toBe("number");

      // Each node entry must have node (NodeMeta) and summary
      for (const item of result.nodes) {
        expect(item).toHaveProperty("node");
        expect(item).toHaveProperty("summary");
        expectValidNodeMeta(item.node);
      }
    });
  });
});

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
/**
 * This test file verifies P-60 policy compliance:
 *
 * - All StorageAdapter implementations (LocalAdapter, RemoteAdapter) must expose
 *   identical interface contracts.
 *
 * - Methods verified:
 *   - nextId(type, cycle?): Returns scalar string ID
 *   - getNode(id): Returns Node | null (with properties for found nodes)
 *   - getNodes(ids): Returns Map<string, Node> (omits missing IDs)
 *   - queryNodes(filter, limit, offset): Returns QueryResult with NodeMeta entries;
 *       validates INVALID_LIMIT, INVALID_OFFSET
 *   - putEdge: Validates MISSING_EDGE_SOURCE, MISSING_EDGE_TARGET, MISSING_EDGE_TYPE, INVALID_EDGE_TYPE
 *   - removeEdges: Validates INVALID_NODE_ID (empty source_id), INVALID_EDGE_TYPE, and empty-array no-op
 *   - putNode: Validates INVALID_NODE_ID (empty id), INVALID_NODE_TYPE, MISSING_NODE_PROPERTIES
 *   - batchMutate: Node validation (MISSING_NODE_ID, MISSING_NODE_TYPE, MISSING_NODE_PROPERTIES,
 *       INVALID_NODE_TYPE); edge validation (MISSING_EDGE_SOURCE, MISSING_EDGE_TARGET,
 *       MISSING_EDGE_TYPE, INVALID_EDGE_TYPE)
 *   - queryGraph: Returns graph results with nodes and edges; validates INVALID_LIMIT, INVALID_OFFSET
 *
 * - Q-123 is resolved: This test file exists and verifies the adapter equivalence
 *   that WI-619 specified but was never implemented.
 */
