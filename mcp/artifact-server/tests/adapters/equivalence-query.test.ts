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
import type { NodeType, NodeFilter } from "../../src/adapter.js";

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
  // countNodes — grouped by severity, excluding resolved findings (WI-871)
  // -------------------------------------------------------------------------

  describe("countNodes — grouped by severity — excludes resolved findings", () => {
    it("returns identical counts grouped by severity for type=finding", async () => {
      // Fixture cycle 002 contains three findings of severity=significant:
      //   F-WI-001-002: addressed_by=null   → counted by both adapters
      //   F-WI-001-003: addressed_by=WI-001 → excluded by both adapters (resolved)
      //   F-WI-001-004: addressed_by=""     → excluded by both adapters (empty string)
      //
      // LocalAdapter uses SQL: WHERE e.addressed_by IS NULL
      // RemoteAdapter uses client-side post-filter: skip when addressed_by !== null && !== undefined
      // Both must produce the same count (equivalence).
      const [local, remote] = await Promise.all([
        adapters.local.countNodes({ type: "finding" }, "severity"),
        adapters.remote.countNodes({ type: "finding" }, "severity"),
      ]);

      // (a) Both adapters return identical counts
      expect(sortByKey(local)).toEqual(sortByKey(remote));

      // (b) Only the null-addressed_by finding (F-WI-001-002) is counted.
      //     severity=significant count must be exactly 1.
      const localSignificant = local.find((r) => r.key === "significant");
      const remoteSignificant = remote.find((r) => r.key === "significant");
      expect(localSignificant?.count).toBe(1);
      expect(remoteSignificant?.count).toBe(1);
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
  // getConvergenceData — empty-string addressed_by parity (cycle 2, WI-873)
  // -------------------------------------------------------------------------

  describe("getConvergenceData — empty-string addressed_by parity (cycle 2)", () => {
    // Cycle 2 contains three findings of severity=significant:
    //   F-WI-001-002: addressed_by=null    → MUST be counted by both adapters
    //   F-WI-001-003: addressed_by=WI-001  → resolved, MUST be excluded
    //   F-WI-001-004: addressed_by=""      → resolved (empty string), MUST be excluded
    //
    // This test codifies the parity requirement for the empty-string edge case:
    // LocalAdapter excludes via SQL `addressed_by IS NULL` (empty string is IS NULL=FALSE).
    // RemoteAdapter excludes via 2-clause JS filter `!== null && !== undefined` (empty
    // string passes both, so continue executes — same exclusion result).

    it("(a) findings_by_severity is identical between local and remote for cycle 2", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.getConvergenceData(2),
        adapters.remote.getConvergenceData(2),
      ]);

      expect(local.findings_by_severity).toEqual(remote.findings_by_severity);
    });

    it("(b) only the null addressed_by finding counts — significant === 1 for cycle 2", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.getConvergenceData(2),
        adapters.remote.getConvergenceData(2),
      ]);

      // Only F-WI-001-002 (addressed_by=null) should be counted.
      // F-WI-001-003 (addressed_by=WI-001) and F-WI-001-004 (addressed_by="")
      // must both be excluded.
      expect(local.findings_by_severity["significant"]).toBe(1);
      expect(remote.findings_by_severity["significant"]).toBe(1);
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

    it("resolved findings in cycle 1 are excluded from convergence counts", async () => {
      const [local, remote] = await Promise.all([
        adapters.local.getConvergenceData(1),
        adapters.remote.getConvergenceData(1),
      ]);

      // F-WI-001-001 has addressed_by=WI-001 — resolved findings must be excluded
      const localTotal = Object.values(local.findings_by_severity).reduce(
        (sum, n) => sum + n,
        0
      );
      const remoteTotal = Object.values(remote.findings_by_severity).reduce(
        (sum, n) => sum + n,
        0
      );
      expect(localTotal).toBe(0);
      expect(remoteTotal).toBe(0);
      expect(localTotal).toBe(remoteTotal);
    });
  });
});
