/**
 * equivalence-query.test.ts — Equivalence tests for query and aggregation
 * operations across LocalAdapter and RemoteAdapter.
 *
 * Verifies that queryNodes, queryGraph, countNodes, getDomainState, and
 * getConvergenceData return identical results from both adapters when given
 * the canonical equivalence fixture as input.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run with:
 *   npm run test:equivalence
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createDualAdapters,
  isTestServerAvailable,
  assertQueryResultEquivalent,
  type DualAdapters,
} from "./equivalence-helpers.js";
import type { NodeType, NodeFilter } from "../adapter.js";

/** Sort countNodes results by key for stable comparison. */
const sortByKey = (arr: Array<{ key: string; count: number }>) =>
  [...arr].sort((a, b) => a.key.localeCompare(b.key));

// ---------------------------------------------------------------------------
// Server availability guard — skip the entire suite if Docker is not running
// ---------------------------------------------------------------------------

const serverAvailable = isTestServerAvailable();
const suite = serverAvailable ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

suite("Equivalence — query and aggregation operations", () => {
  let adapters: DualAdapters;

  beforeAll(async () => {
    adapters = await createDualAdapters();
  }, 120_000);

  afterAll(async () => {
    if (adapters) await adapters.cleanup();
  });

  // -------------------------------------------------------------------------
  // queryNodes — type filter (one test per NodeType present in fixture)
  // -------------------------------------------------------------------------

  describe("queryNodes — type filter", () => {
    const nodeTypes: NodeType[] = [
      "work_item",
      "guiding_principle",
      "constraint",
      "domain_policy",
      "domain_decision",
      "domain_question",
      "module_spec",
      "project",
      "phase",
      "finding",
      "journal_entry",
      "metrics_event",
      "research_finding",
    ];

    for (const type of nodeTypes) {
      it(`returns identical results for type=${type}`, async () => {
        const filter: NodeFilter = { type };
        const [local, remote] = await Promise.all([
          adapters.local.queryNodes(filter, 50, 0),
          adapters.remote.queryNodes(filter, 50, 0),
        ]);
        assertQueryResultEquivalent(local, remote);
      });
    }
  });

  // -------------------------------------------------------------------------
  // queryNodes — status filter
  // -------------------------------------------------------------------------

  describe("queryNodes — status filter", () => {
    const statuses = [
      "done",
      "pending",
      "active",
      "settled",
      "open",
      "resolved",
      "complete",
    ];

    for (const status of statuses) {
      it(`returns identical results for status=${status}`, async () => {
        const filter: NodeFilter = { status };
        const [local, remote] = await Promise.all([
          adapters.local.queryNodes(filter, 50, 0),
          adapters.remote.queryNodes(filter, 50, 0),
        ]);
        assertQueryResultEquivalent(local, remote);
      });
    }
  });

  // -------------------------------------------------------------------------
  // queryNodes — domain filter
  // -------------------------------------------------------------------------

  describe("queryNodes — domain filter", () => {
    it("returns identical results for domain=artifact-structure", async () => {
      const filter: NodeFilter = { domain: "artifact-structure" };
      const [local, remote] = await Promise.all([
        adapters.local.queryNodes(filter, 50, 0),
        adapters.remote.queryNodes(filter, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });
  });

  // -------------------------------------------------------------------------
  // queryNodes — phase filter
  // -------------------------------------------------------------------------

  describe("queryNodes — phase filter", () => {
    it("returns identical results for phase=PH-001", async () => {
      const filter: NodeFilter = { phase: "PH-001" };
      const [local, remote] = await Promise.all([
        adapters.local.queryNodes(filter, 50, 0),
        adapters.remote.queryNodes(filter, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });
  });

  // -------------------------------------------------------------------------
  // queryNodes — combined filters (type + status)
  // -------------------------------------------------------------------------

  describe("queryNodes — combined filters", () => {
    it("returns identical results for type=work_item + status=done", async () => {
      const filter: NodeFilter = { type: "work_item", status: "done" };
      const [local, remote] = await Promise.all([
        adapters.local.queryNodes(filter, 50, 0),
        adapters.remote.queryNodes(filter, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });

    it("returns identical results for type=work_item + status=pending", async () => {
      const filter: NodeFilter = { type: "work_item", status: "pending" };
      const [local, remote] = await Promise.all([
        adapters.local.queryNodes(filter, 50, 0),
        adapters.remote.queryNodes(filter, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });

    it("returns identical results for type=domain_decision + status=settled", async () => {
      const filter: NodeFilter = { type: "domain_decision", status: "settled" };
      const [local, remote] = await Promise.all([
        adapters.local.queryNodes(filter, 50, 0),
        adapters.remote.queryNodes(filter, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });

    it("returns identical results for type=work_item + domain=artifact-structure", async () => {
      const filter: NodeFilter = { type: "work_item", domain: "artifact-structure" };
      const [local, remote] = await Promise.all([
        adapters.local.queryNodes(filter, 50, 0),
        adapters.remote.queryNodes(filter, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });
  });

  // -------------------------------------------------------------------------
  // queryGraph — 1-hop outgoing from WI-001
  // -------------------------------------------------------------------------

  describe("queryGraph — 1-hop outgoing", () => {
    it("returns identical results from WI-001 (depth=1, direction=outgoing)", async () => {
      const query = {
        origin_id: "WI-001",
        depth: 1,
        direction: "outgoing" as const,
      };
      const [local, remote] = await Promise.all([
        adapters.local.queryGraph(query, 50, 0),
        adapters.remote.queryGraph(query, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });

    it("returns identical results from PH-001 (depth=1, direction=outgoing)", async () => {
      const query = {
        origin_id: "PH-001",
        depth: 1,
        direction: "outgoing" as const,
      };
      const [local, remote] = await Promise.all([
        adapters.local.queryGraph(query, 50, 0),
        adapters.remote.queryGraph(query, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });
  });

  // -------------------------------------------------------------------------
  // queryGraph — 2-hop both directions from GP-01
  // -------------------------------------------------------------------------

  describe("queryGraph — 2-hop both directions", () => {
    it("returns identical results from GP-01 (depth=2, direction=both)", async () => {
      const query = {
        origin_id: "GP-01",
        depth: 2,
        direction: "both" as const,
      };
      const [local, remote] = await Promise.all([
        adapters.local.queryGraph(query, 50, 0),
        adapters.remote.queryGraph(query, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });

    it("returns identical results from WI-001 (depth=2, direction=both)", async () => {
      const query = {
        origin_id: "WI-001",
        depth: 2,
        direction: "both" as const,
      };
      const [local, remote] = await Promise.all([
        adapters.local.queryGraph(query, 50, 0),
        adapters.remote.queryGraph(query, 50, 0),
      ]);
      assertQueryResultEquivalent(local, remote);
    });
  });

  // -------------------------------------------------------------------------
  // countNodes — grouped by status
  // -------------------------------------------------------------------------

  describe("countNodes — grouped by status", () => {
    it("returns identical counts grouped by status (no filter)", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.countNodes({}, "status"),
        adapters.remote.countNodes({}, "status"),
      ]);
expect(sortByKey(local)).toEqual(sortByKey(remote));
    });

    it("returns identical counts grouped by status for type=work_item", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.countNodes({ type: "work_item" }, "status"),
        adapters.remote.countNodes({ type: "work_item" }, "status"),
      ]);
expect(sortByKey(local)).toEqual(sortByKey(remote));
    });
  });

  // -------------------------------------------------------------------------
  // countNodes — grouped by type
  // -------------------------------------------------------------------------

  describe("countNodes — grouped by type", () => {
    it("returns identical counts grouped by type (no filter)", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.countNodes({}, "type"),
        adapters.remote.countNodes({}, "type"),
      ]);
expect(sortByKey(local)).toEqual(sortByKey(remote));
    });
  });

  // -------------------------------------------------------------------------
  // countNodes — grouped by domain
  // -------------------------------------------------------------------------

  describe("countNodes — grouped by domain", () => {
    it("returns identical counts grouped by domain (no filter)", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.countNodes({}, "domain"),
        adapters.remote.countNodes({}, "domain"),
      ]);
expect(sortByKey(local)).toEqual(sortByKey(remote));
    });

    it("returns identical counts grouped by domain for type=work_item", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.countNodes({ type: "work_item" }, "domain"),
        adapters.remote.countNodes({ type: "work_item" }, "domain"),
      ]);
expect(sortByKey(local)).toEqual(sortByKey(remote));
    });
  });

  // -------------------------------------------------------------------------
  // getDomainState — policies, decisions, questions per domain
  // -------------------------------------------------------------------------

  describe("getDomainState", () => {
    it("returns identical policy/decision/question sets for all domains", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.getDomainState(),
        adapters.remote.getDomainState(),
      ]);

      // Compare domain key sets
      const localDomains = [...local.keys()].sort();
      const remoteDomains = [...remote.keys()].sort();
      expect(localDomains).toEqual(remoteDomains);

      // Compare each domain's content
      for (const domain of localDomains) {
        const localDomain = local.get(domain)!;
        const remoteDomain = remote.get(domain)!;

        const sortById = (arr: Array<{ id: string; description: string | null; status: string | null }>) =>
          [...arr].sort((a, b) => a.id.localeCompare(b.id));

        expect(sortById(localDomain.policies)).toEqual(sortById(remoteDomain.policies));
        expect(sortById(localDomain.decisions)).toEqual(sortById(remoteDomain.decisions));
        expect(sortById(localDomain.questions)).toEqual(sortById(remoteDomain.questions));
      }
    });

    it("returns identical results when filtering to domain=artifact-structure", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.getDomainState(["artifact-structure"]),
        adapters.remote.getDomainState(["artifact-structure"]),
      ]);

      const localDomain = local.get("artifact-structure");
      const remoteDomain = remote.get("artifact-structure");

      expect(localDomain).toBeDefined();
      expect(remoteDomain).toBeDefined();

      const sortById = (arr: Array<{ id: string; description: string | null; status: string | null }>) =>
        [...arr].sort((a, b) => a.id.localeCompare(b.id));

      expect(sortById(localDomain!.policies)).toEqual(sortById(remoteDomain!.policies));
      expect(sortById(localDomain!.decisions)).toEqual(sortById(remoteDomain!.decisions));
      expect(sortById(localDomain!.questions)).toEqual(sortById(remoteDomain!.questions));
    });
  });

  // -------------------------------------------------------------------------
  // getConvergenceData — finding counts and summary content for cycle 1
  // -------------------------------------------------------------------------

  describe("getConvergenceData", () => {
    it("returns identical finding counts for cycle 1", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.getConvergenceData(1),
        adapters.remote.getConvergenceData(1),
      ]);

      // Finding counts by severity must match exactly
      expect(local.findings_by_severity).toEqual(remote.findings_by_severity);
    });

    it("returns identical cycle summary content for cycle 1", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.getConvergenceData(1),
        adapters.remote.getConvergenceData(1),
      ]);

      // Both backends should agree on whether cycle summary content exists
      expect(typeof local.cycle_summary_content).toBe(
        typeof remote.cycle_summary_content
      );
      // If both have content, it must be identical
      if (
        local.cycle_summary_content !== null &&
        remote.cycle_summary_content !== null
      ) {
        expect(local.cycle_summary_content).toBe(remote.cycle_summary_content);
      }
    });

    it("fixture has at least one finding in cycle 1 with known severity", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.getConvergenceData(1),
        adapters.remote.getConvergenceData(1),
      ]);

      // F-WI-001-001 has severity=significant — at least one finding must appear
      const localTotal = Object.values(local.findings_by_severity).reduce(
        (sum, n) => sum + n,
        0
      );
      const remoteTotal = Object.values(remote.findings_by_severity).reduce(
        (sum, n) => sum + n,
        0
      );
      expect(localTotal).toBeGreaterThanOrEqual(1);
      expect(remoteTotal).toBeGreaterThanOrEqual(1);
      expect(localTotal).toBe(remoteTotal);
    });
  });
});
