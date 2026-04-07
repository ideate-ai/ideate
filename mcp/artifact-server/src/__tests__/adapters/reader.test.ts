/**
 * reader.test.ts — Unit tests for LocalAdapter reader functionality
 *
 * Verifies specific behaviors in LocalReaderAdapter including:
 *   - hasColumn domain type detection for interview_question
 *   - countNodes domain grouping includes interview_questions
 *   - Cross-type domain filtering includes interview_questions
 *   - Status exclusion (D-131): done/obsolete work_items are filtered by default
 *   - Edge extraction for interview_question nodes (WI-627)
 *   - Cross-type domain relationships via getEdges (WI-627)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";

import { createSchema } from "../../schema.js";
import * as dbSchema from "../../db.js";
import { LocalAdapter } from "../../adapters/local/index.js";
import { rebuildIndex } from "../../indexer.js";

describe("LocalReaderAdapter — interview_question edge extraction", () => {
  let db: Database.Database;
  let drizzleDb: any;
  let adapter: LocalAdapter;
  let tmpDir: string;
  let ideateDir: string;

  beforeAll(() => {
    // Create temp directory
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideate-reader-test-"));
    ideateDir = path.join(tmpDir, ".ideate");
    fs.mkdirSync(ideateDir, { recursive: true });

    // Create subdirectories
    const subdirs = [
      "work-items",
      "domain_policies",
      "domain_decisions",
      "domain_questions",
      "interview_questions",
      "cycles",
      "nodes",
    ];
    for (const subdir of subdirs) {
      fs.mkdirSync(path.join(ideateDir, subdir), { recursive: true });
    }

    // Create test YAML files
    const workItem = {
      id: "WI-001",
      type: "work_item",
      title: "Test work item",
      status: "pending",
      domain: "test-domain",
      complexity: 1,
      criteria: ["Criterion 1"],
    };

    const workItemDone = {
      id: "WI-002",
      type: "work_item",
      title: "Done work item",
      status: "done",
      domain: "test-domain",
      complexity: 1,
      criteria: ["Criterion 1"],
    };

    const workItemObsolete = {
      id: "WI-003",
      type: "work_item",
      title: "Obsolete work item",
      status: "obsolete",
      domain: "test-domain",
      complexity: 1,
      criteria: ["Criterion 1"],
    };

    const interviewQuestion = {
      id: "IQ-001",
      type: "interview_question",
      interview_id: "IV-001",
      question: "What is the purpose?",
      domain: "test-domain",
    };

    const domainDecision = {
      id: "D-001",
      type: "domain_decision",
      description: "Test decision",
      domain: "test-domain",
      status: "settled",
    };

    const domainQuestion = {
      id: "Q-001",
      type: "domain_question",
      description: "Test question",
      domain: "test-domain",
      status: "open",
    };

    const domainPolicy = {
      id: "P-001",
      type: "domain_policy",
      description: "Test policy",
      domain: "test-domain",
    };

    fs.writeFileSync(
      path.join(ideateDir, "work-items", "WI-001.yaml"),
      `id: ${workItem.id}\ntype: ${workItem.type}\ntitle: ${workItem.title}\nstatus: ${workItem.status}\ndomain: ${workItem.domain}\ncomplexity: ${workItem.complexity}\ncriteria:\n  - ${workItem.criteria[0]}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "work-items", "WI-002.yaml"),
      `id: ${workItemDone.id}\ntype: ${workItemDone.type}\ntitle: ${workItemDone.title}\nstatus: ${workItemDone.status}\ndomain: ${workItemDone.domain}\ncomplexity: ${workItemDone.complexity}\ncriteria:\n  - ${workItemDone.criteria[0]}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "work-items", "WI-003.yaml"),
      `id: ${workItemObsolete.id}\ntype: ${workItemObsolete.type}\ntitle: ${workItemObsolete.title}\nstatus: ${workItemObsolete.status}\ndomain: ${workItemObsolete.domain}\ncomplexity: ${workItemObsolete.complexity}\ncriteria:\n  - ${workItemObsolete.criteria[0]}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "interview_questions", "IQ-001.yaml"),
      `id: ${interviewQuestion.id}\ntype: ${interviewQuestion.type}\ninterview_id: ${interviewQuestion.interview_id}\nquestion: ${interviewQuestion.question}\ndomain: ${interviewQuestion.domain}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "domain_decisions", "D-001.yaml"),
      `id: ${domainDecision.id}\ntype: ${domainDecision.type}\ndescription: ${domainDecision.description}\ndomain: ${domainDecision.domain}\nstatus: ${domainDecision.status}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "domain_questions", "Q-001.yaml"),
      `id: ${domainQuestion.id}\ntype: ${domainQuestion.type}\ndescription: ${domainQuestion.description}\ndomain: ${domainQuestion.domain}\nstatus: ${domainQuestion.status}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "domain_policies", "P-001.yaml"),
      `id: ${domainPolicy.id}\ntype: ${domainPolicy.type}\ndescription: ${domainPolicy.description}\ndomain: ${domainPolicy.domain}\n`
    );

    // Additional test data for WI-627: cross-type domain relationship testing
    const interviewQuestionDomain2 = {
      id: "IQ-002",
      type: "interview_question",
      interview_id: "IV-001",
      question: "What are the constraints?",
      domain: "test-domain-2",
    };

    const interviewQuestionNoDomain = {
      id: "IQ-003",
      type: "interview_question",
      interview_id: "IV-001",
      question: "No domain question",
    };

    const workItemCrossDomain = {
      id: "WI-004",
      type: "work_item",
      title: "Cross-domain work item",
      status: "pending",
      domain: "test-domain-2",
      complexity: 1,
      criteria: ["Criterion 1"],
    };

    const domainDecisionDomain2 = {
      id: "D-002",
      type: "domain_decision",
      description: "Test decision 2",
      domain: "test-domain-2",
      status: "settled",
    };

    const domainPolicyDomain2 = {
      id: "P-002",
      type: "domain_policy",
      description: "Test policy 2",
      domain: "test-domain-2",
    };

    fs.writeFileSync(
      path.join(ideateDir, "interview_questions", "IQ-002.yaml"),
      `id: ${interviewQuestionDomain2.id}\ntype: ${interviewQuestionDomain2.type}\ninterview_id: ${interviewQuestionDomain2.interview_id}\nquestion: ${interviewQuestionDomain2.question}\ndomain: ${interviewQuestionDomain2.domain}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "interview_questions", "IQ-003.yaml"),
      `id: ${interviewQuestionNoDomain.id}\ntype: ${interviewQuestionNoDomain.type}\ninterview_id: ${interviewQuestionNoDomain.interview_id}\nquestion: ${interviewQuestionNoDomain.question}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "work-items", "WI-004.yaml"),
      `id: ${workItemCrossDomain.id}\ntype: ${workItemCrossDomain.type}\ntitle: ${workItemCrossDomain.title}\nstatus: ${workItemCrossDomain.status}\ndomain: ${workItemCrossDomain.domain}\ncomplexity: ${workItemCrossDomain.complexity}\ncriteria:\n  - ${workItemCrossDomain.criteria[0]}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "domain_decisions", "D-002.yaml"),
      `id: ${domainDecisionDomain2.id}\ntype: ${domainDecisionDomain2.type}\ndescription: ${domainDecisionDomain2.description}\ndomain: ${domainDecisionDomain2.domain}\nstatus: ${domainDecisionDomain2.status}\n`
    );

    fs.writeFileSync(
      path.join(ideateDir, "domain_policies", "P-002.yaml"),
      `id: ${domainPolicyDomain2.id}\ntype: ${domainPolicyDomain2.type}\ndescription: ${domainPolicyDomain2.description}\ndomain: ${domainPolicyDomain2.domain}\n`
    );

    // Create SQLite database
    const dbPath = path.join(tmpDir, "index.db");
    db = new Database(dbPath);
    createSchema(db);
    drizzleDb = drizzle(db, { schema: dbSchema });

    // Build index
    rebuildIndex(db, drizzleDb, ideateDir);

    // Create adapter
    adapter = new LocalAdapter({ db, drizzleDb, ideateDir });
  });

  afterAll(async () => {
    try {
      await adapter.shutdown();
    } catch {
      // ignore
    }
    try {
      db.close();
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("AC-1: hasColumn domainTypes includes interview_question", () => {
    it("queryNodes returns interview_question by domain filter", async () => {
      const result = await adapter.queryNodes({ domain: "test-domain" }, 50, 0);
      const types = result.nodes.map((n) => n.node.type);
      expect(types).toContain("interview_question");
    });

    it("interview_question appears in filtered query results", async () => {
      const result = await adapter.queryNodes(
        { type: "interview_question", domain: "test-domain" },
        50,
        0
      );
      expect(result.nodes.length).toBeGreaterThanOrEqual(1);
      expect(result.nodes[0].node.id).toBe("IQ-001");
    });
  });

  describe("AC-2: countNodes domain grouping includes interview_questions", () => {
    it("countNodes grouped by domain includes interview_questions in counts", async () => {
      const result = await adapter.countNodes({}, "domain");
      const testDomainCount = result.find((r) => r.key === "test-domain");
      expect(testDomainCount).toBeDefined();
      // Should count all domain-bearing nodes (WI-001, WI-002, WI-003, IQ-001, D-001, Q-001, P-001)
      // Note: countNodes does not filter by status; that's handled at query level per D-131
      expect(testDomainCount!.count).toBe(7);
    });

    it("countNodes for specific type includes interview_question domain", async () => {
      const result = await adapter.countNodes(
        { type: "interview_question" },
        "domain"
      );
      const testDomainCount = result.find((r) => r.key === "test-domain");
      expect(testDomainCount).toBeDefined();
      expect(testDomainCount!.count).toBe(1);
    });
  });

  describe("AC-3: interview_question edges are extractable via getEdges", () => {
    it("can retrieve interview_question node and its properties", async () => {
      const node = await adapter.getNode("IQ-001");
      expect(node).not.toBeNull();
      expect(node!.type).toBe("interview_question");
      expect(node!.properties).toBeDefined();
      expect(node!.properties.domain).toBe("test-domain");
    });

    it("getEdges returns belongs_to_domain edge for interview_question with domain", async () => {
      const edges = await adapter.getEdges("IQ-001", "outgoing");
      // interview_question with domain field should have a belongs_to_domain edge
      const domainEdges = edges.filter((e) => e.edge_type === "belongs_to_domain");
      expect(domainEdges.length).toBeGreaterThanOrEqual(1);
      expect(domainEdges.some((e) => e.target_id === "test-domain")).toBe(true);
    });

    it("getEdges returns outgoing edges for interview_question", async () => {
      const edges = await adapter.getEdges("IQ-001", "outgoing");
      // Should have at least the belongs_to_domain edge
      expect(edges.length).toBeGreaterThanOrEqual(1);
      expect(edges.some((e) => e.source_id === "IQ-001")).toBe(true);
    });

    it("getEdges with both direction includes domain relationship for interview_question", async () => {
      const edges = await adapter.getEdges("IQ-001", "both");
      // Should include the belongs_to_domain edge
      const domainEdge = edges.find((e) => e.edge_type === "belongs_to_domain");
      expect(domainEdge).toBeDefined();
      expect(domainEdge!.source_id).toBe("IQ-001");
    });

    it("getEdges returns empty array for interview_question without domain", async () => {
      // IQ-003 has no domain field, so should have no belongs_to_domain edge
      const edges = await adapter.getEdges("IQ-003", "outgoing");
      // No edges should be extracted for a node without domain
      expect(edges).toEqual([]);
    });
  });

  describe("WI-627: Cross-type domain relationships via getEdges", () => {
    it("interview_question and work_item in same domain have matching belongs_to_domain edges", async () => {
      // Both IQ-001 and WI-001 belong to test-domain
      const iqEdges = await adapter.getEdges("IQ-001", "outgoing");
      const wiEdges = await adapter.getEdges("WI-001", "outgoing");

      const iqDomainEdges = iqEdges.filter((e) => e.edge_type === "belongs_to_domain" && e.target_id === "test-domain");
      const wiDomainEdges = wiEdges.filter((e) => e.edge_type === "belongs_to_domain" && e.target_id === "test-domain");

      // Both should have belongs_to_domain edges pointing to test-domain
      expect(iqDomainEdges.length).toBeGreaterThanOrEqual(1);
      expect(wiDomainEdges.length).toBeGreaterThanOrEqual(1);
    });

    it("interview_question in test-domain-2 has correct belongs_to_domain edge", async () => {
      const edges = await adapter.getEdges("IQ-002", "outgoing");
      const domainEdges = edges.filter((e) => e.edge_type === "belongs_to_domain");

      expect(domainEdges.length).toBeGreaterThanOrEqual(1);
      expect(domainEdges.some((e) => e.target_id === "test-domain-2")).toBe(true);
    });

    it("domain_decision and interview_question in same domain share domain target", async () => {
      // D-001 and IQ-001 both belong to test-domain
      const decisionEdges = await adapter.getEdges("D-001", "outgoing");
      const iqEdges = await adapter.getEdges("IQ-001", "outgoing");

      const decisionDomainTargets = decisionEdges
        .filter((e) => e.edge_type === "belongs_to_domain")
        .map((e) => e.target_id);
      const iqDomainTargets = iqEdges
        .filter((e) => e.edge_type === "belongs_to_domain")
        .map((e) => e.target_id);

      // Both should have edges pointing to the same domain
      expect(decisionDomainTargets).toContain("test-domain");
      expect(iqDomainTargets).toContain("test-domain");
    });

    it("domain_policy and interview_question in same domain share domain target", async () => {
      // P-001 and IQ-001 both belong to test-domain
      const policyEdges = await adapter.getEdges("P-001", "outgoing");
      const iqEdges = await adapter.getEdges("IQ-001", "outgoing");

      const policyDomainTargets = policyEdges
        .filter((e) => e.edge_type === "belongs_to_domain")
        .map((e) => e.target_id);
      const iqDomainTargets = iqEdges
        .filter((e) => e.edge_type === "belongs_to_domain")
        .map((e) => e.target_id);

      // Both should have edges pointing to the same domain
      expect(policyDomainTargets).toContain("test-domain");
      expect(iqDomainTargets).toContain("test-domain");
    });

    it("getEdges incoming direction returns no edges for domain nodes (they are strings, not nodes)", async () => {
      // Domain names are strings, not actual nodes in the graph
      // So incoming edges to "test-domain" won't be queryable via getEdges
      // This test documents the expected behavior
      const edges = await adapter.getEdges("IQ-001", "incoming");
      // Incoming edges to interview_question are rare; this just verifies the query works
      expect(Array.isArray(edges)).toBe(true);
    });

    it("cross-domain nodes have different belongs_to_domain targets", async () => {
      // IQ-001 in test-domain vs IQ-002 in test-domain-2
      const iq1Edges = await adapter.getEdges("IQ-001", "outgoing");
      const iq2Edges = await adapter.getEdges("IQ-002", "outgoing");

      const iq1Targets = iq1Edges
        .filter((e) => e.edge_type === "belongs_to_domain")
        .map((e) => e.target_id);
      const iq2Targets = iq2Edges
        .filter((e) => e.edge_type === "belongs_to_domain")
        .map((e) => e.target_id);

      // They should point to different domains
      expect(iq1Targets).toContain("test-domain");
      expect(iq2Targets).toContain("test-domain-2");
      expect(iq1Targets).not.toContain("test-domain-2");
      expect(iq2Targets).not.toContain("test-domain");
    });

    it("all domain-bearing types can be queried by domain via getEdges", async () => {
      // Verify that getEdges works for all domain-bearing types
      const types = [
        { id: "WI-001", type: "work_item" },
        { id: "IQ-001", type: "interview_question" },
        { id: "D-001", type: "domain_decision" },
        { id: "P-001", type: "domain_policy" },
      ];

      for (const { id } of types) {
        const edges = await adapter.getEdges(id, "outgoing");
        expect(Array.isArray(edges)).toBe(true);
        // Each should have belongs_to_domain edges
        const hasDomainEdge = edges.some((e) => e.edge_type === "belongs_to_domain");
        expect(hasDomainEdge).toBe(true);
      }
    });
  });

  describe("Cross-type domain filter consistency", () => {
    it("returns all domain-bearing types when filtering by domain", async () => {
      const result = await adapter.queryNodes({ domain: "test-domain" }, 50, 0);
      const ids = result.nodes.map((n) => n.node.id).sort();

      // All domain-bearing nodes should be returned
      expect(ids).toContain("WI-001");
      expect(ids).toContain("IQ-001");
      expect(ids).toContain("D-001");
      expect(ids).toContain("Q-001");
      expect(ids).toContain("P-001");

      // Total count should be 5 (excludes done WI-002 and obsolete WI-003 per D-131)
      expect(result.total_count).toBe(5);
    });
  });

  describe("D-131: Status exclusion for done/obsolete work_items", () => {
    it("queryNodes excludes work_items with status 'done' when querying by type", async () => {
      const result = await adapter.queryNodes({ type: "work_item" }, 50, 0);
      const ids = result.nodes.map((n) => n.node.id);

      // Should include pending work item
      expect(ids).toContain("WI-001");
      // Should exclude done work item
      expect(ids).not.toContain("WI-002");
      // Should exclude obsolete work item
      expect(ids).not.toContain("WI-003");
    });

    it("queryNodes excludes work_items with status 'done' in cross-type queries", async () => {
      const result = await adapter.queryNodes({ domain: "test-domain" }, 50, 0);
      const ids = result.nodes.map((n) => n.node.id);

      // Should include pending work item
      expect(ids).toContain("WI-001");
      // Should exclude done work item
      expect(ids).not.toContain("WI-002");
      // Should exclude obsolete work item
      expect(ids).not.toContain("WI-003");
    });

    it("queryNodes includes done/obsolete work_items when status filter is explicitly specified", async () => {
      // When status filter is explicitly set, exclusion should not apply
      const resultDone = await adapter.queryNodes(
        { type: "work_item", status: "done" },
        50,
        0
      );
      const idsDone = resultDone.nodes.map((n) => n.node.id);

      // Should include done work item when explicitly filtering for done
      expect(idsDone).toContain("WI-002");
      // Should not include pending or obsolete
      expect(idsDone).not.toContain("WI-001");
      expect(idsDone).not.toContain("WI-003");
    });

    it("queryNodes includes obsolete work_items when status filter is explicitly specified", async () => {
      const resultObsolete = await adapter.queryNodes(
        { type: "work_item", status: "obsolete" },
        50,
        0
      );
      const idsObsolete = resultObsolete.nodes.map((n) => n.node.id);

      // Should include obsolete work item when explicitly filtering for obsolete
      expect(idsObsolete).toContain("WI-003");
      // Should not include pending or done
      expect(idsObsolete).not.toContain("WI-001");
      expect(idsObsolete).not.toContain("WI-002");
    });

    it("getNode still returns done/obsolete work_items (no exclusion at getNode level)", async () => {
      // getNode should not apply status exclusion
      const doneNode = await adapter.getNode("WI-002");
      expect(doneNode).not.toBeNull();
      expect(doneNode!.status).toBe("done");

      const obsoleteNode = await adapter.getNode("WI-003");
      expect(obsoleteNode).not.toBeNull();
      expect(obsoleteNode!.status).toBe("obsolete");
    });
  });
});
