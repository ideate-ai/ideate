/**
 * equivalence-null.test.ts — Null handling and edge-case consistency tests.
 *
 * Validates that LocalAdapter and RemoteAdapter handle null values consistently
 * across:
 *   - Nullable metadata fields (cycle_created, cycle_modified, status)
 *   - Nullable extension table fields (resolution, title, source, completed_date)
 *   - Numeric zero vs null for cycle_created
 *   - Absent optional fields vs explicit null
 *   - T-13: ?? '' coercion pattern in the SQLite indexer
 *
 * T-13 summary (from triage report):
 *   The SQLite indexer uses ?? '' in buildExtensionRow for several fields that
 *   are logically optional but are stored as NOT NULL in the schema:
 *     - work_items.title      (toStrOrNull(doc.title) ?? "")
 *     - metrics_events.event_name (toStrOrNull(doc.event_name) ?? toStrOrNull(doc.agent_type) ?? "")
 *   The writer (putNode path) mirrors this behaviour, so for putNode-created
 *   nodes the coercions are symmetric. Divergences arise only from fixture YAML
 *   loaded through the indexer when the Neo4j migration CLI stores null as-is.
 *
 * Prerequisites: Docker Compose test stack must be running:
 *   docker compose -f docker-compose.test.yml up -d
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createDualAdapters,
  isTestServerAvailable,
  assertNodesEquivalent,
  type DualAdapters,
} from "./equivalence-helpers.js";
import type { MutateNodeInput, NodeType } from "../adapter.js";

// ---------------------------------------------------------------------------
// Server availability guard
// ---------------------------------------------------------------------------

const serverAvailable = isTestServerAvailable();
const suite = serverAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Suite 1: Null metadata fields — read from fixture data
// ---------------------------------------------------------------------------

suite("Equivalence — Null metadata fields (fixture data)", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  // AC1: cycle_created=null and cycle_modified=null (WI-003)
  //
  // WI-003 fixture has cycle_created: null, cycle_modified: null.
  // Both adapters must return null (not 0, not undefined) for these fields.

  it("WI-003 cycle_created is null from both adapters (not 0, not undefined)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-003"),
      adapters.remote.getNode("WI-003"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.cycle_created).toBeNull();
    expect(remoteNode!.cycle_created).toBeNull();
  });

  it("WI-003 cycle_modified is null from both adapters (not 0, not undefined)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-003"),
      adapters.remote.getNode("WI-003"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.cycle_modified).toBeNull();
    expect(remoteNode!.cycle_modified).toBeNull();
  });

  // AC1: status from WI-003 is non-null (sanity: status handling)
  it("WI-003 status is 'done' from both adapters", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-003"),
      adapters.remote.getNode("WI-003"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.status).toBe("done");
    expect(remoteNode!.status).toBe("done");
  });

  // GP-02 has cycle_modified=null — verify across both adapters
  it("GP-02 cycle_modified is null from both adapters", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("GP-02"),
      adapters.remote.getNode("GP-02"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.cycle_modified).toBeNull();
    expect(remoteNode!.cycle_modified).toBeNull();
  });

  // AC3 (non-null baseline): WI-001 has cycle_created=1, cycle_modified=2
  it("WI-001 cycle_created is 1 and cycle_modified is 2 from both adapters", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-001"),
      adapters.remote.getNode("WI-001"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.cycle_created).toBe(1);
    expect(remoteNode!.cycle_created).toBe(1);

    expect(localNode!.cycle_modified).toBe(2);
    expect(remoteNode!.cycle_modified).toBe(2);
  });

  // WI-002: cycle_created=1, cycle_modified=null (mixed null/non-null)
  it("WI-002 cycle_created is 1 and cycle_modified is null from both adapters", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-002"),
      adapters.remote.getNode("WI-002"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.cycle_created).toBe(1);
    expect(remoteNode!.cycle_created).toBe(1);

    expect(localNode!.cycle_modified).toBeNull();
    expect(remoteNode!.cycle_modified).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Null extension table fields — read from fixture data
// ---------------------------------------------------------------------------

suite("Equivalence — Null extension table fields (fixture data)", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  // AC2 / AC4: WI-003 resolution is null
  it("WI-003 properties.resolution is null from both adapters (not empty string)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-003"),
      adapters.remote.getNode("WI-003"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.properties.resolution).toBeNull();
    expect(remoteNode!.properties.resolution).toBeNull();
  });

  // AC2 / AC4: WI-002 resolution is null
  it("WI-002 properties.resolution is null from both adapters (not empty string)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-002"),
      adapters.remote.getNode("WI-002"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.properties.resolution).toBeNull();
    expect(remoteNode!.properties.resolution).toBeNull();
  });

  // AC4: D-02 properties.title is null and properties.source is null
  it("D-02 properties.title is null from both adapters (not empty string)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("D-02"),
      adapters.remote.getNode("D-02"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.properties.title).toBeNull();
    expect(remoteNode!.properties.title).toBeNull();
  });

  it("D-02 properties.source is null from both adapters (not empty string)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("D-02"),
      adapters.remote.getNode("D-02"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.properties.source).toBeNull();
    expect(remoteNode!.properties.source).toBeNull();
  });

  // AC4: PH-002 completed_date is null
  it("PH-002 properties.completed_date is null from both adapters", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("PH-002"),
      adapters.remote.getNode("PH-002"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.properties.completed_date).toBeNull();
    expect(remoteNode!.properties.completed_date).toBeNull();
  });

  // Non-null baseline: PH-001 completed_date is non-null
  it("PH-001 properties.completed_date is non-null from both adapters (baseline)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("PH-001"),
      adapters.remote.getNode("PH-001"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.properties.completed_date).not.toBeNull();
    expect(remoteNode!.properties.completed_date).not.toBeNull();
    expect(localNode!.properties.completed_date).toBe(remoteNode!.properties.completed_date);
  });

  // Non-null baseline: D-01 title and source are non-null
  it("D-01 properties.title and properties.source are non-null from both adapters (baseline)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("D-01"),
      adapters.remote.getNode("D-01"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.properties.title).not.toBeNull();
    expect(remoteNode!.properties.title).not.toBeNull();
    expect(localNode!.properties.title).toBe(remoteNode!.properties.title);

    expect(localNode!.properties.source).not.toBeNull();
    expect(remoteNode!.properties.source).not.toBeNull();
    expect(localNode!.properties.source).toBe(remoteNode!.properties.source);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Numeric zero vs null, and absent vs null — putNode round-trips
// ---------------------------------------------------------------------------

suite("Equivalence — Zero vs null, absent vs null (putNode round-trips)", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  // AC3: cycle_created=0 is stored as 0, not coerced to null
  //
  // putNode (create path) accepts cycle_created in properties; patchNode rejects it
  // as immutable. The LocalAdapter stores cycle_created from content.cycle_created
  // directly. Passing 0 must round-trip as 0 from both adapters, proving that
  // falsy-but-non-null zero is not silently promoted to null.
  it("putNode with cycle_created=0 returns cycle_created=0 (not null) from both adapters", async () => {
    const id = "WI-EQ-NULL-ZERO-001";
    const input: MutateNodeInput = {
      id,
      type: "work_item" as NodeType,
      properties: {
        title: "Zero cycle_created test",
        status: "pending",
        cycle_created: 0,
      },
    };

    await Promise.all([
      adapters.local.putNode(input),
      adapters.remote.putNode(input),
    ]);

    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode(id),
      adapters.remote.getNode(id),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    // cycle_created=0 must round-trip as 0, not null
    expect(localNode!.cycle_created).toBe(0);
    expect(remoteNode!.cycle_created).toBe(0);

    // Both adapters must agree
    expect(localNode!.cycle_created).toBe(remoteNode!.cycle_created);
  });

  // AC2: Absent optional field (no status) — both adapters treat it identically
  //
  // When putNode is called without a status field, the LocalAdapter stores null
  // for status (no coercion). Verify both adapters return the same value (null
  // or undefined — whichever it is, both must agree).
  it("putNode without status field: both adapters return the same status value", async () => {
    const id = "WI-EQ-NULL-NOSTATUS-001";
    const input: MutateNodeInput = {
      id,
      type: "work_item" as NodeType,
      properties: {
        title: "No status field test",
        // status is intentionally absent
      },
    };

    await Promise.all([
      adapters.local.putNode(input),
      adapters.remote.putNode(input),
    ]);

    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode(id),
      adapters.remote.getNode(id),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    // Both adapters must agree: absent status should be null (the column is nullable).
    const localStatus = localNode!.status ?? null;
    const remoteStatus = remoteNode!.status ?? null;
    expect(localStatus).toBeNull();
    expect(localStatus).toBe(remoteStatus);
  });

  // AC2: Explicit null status — both adapters return null
  it("putNode with explicit null status: both adapters return null status", async () => {
    const id = "WI-EQ-NULL-NULLSTATUS-001";
    const input: MutateNodeInput = {
      id,
      type: "work_item" as NodeType,
      properties: {
        title: "Explicit null status test",
        status: null,
      },
    };

    await Promise.all([
      adapters.local.putNode(input),
      adapters.remote.putNode(input),
    ]);

    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode(id),
      adapters.remote.getNode(id),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    // Explicit null must not be coerced to a default string
    const localStatus = localNode!.status ?? null;
    const remoteStatus = remoteNode!.status ?? null;
    expect(localStatus).toBeNull();
    expect(remoteStatus).toBeNull();
  });

  // AC3: null cycle_created remains null through putNode round-trip
  it("putNode with cycle_created=null returns null from both adapters", async () => {
    const id = "WI-EQ-NULL-NULLCC-001";
    const input: MutateNodeInput = {
      id,
      type: "work_item" as NodeType,
      properties: {
        title: "Null cycle_created test",
        status: "pending",
        cycle_created: null,
      },
    };

    await Promise.all([
      adapters.local.putNode(input),
      adapters.remote.putNode(input),
    ]);

    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode(id),
      adapters.remote.getNode(id),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.cycle_created).toBeNull();
    expect(remoteNode!.cycle_created).toBeNull();
  });

  // AC4: null resolution in extension table round-trips as null via putNode
  it("putNode with resolution=null: both adapters return null properties.resolution", async () => {
    const id = "WI-EQ-NULL-RESNULL-001";
    const input: MutateNodeInput = {
      id,
      type: "work_item" as NodeType,
      properties: {
        title: "Null resolution test",
        status: "pending",
        resolution: null,
      },
    };

    await Promise.all([
      adapters.local.putNode(input),
      adapters.remote.putNode(input),
    ]);

    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode(id),
      adapters.remote.getNode(id),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(localNode!.properties.resolution).toBeNull();
    expect(remoteNode!.properties.resolution).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 4: T-13 coercion check — document known divergences
// ---------------------------------------------------------------------------

suite("Equivalence — T-13 null-to-default coercion (indexer ?? '' pattern)", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  // -------------------------------------------------------------------------
  // T-13 context:
  //
  // The SQLite indexer (buildExtensionRow in indexer.ts) uses ?? '' for fields
  // that are NOT NULL in the SQLite schema but logically optional in YAML:
  //
  //   work_items.title:      toStrOrNull(doc.title) ?? ""
  //   metrics_events.event_name:
  //     toStrOrNull(doc.event_name) ?? toStrOrNull(doc.agent_type) ?? ""
  //
  // The Neo4j migration CLI stores YAML values as-is (null → null).
  //
  // For fixture artifacts loaded via the indexer (not via putNode), a YAML
  // field that is null may produce "" in SQLite but null in Neo4j.
  //
  // The putNode writer mirrors the same coercions for most fields, so putNode
  // round-trips are symmetric.
  //
  // The tests below check each known ?? '' field against fixture data and
  // document any accepted divergence.
  // -------------------------------------------------------------------------

  // AC5 / AC6: work_items.title coercion via indexer
  //
  // No fixture work_item has a null title; all fixtures use non-null titles.
  // WI-001, WI-002, WI-003 all have explicit string titles.
  // Therefore this field cannot produce a T-13 divergence from fixture data.
  // This test confirms the non-null path is consistent as a baseline.
  it("WI-001 properties.title is a non-empty string from both adapters (T-13 baseline: title is not null in fixture)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-001"),
      adapters.remote.getNode("WI-001"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    expect(typeof localNode!.properties.title).toBe("string");
    expect((localNode!.properties.title as string).length).toBeGreaterThan(0);
    expect(localNode!.properties.title).toBe(remoteNode!.properties.title);
  });

  // AC5 / AC6: metrics_events.event_name coercion via indexer
  //
  // ME-002 has event_name: null and agent_type: "reviewer".
  // The SQLite indexer applies:
  //   toStrOrNull(doc.event_name) ?? toStrOrNull(doc.agent_type) ?? ""
  // → null ?? "reviewer" ?? "" = "reviewer"
  //
  // The Neo4j migration CLI stores event_name as null (the raw YAML value),
  // not the fallback. This is a KNOWN DIVERGENCE (T-13).
  //
  // KNOWN DIVERGENCE (T-13): SQLite indexer coerces null event_name to the
  // agent_type fallback ("reviewer") via the ?? chain in buildExtensionRow.
  // Neo4j stores null as-is. The LocalAdapter returns "reviewer" while the
  // RemoteAdapter returns null. Accepted until the indexer is fixed to store
  // null when event_name is explicitly null in the YAML.
  it("ME-002 properties.event_name: documents T-13 divergence between SQLite and Neo4j", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("ME-002"),
      adapters.remote.getNode("ME-002"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    // KNOWN DIVERGENCE (T-13): SQLite indexer coerces null event_name to
    // agent_type ("reviewer") via ?? chain. Neo4j stores null as-is.
    // LocalAdapter returns "reviewer"; RemoteAdapter returns null.
    // This divergence is accepted until the indexer ?? '' chain is fixed.
    const localEventName = localNode!.properties.event_name;
    const remoteEventName = remoteNode!.properties.event_name;

    if (localEventName === remoteEventName) {
      // If the backends converge (e.g. after a fix), the test still passes.
      // Document the convergence.
      expect(localEventName).toBe(remoteEventName);
    } else {
      // Document the known divergence explicitly.
      // SQLite: "reviewer" (agent_type fallback via ?? chain)
      // Neo4j:  null (raw YAML value)
      expect(localEventName).toBe("reviewer");
      expect(remoteEventName).toBeNull();
    }
  });

  // ME-001 has event_name: "work_item_complete" (non-null) — no divergence expected
  it("ME-001 properties.event_name is identical from both adapters (non-null, no T-13 issue)", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("ME-001"),
      adapters.remote.getNode("ME-001"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    // Non-null event_name: no ?? fallback fires, both adapters agree.
    expect(localNode!.properties.event_name).not.toBeNull();
    expect(localNode!.properties.event_name).toBe(remoteNode!.properties.event_name);
  });

  // AC5 / AC6: putNode event_name=null via writer path
  //
  // The writer (upsertExtensionTableRow for metrics_event) uses:
  //   event_name: typeof content.agent_type === "string"
  //     ? content.agent_type
  //     : (content.event_name as string) ?? ""
  //
  // When putNode is called with event_name=null and no agent_type, both adapters
  // store "" (SQLite schema requires NOT NULL, writer falls back to "").
  // The RemoteAdapter mirrors the writer behaviour for putNode inputs.
  // This test confirms the putNode path is symmetric (no T-13 divergence).
  it("putNode with event_name=null and no agent_type: both adapters agree on the stored value", async () => {
    const id = "ME-EQ-NULL-EN-001";
    const input: MutateNodeInput = {
      id,
      type: "metrics_event" as NodeType,
      properties: {
        event_name: null,
        timestamp: "2026-04-01T00:00:00Z",
        // agent_type is intentionally absent
      },
    };

    await Promise.all([
      adapters.local.putNode(input),
      adapters.remote.putNode(input),
    ]);

    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode(id),
      adapters.remote.getNode(id),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    // Both adapters must agree; coercion (if any) is symmetric for putNode.
    const localEN = localNode!.properties.event_name ?? null;
    const remoteEN = remoteNode!.properties.event_name ?? null;
    expect(localEN).toBe(remoteEN);
  });

  // AC5 / AC6: putNode with null domain_decision title via writer path
  //
  // The writer builds a DomainDecisionRow without explicit title/source fields,
  // so their SQLite-stored value depends on what the ORM does with absent fields
  // (undefined → NULL for nullable columns). Both adapters must agree on whatever
  // value is stored. The fixture D-02 (loaded via indexer) is already tested in
  // Suite 2 for the null-from-indexer path.
  it("putNode with domain_decision title=null and source=null: both adapters return the same values", async () => {
    const id = "D-EQ-NULL-TITLE-01";
    const input: MutateNodeInput = {
      id,
      type: "domain_decision" as NodeType,
      properties: {
        domain: "artifact-structure",
        status: "open",
        cycle: 1,
        title: null,
        source: null,
        description: "Test decision with null title and source",
      },
    };

    await Promise.all([
      adapters.local.putNode(input),
      adapters.remote.putNode(input),
    ]);

    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode(id),
      adapters.remote.getNode(id),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    // Both adapters must agree on the stored values.
    // null title/source must not be coerced to non-null by either adapter.
    const localTitle = localNode!.properties.title ?? null;
    const remoteTitle = remoteNode!.properties.title ?? null;
    expect(localTitle).toBeNull();
    expect(remoteTitle).toBeNull();

    const localSource = localNode!.properties.source ?? null;
    const remoteSource = remoteNode!.properties.source ?? null;
    expect(localSource).toBeNull();
    expect(remoteSource).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Full node equivalence for null-heavy fixture artifacts
// ---------------------------------------------------------------------------

suite("Equivalence — Full node equivalence for null-heavy fixtures", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  // Full assertNodesEquivalent comparison for fixtures that have multiple null fields.
  // These verify that assertNodesEquivalent passes despite all the null values.
  // ME-002 is excluded from assertNodesEquivalent because of the known T-13
  // divergence in event_name.

  it("WI-003 (null cycle fields, null resolution) passes assertNodesEquivalent", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-003"),
      adapters.remote.getNode("WI-003"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    assertNodesEquivalent(localNode!, remoteNode!);
  });

  it("D-02 (null title, null source) passes assertNodesEquivalent", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("D-02"),
      adapters.remote.getNode("D-02"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    assertNodesEquivalent(localNode!, remoteNode!);
  });

  it("PH-002 (null completed_date) passes assertNodesEquivalent", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("PH-002"),
      adapters.remote.getNode("PH-002"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    assertNodesEquivalent(localNode!, remoteNode!);
  });

  it("GP-02 (null cycle_modified) passes assertNodesEquivalent", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("GP-02"),
      adapters.remote.getNode("GP-02"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    assertNodesEquivalent(localNode!, remoteNode!);
  });

  it("WI-002 (null cycle_modified, null resolution) passes assertNodesEquivalent", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("WI-002"),
      adapters.remote.getNode("WI-002"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    assertNodesEquivalent(localNode!, remoteNode!);
  });

  // ME-002: full node comparison is skipped for the event_name field due to T-13.
  // Instead we verify all other fields are equivalent by comparing selectively.
  //
  // KNOWN DIVERGENCE (T-13): ME-002.properties.event_name is excluded from the
  // full node comparison. SQLite returns "reviewer" (agent_type fallback);
  // Neo4j returns null (raw YAML value). All other ME-002 fields must match.
  it("ME-002 (null event_name — T-13): all fields except event_name are equivalent between adapters", async () => {
    const [localNode, remoteNode] = await Promise.all([
      adapters.local.getNode("ME-002"),
      adapters.remote.getNode("ME-002"),
    ]);

    expect(localNode).not.toBeNull();
    expect(remoteNode).not.toBeNull();

    // Compare metadata fields individually (excluding content_hash and token_count)
    expect(localNode!.id).toBe(remoteNode!.id);
    expect(localNode!.type).toBe(remoteNode!.type);
    expect(localNode!.status).toBe(remoteNode!.status);
    expect(localNode!.cycle_created).toBe(remoteNode!.cycle_created);
    expect(localNode!.cycle_modified).toBe(remoteNode!.cycle_modified);

    // Compare extension properties, excluding the divergent event_name field.
    // KNOWN DIVERGENCE (T-13): event_name excluded — SQLite returns "reviewer"
    // (agent_type fallback via ?? chain); Neo4j returns null. Accepted until
    // the indexer ?? '' chain is fixed.
    const { event_name: _localEN, ...localProps } = localNode!.properties as Record<string, unknown>;
    const { event_name: _remoteEN, ...remoteProps } = remoteNode!.properties as Record<string, unknown>;
    expect(localProps).toEqual(remoteProps);
  });
});
