# Neo4j Schema for Ideate Knowledge Graph

> Implementation specification for the ideate-server team.
> Defines node labels, relationship types, constraints, indexes, multi-tenant containment, knowledge promotion, and PPR integration.
> Source of truth: `schema.ts` EDGE_TYPE_REGISTRY, `db.ts` TYPE_TO_EXTENSION_TABLE, and the platform steering document.

---

## 1. Design Principles

The Neo4j schema replaces a relational model (base `nodes` table + 16 extension tables + `edges` table) with a native graph model. Each artifact type becomes a node label carrying its properties directly. Relationships replace the universal `edges` table, carrying `type` and `weight` as first-class properties.

Key simplifications over the relational model:
- No extension tables. Node properties replace column-per-table joins.
- No `nodes.type` discriminator. The Neo4j label is the type.
- No JSON-serialized arrays. List properties are native Neo4j lists.
- Relationships are typed and directional, not rows in a generic table.

---

## 2. Multi-Tenant Data Model

### 2.1 Tenant Hierarchy

```
Organization (tenant root)
 |-- OWNS_CODEBASE --> Codebase (tracked repo)
 |-- OWNS_PROJECT  --> Project (epic-level, may span codebases)
 |-- OWNS_KNOWLEDGE --> GuidingPrinciple | DomainPolicy | DomainDecision | Constraint
 |
 Project
  |-- HAS_PHASE --> Phase
  |    |-- HAS_WORK_ITEM --> WorkItem
  |
  |-- REFERENCES_CODEBASE --> Codebase
```

### 2.2 Tenant Nodes

#### Organization

The graph root for a tenant. Every other node is reachable from an Organization node through containment relationships.

```
(:Organization {
  org_id:       String!,   // UUID, globally unique
  name:         String!,
  slug:         String!,   // URL-safe identifier
  plan:         String,    // "free" | "team" | "enterprise"
  created_at:   DateTime!,
  updated_at:   DateTime
})
```

#### Codebase

A tracked code repository. Replaces the local "workspace" concept.

```
(:Codebase {
  codebase_id:  String!,   // UUID, globally unique
  org_id:       String!,   // denormalized for query convenience
  name:         String!,
  repo_url:     String,    // e.g. "github.com/acme/api-gateway"
  local_path:   String,    // local development path (optional)
  created_at:   DateTime!,
  updated_at:   DateTime
})
```

### 2.3 Compound Keys

Artifact IDs are unique within a codebase. In the merged multi-codebase graph, uniqueness is enforced by the compound key `(org_id, codebase_id, artifact_id)`. The `artifact_id` property on every artifact node carries the original local ID (e.g., `WI-044`, `P-03`). No renumbering is needed during migration.

---

## 3. Node Labels

All 27 YAML artifact types map to Neo4j node labels. Nodes from the SQLite `nodes` base table contribute common properties; extension table columns become type-specific properties.

### 3.1 Common Properties (all artifact nodes)

Every artifact node carries these properties, derived from the SQLite `nodes` table:

| Property | Type | Required | Notes |
|---|---|---|---|
| `artifact_id` | String | Yes | Original ID from YAML (e.g., `WI-044`) |
| `org_id` | String | Yes | Owning organization |
| `codebase_id` | String | Yes | Source codebase |
| `cycle_created` | Integer | No | Cycle number when created |
| `cycle_modified` | Integer | No | Cycle number when last modified |
| `content_hash` | String | Yes | SHA-256 of content fields |
| `token_count` | Integer | No | Approximate token count |
| `file_path` | String | Yes | Original YAML file path (relative to .ideate/) |
| `status` | String | No | Artifact status |
| `created_at` | DateTime | Yes | Server timestamp |
| `updated_at` | DateTime | Yes | Server timestamp |

### 3.2 Structural Nodes (3 labels)

#### Project

Epic-level work container. May span multiple codebases.

```
(:Project {
  // common properties +
  name:             String,
  description:      String,
  intent:           String!,
  scope_in:         String[],    // was JSON scope_boundary.in
  scope_out:        String[],    // was JSON scope_boundary.out
  success_criteria: String[],    // was JSON array
  appetite:         Integer,
  steering:         String,
  horizon_current:  String,
  horizon_next:     String[],
  horizon_later:    String[]
})
```

#### Phase

An iteration within a project.

```
(:Phase {
  // common properties +
  name:        String,
  description: String,
  phase_type:  String!,
  intent:      String!,
  steering:    String,
  work_items:  String[]    // ordered list of work item IDs in this phase
})
```

#### WorkItem

A discrete unit of work.

```
(:WorkItem {
  // common properties +
  title:          String!,
  complexity:     String,      // "small" | "medium" | "large"
  scope:          String,      // JSON array of {path, op} entries
  criteria:       String[],    // acceptance criteria
  notes:          String,
  work_item_type: String       // "feature" | "bug" | "spike" | "maintenance" | "chore"
})
```

### 3.3 Knowledge Nodes (5 labels)

#### GuidingPrinciple

```
(:GuidingPrinciple {
  // common properties +
  name:              String!,
  description:       String,
  amendment_history: String    // JSON array of {cycle, change_summary}
})
```

#### DomainPolicy

```
(:DomainPolicy {
  // common properties +
  domain:      String!,
  established: String,
  amended:     String,
  description: String
})
```

#### DomainDecision

```
(:DomainDecision {
  // common properties +
  domain:      String!,
  cycle:       Integer,
  description: String,
  rationale:   String
})
```

#### DomainQuestion

```
(:DomainQuestion {
  // common properties +
  domain:      String!,
  impact:      String,
  source:      String,
  resolution:  String,
  resolved_in: Integer,
  description: String
})
```

#### Constraint

```
(:Constraint {
  // common properties +
  category:    String!,    // "technology" | "design" | "process" | "scope"
  description: String
})
```

### 3.4 Review Nodes (2 labels)

#### Finding

```
(:Finding {
  // common properties +
  severity:    String!,    // "critical" | "significant" | "minor"
  verdict:     String!,    // "pass" | "fail"
  cycle:       Integer!,
  reviewer:    String!,
  description: String,
  suggestion:  String,
  file_refs:   String      // JSON array of {path, line?}
})
```

#### ProxyHumanDecision

```
(:ProxyHumanDecision {
  // common properties +
  cycle:     Integer!,
  trigger:   String!,      // "andon" | "fallback" | "deferral"
  decision:  String!,      // "approved" | "deferred" | "escalated"
  rationale: String,
  timestamp: String!
})
```

### 3.5 Research and Context Nodes (3 labels)

#### ResearchFinding

```
(:ResearchFinding {
  // common properties +
  topic:   String!,
  date:    String,
  content: String,
  sources: String[]
})
```

#### ModuleSpec

```
(:ModuleSpec {
  // common properties +
  name:           String!,
  scope:          String,
  provides:       String[],
  requires:       String[],
  boundary_rules: String[]
})
```

#### InterviewQuestion

```
(:InterviewQuestion {
  // common properties +
  interview_id: String!,
  question:     String!,
  answer:       String!,
  domain:       String,
  seq:          Integer!
})
```

### 3.6 Operational Nodes (2 labels)

#### JournalEntry

```
(:JournalEntry {
  // common properties +
  phase:     String,
  date:      String,
  title:     String,
  content:   String
})
```

#### MetricsEvent

```
(:MetricsEvent {
  // common properties +
  event_name:                String!,
  timestamp:                 String,
  payload:                   String,     // JSON
  input_tokens:              Integer,
  output_tokens:             Integer,
  cache_read_tokens:         Integer,
  cache_write_tokens:        Integer,
  outcome:                   String,
  finding_count:             Integer,
  finding_severities:        String,
  first_pass_accepted:       Integer,
  rework_count:              Integer,
  work_item_total_tokens:    Integer,
  cycle_total_tokens:        Integer,
  cycle_total_cost_estimate: String,
  convergence_cycles:        Integer,
  context_artifact_ids:      String
})
```

### 3.7 Document Nodes (12 subtypes, 1 label)

The SQLite model uses a single `document_artifacts` extension table for 12 YAML types. In Neo4j these share one label with a `doc_type` discriminator, since their properties are identical.

```
(:Document {
  // common properties +
  doc_type: String!,    // one of the 12 values below
  title:    String,
  cycle:    Integer,
  content:  String
})
```

Document subtypes (values for `doc_type`):
1. `decision_log`
2. `cycle_summary`
3. `review_output`
4. `review_manifest`
5. `architecture`
6. `overview`
7. `execution_strategy`
8. `guiding_principles`
9. `constraints`
10. `research`
11. `interview`
12. `domain_index`

### 3.8 Complete Label Summary

| # | Neo4j Label | YAML type(s) | Count |
|---|---|---|---|
| 1 | `Organization` | (new, tenant root) | -- |
| 2 | `Codebase` | (new, replaces workspace) | -- |
| 3 | `Project` | `project` | 1 |
| 4 | `Phase` | `phase` | 1 |
| 5 | `WorkItem` | `work_item` | 1 |
| 6 | `GuidingPrinciple` | `guiding_principle` | 1 |
| 7 | `DomainPolicy` | `domain_policy` | 1 |
| 8 | `DomainDecision` | `domain_decision` | 1 |
| 9 | `DomainQuestion` | `domain_question` | 1 |
| 10 | `Constraint` | `constraint` | 1 |
| 11 | `Finding` | `finding` | 1 |
| 12 | `ProxyHumanDecision` | `proxy_human_decision` | 1 |
| 13 | `ResearchFinding` | `research_finding` | 1 |
| 14 | `ModuleSpec` | `module_spec` | 1 |
| 15 | `InterviewQuestion` | `interview_question` | 1 |
| 16 | `JournalEntry` | `journal_entry` | 1 |
| 17 | `MetricsEvent` | `metrics_event` | 1 |
| 18 | `Document` | 12 document subtypes | 12 |
| | | **Total YAML types covered** | **27** |

---

## 4. Relationship Types

### 4.1 Containment Relationships (Multi-Tenant Hierarchy)

These relationships establish the tenant hierarchy and are not present in the current SQLite model. They enable multi-tenant isolation and scoped queries.

| Relationship | Source | Target | Weight | Notes |
|---|---|---|---|---|
| `OWNS_CODEBASE` | Organization | Codebase | -- | Tenant owns repo |
| `OWNS_PROJECT` | Organization | Project | -- | Tenant owns project |
| `OWNS_KNOWLEDGE` | Organization | GuidingPrinciple, DomainPolicy, DomainDecision, Constraint | -- | Org-level promoted knowledge |
| `REFERENCES_CODEBASE` | Project | Codebase | -- | Project spans codebases |
| `HAS_PHASE` | Project | Phase | -- | Structural containment |
| `HAS_WORK_ITEM` | Phase | WorkItem | -- | Structural containment |

### 4.2 Artifact Relationships (from EDGE_TYPE_REGISTRY)

Each entry in `EDGE_TYPE_REGISTRY` maps to a Neo4j relationship type. The `yaml_field` from the registry indicates which YAML property drives edge extraction during indexing.

| Relationship | Source Labels | Target Labels | YAML Field | Default Weight | Category |
|---|---|---|---|---|---|
| `DEPENDS_ON` | WorkItem | WorkItem | `depends` | 1.0 | Structural |
| `BLOCKS` | WorkItem | WorkItem | `blocks` | 0.3 | Structural |
| `BELONGS_TO_MODULE` | WorkItem | ModuleSpec | `module` | 0.8 | Structural |
| `DERIVED_FROM` | DomainPolicy | GuidingPrinciple | `derived_from` | 0.8 | Knowledge |
| `RELATES_TO` | Finding | WorkItem | `work_item` | 0.6 | Knowledge |
| `ADDRESSED_BY` | Finding, DomainQuestion | WorkItem | `addressed_by` | 0.6 | Knowledge |
| `REFERENCES` | (any) | (any) | (explicit) | 0.4 | Cross-cutting |
| `AMENDED_BY` | DomainPolicy | DomainPolicy | `amended_by` | 0.5 | Knowledge |
| `SUPERSEDES` | DomainDecision | DomainDecision | `supersedes` | 0.5 | Knowledge |
| `TRIGGERED_BY` | ProxyHumanDecision | Finding, WorkItem | `triggered_by` | 0.6 | Knowledge |
| `GOVERNED_BY` | WorkItem, ModuleSpec, Constraint | GuidingPrinciple, DomainPolicy, Constraint | `governed_by` | 0.8 | Knowledge |
| `INFORMED_BY` | WorkItem, ModuleSpec, GuidingPrinciple | ResearchFinding, DomainDecision, DomainQuestion | `informed_by` | 0.6 | Knowledge |
| `BELONGS_TO_PROJECT` | Phase | Project | `project` | 1.0 | Structural |
| `BELONGS_TO_PHASE` | WorkItem | Phase | `phase` | 1.0 | Structural |

### 4.3 Knowledge Promotion Relationships

These cross-cutting edges connect project-scoped knowledge to the org-level knowledge layer. They are created when a user or automated process "promotes" a project-local insight to org-wide applicability.

| Relationship | Source | Target | Properties |
|---|---|---|---|
| `PROMOTED_TO` | Project-scoped DomainPolicy | Org-level DomainPolicy | `promoted_at: DateTime`, `promoted_by: String`, `confidence: Float` |
| `PROMOTED_TO` | Project-scoped DomainDecision | Org-level DomainDecision | `promoted_at: DateTime`, `promoted_by: String`, `confidence: Float` |
| `PROMOTED_TO` | Project-scoped GuidingPrinciple | Org-level GuidingPrinciple | `promoted_at: DateTime`, `promoted_by: String`, `confidence: Float` |
| `PROMOTED_TO` | Project-scoped Constraint | Org-level Constraint | `promoted_at: DateTime`, `promoted_by: String`, `confidence: Float` |

Knowledge promotion does not move nodes. Both the project-scoped original and the org-level version exist as separate nodes connected by a `PROMOTED_TO` edge. PPR traversal from other projects discovers promoted knowledge through the org-level node and its edge weights.

### 4.4 Cross-Project Discovery Relationships

These edges connect artifacts across projects within the same organization. They are created by automated analysis (similarity detection, shared-domain matching) or manually by users.

| Relationship | Source | Target | Properties |
|---|---|---|---|
| `CROSS_REFERENCES` | (any artifact in Project A) | (any artifact in Project B) | `created_at: DateTime`, `created_by: String`, `reason: String`, `weight: Float` |
| `SIMILAR_TO` | (any knowledge node) | (any knowledge node) | `similarity_score: Float`, `detected_at: DateTime`, `method: String` |

### 4.5 Relationship Properties

All artifact relationships carry these properties:

```
{
  weight:     Float,      // PPR traversal weight (default per edge category)
  created_at: DateTime,   // when the edge was created
  source:     String      // "yaml_field" | "promotion" | "manual" | "automated"
}
```

The `weight` property is the primary input to server-side PPR. It defaults based on the edge category (structural: 1.0, knowledge: 0.6, cross-cutting: 0.3) but can be overridden per relationship instance.

---

## 5. PPR Edge Weight Configuration

### 5.1 Weight Storage Model

PPR edge weights are stored as relationship properties, not in a separate configuration table. This makes weights directly queryable and tunable per edge instance.

```cypher
// Every relationship carries a weight property
(a)-[r:DEPENDS_ON {weight: 1.0}]->(b)
(a)-[r:GOVERNED_BY {weight: 0.8}]->(b)
(a)-[r:REFERENCES {weight: 0.4}]->(b)
```

### 5.2 Default Weight Table

Weights are assigned at relationship creation time based on the edge category. These defaults match the current `DEFAULT_EDGE_TYPE_WEIGHTS` in `ppr.ts` extended with the new multi-tenant relationship types.

| Relationship Type | Default Weight | Category |
|---|---|---|
| `DEPENDS_ON` | 1.0 | Structural |
| `BLOCKS` | 0.3 | Structural |
| `BELONGS_TO_MODULE` | 0.8 | Structural |
| `DERIVED_FROM` | 0.8 | Knowledge |
| `RELATES_TO` | 0.6 | Knowledge |
| `ADDRESSED_BY` | 0.6 | Knowledge |
| `REFERENCES` | 0.4 | Cross-cutting |
| `AMENDED_BY` | 0.5 | Knowledge |
| `SUPERSEDES` | 0.5 | Knowledge |
| `TRIGGERED_BY` | 0.6 | Knowledge |
| `GOVERNED_BY` | 0.8 | Knowledge |
| `INFORMED_BY` | 0.6 | Knowledge |
| `BELONGS_TO_PROJECT` | 1.0 | Structural |
| `BELONGS_TO_PHASE` | 1.0 | Structural |
| `HAS_PHASE` | 1.0 | Structural |
| `HAS_WORK_ITEM` | 1.0 | Structural |
| `OWNS_CODEBASE` | 1.0 | Structural |
| `OWNS_PROJECT` | 1.0 | Structural |
| `OWNS_KNOWLEDGE` | 1.0 | Structural |
| `REFERENCES_CODEBASE` | 0.6 | Knowledge |
| `PROMOTED_TO` | 0.5 | Cross-cutting |
| `CROSS_REFERENCES` | 0.3 | Cross-cutting |
| `SIMILAR_TO` | 0.3 | Cross-cutting |

### 5.3 Per-Query Weight Overrides

The PPR algorithm accepts per-edge-type weight overrides at query time (matching the existing `edgeTypeWeights` parameter in `ppr.ts`). The server-side PPR endpoint accepts an optional `edgeTypeWeights` map that overrides relationship `weight` properties during traversal.

```cypher
// Server-side PPR uses this pattern to read weights:
// 1. Default: r.weight property on the relationship
// 2. Override: caller-supplied map keyed by relationship type
```

The override mechanism allows callers to:
- Zero out cross-cutting edges for project-isolated context assembly
- Boost knowledge edges during domain review
- Suppress structural edges to find distant semantic connections

### 5.4 Weight Decay

Edge weights can decay over time unless reinforced. This prevents graph bloat from stale cross-project references.

```
decay_weight = weight * exp(-lambda * days_since_last_traversal)
```

Implementation: a `last_traversed` DateTime property on relationships, updated when PPR traverses the edge. A periodic background job applies decay to untouched edges. Edges below a threshold weight are candidates for pruning.

---

## 6. Constraints and Indexes

### 6.1 Uniqueness Constraints

```cypher
// Tenant uniqueness
CREATE CONSTRAINT org_id_unique
  FOR (o:Organization) REQUIRE o.org_id IS UNIQUE;

CREATE CONSTRAINT org_slug_unique
  FOR (o:Organization) REQUIRE o.slug IS UNIQUE;

// Codebase uniqueness within org (compound)
CREATE CONSTRAINT codebase_id_unique
  FOR (c:Codebase) REQUIRE c.codebase_id IS UNIQUE;

// Artifact uniqueness: compound key (org_id, codebase_id, artifact_id)
// Neo4j Community does not support composite uniqueness constraints.
// Use a synthetic key: artifact_uid = "{org_id}:{codebase_id}:{artifact_id}"
CREATE CONSTRAINT project_uid_unique
  FOR (n:Project) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT phase_uid_unique
  FOR (n:Phase) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT work_item_uid_unique
  FOR (n:WorkItem) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT finding_uid_unique
  FOR (n:Finding) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT guiding_principle_uid_unique
  FOR (n:GuidingPrinciple) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT domain_policy_uid_unique
  FOR (n:DomainPolicy) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT domain_decision_uid_unique
  FOR (n:DomainDecision) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT domain_question_uid_unique
  FOR (n:DomainQuestion) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT constraint_uid_unique
  FOR (n:Constraint) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT module_spec_uid_unique
  FOR (n:ModuleSpec) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT research_finding_uid_unique
  FOR (n:ResearchFinding) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT journal_entry_uid_unique
  FOR (n:JournalEntry) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT metrics_event_uid_unique
  FOR (n:MetricsEvent) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT document_uid_unique
  FOR (n:Document) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT interview_question_uid_unique
  FOR (n:InterviewQuestion) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT proxy_human_decision_uid_unique
  FOR (n:ProxyHumanDecision) REQUIRE n.artifact_uid IS UNIQUE;
```

The `artifact_uid` property is a computed synthetic key: `"{org_id}:{codebase_id}:{artifact_id}"`. It is set at write time and never changes. This avoids the limitations of Neo4j Community Edition which does not support multi-property uniqueness constraints.

### 6.2 Existence Constraints (Neo4j Enterprise)

If running Neo4j Enterprise, add property existence constraints for required fields:

```cypher
// Organization required fields
CREATE CONSTRAINT org_name_exists
  FOR (o:Organization) REQUIRE o.name IS NOT NULL;

// All artifact nodes require org_id and codebase_id
CREATE CONSTRAINT work_item_org_exists
  FOR (n:WorkItem) REQUIRE n.org_id IS NOT NULL;
CREATE CONSTRAINT work_item_codebase_exists
  FOR (n:WorkItem) REQUIRE n.codebase_id IS NOT NULL;
CREATE CONSTRAINT work_item_artifact_id_exists
  FOR (n:WorkItem) REQUIRE n.artifact_id IS NOT NULL;

// Repeat pattern for all artifact labels...
// (Omitted for brevity; apply to all 16 artifact labels)
```

On Community Edition, enforce existence at the application layer (GraphQL resolver validation).

### 6.3 Indexes

```cypher
// --- Tenant isolation indexes (every query starts here) ---
CREATE INDEX org_id_idx FOR (o:Organization) ON (o.org_id);

// Artifact lookup by org + codebase (most common query pattern)
CREATE INDEX work_item_org_codebase
  FOR (n:WorkItem) ON (n.org_id, n.codebase_id);
CREATE INDEX phase_org_codebase
  FOR (n:Phase) ON (n.org_id, n.codebase_id);
CREATE INDEX project_org_codebase
  FOR (n:Project) ON (n.org_id, n.codebase_id);
CREATE INDEX finding_org_codebase
  FOR (n:Finding) ON (n.org_id, n.codebase_id);
CREATE INDEX document_org_codebase
  FOR (n:Document) ON (n.org_id, n.codebase_id);

// --- Domain-scoped queries ---
CREATE INDEX domain_policy_domain
  FOR (n:DomainPolicy) ON (n.org_id, n.domain);
CREATE INDEX domain_decision_domain
  FOR (n:DomainDecision) ON (n.org_id, n.domain);
CREATE INDEX domain_question_domain
  FOR (n:DomainQuestion) ON (n.org_id, n.domain);
CREATE INDEX work_item_domain
  FOR (n:WorkItem) ON (n.org_id, n.domain);

// --- Status-based queries ---
CREATE INDEX work_item_status
  FOR (n:WorkItem) ON (n.org_id, n.status);
CREATE INDEX phase_status
  FOR (n:Phase) ON (n.org_id, n.status);
CREATE INDEX project_status
  FOR (n:Project) ON (n.org_id, n.status);

// --- Cycle-based queries ---
CREATE INDEX finding_cycle
  FOR (n:Finding) ON (n.org_id, n.cycle);
CREATE INDEX domain_decision_cycle
  FOR (n:DomainDecision) ON (n.org_id, n.cycle);

// --- Content hash for change detection ---
CREATE INDEX work_item_hash
  FOR (n:WorkItem) ON (n.content_hash);
CREATE INDEX document_hash
  FOR (n:Document) ON (n.content_hash);

// --- Interview question lookup ---
CREATE INDEX interview_question_interview
  FOR (n:InterviewQuestion) ON (n.interview_id);

// --- Document subtype discrimination ---
CREATE INDEX document_type
  FOR (n:Document) ON (n.org_id, n.doc_type);

// --- Full-text search (for artifact content) ---
CREATE FULLTEXT INDEX artifact_text_search
  FOR (n:WorkItem|DomainPolicy|DomainDecision|DomainQuestion|GuidingPrinciple|Finding|Document)
  ON EACH [n.title, n.description, n.content];

// --- Relationship index for PPR weight queries ---
// Neo4j 5.x supports relationship indexes
CREATE INDEX rel_weight FOR ()-[r:DEPENDS_ON]-() ON (r.weight);
CREATE INDEX rel_weight_governed FOR ()-[r:GOVERNED_BY]-() ON (r.weight);
CREATE INDEX rel_weight_informed FOR ()-[r:INFORMED_BY]-() ON (r.weight);
CREATE INDEX rel_weight_references FOR ()-[r:REFERENCES]-() ON (r.weight);
```

### 6.4 Index Strategy Rationale

| Query Pattern | Index Used | Notes |
|---|---|---|
| List all work items for a project | `work_item_org_codebase` + `HAS_WORK_ITEM` traversal | Start from Project, traverse HAS_PHASE, HAS_WORK_ITEM |
| Find artifacts by domain | `domain_policy_domain`, `work_item_domain` | Composite index on (org_id, domain) for tenant isolation |
| PPR seed expansion | Relationship indexes on `weight` | Prune zero-weight edges before traversal |
| Cross-project knowledge discovery | `PROMOTED_TO` and `CROSS_REFERENCES` traversal | Start from org-level knowledge nodes |
| Change detection (migration/sync) | `content_hash` indexes | Compare hashes to detect stale nodes |
| Full-text search across artifacts | `artifact_text_search` | Lucene-backed full-text index for keyword queries |
| Status dashboard queries | `work_item_status`, `phase_status` | Filtered by org_id + status |

---

## 7. Cypher Query Examples

### 7.1 Artifact CRUD

#### Create a WorkItem

```cypher
CREATE (wi:WorkItem {
  artifact_uid: $org_id + ':' + $codebase_id + ':' + $artifact_id,
  artifact_id:  $artifact_id,
  org_id:       $org_id,
  codebase_id:  $codebase_id,
  title:        $title,
  complexity:   $complexity,
  status:       $status,
  work_item_type: $work_item_type,
  criteria:     $criteria,
  content_hash: $content_hash,
  token_count:  $token_count,
  file_path:    $file_path,
  cycle_created: $cycle_created,
  created_at:   datetime(),
  updated_at:   datetime()
})
RETURN wi
```

#### Read a WorkItem by compound key

```cypher
MATCH (wi:WorkItem {
  org_id: $org_id,
  codebase_id: $codebase_id,
  artifact_id: $artifact_id
})
RETURN wi
```

#### Update a WorkItem

```cypher
MATCH (wi:WorkItem {artifact_uid: $org_id + ':' + $codebase_id + ':' + $artifact_id})
SET wi.title = $title,
    wi.status = $status,
    wi.content_hash = $content_hash,
    wi.cycle_modified = $cycle_modified,
    wi.updated_at = datetime()
RETURN wi
```

#### Delete a WorkItem (cascading edge removal is automatic)

```cypher
MATCH (wi:WorkItem {artifact_uid: $org_id + ':' + $codebase_id + ':' + $artifact_id})
DETACH DELETE wi
```

#### Upsert a WorkItem (idempotent create-or-update)

```cypher
MERGE (wi:WorkItem {artifact_uid: $org_id + ':' + $codebase_id + ':' + $artifact_id})
ON CREATE SET
  wi.artifact_id  = $artifact_id,
  wi.org_id       = $org_id,
  wi.codebase_id  = $codebase_id,
  wi.title        = $title,
  wi.complexity   = $complexity,
  wi.status       = $status,
  wi.content_hash = $content_hash,
  wi.token_count  = $token_count,
  wi.file_path    = $file_path,
  wi.cycle_created = $cycle_created,
  wi.created_at   = datetime(),
  wi.updated_at   = datetime()
ON MATCH SET
  wi.title        = $title,
  wi.complexity   = $complexity,
  wi.status       = $status,
  wi.content_hash = $content_hash,
  wi.token_count  = $token_count,
  wi.cycle_modified = $cycle_modified,
  wi.updated_at   = datetime()
RETURN wi
```

### 7.2 Graph Traversal

#### Get all work items for a project (two-hop traversal)

```cypher
MATCH (p:Project {org_id: $org_id, artifact_id: $project_id})
      -[:HAS_PHASE]->(ph:Phase)
      -[:HAS_WORK_ITEM]->(wi:WorkItem)
RETURN wi.artifact_id AS id, wi.title, wi.status, wi.complexity,
       ph.artifact_id AS phase_id, ph.name AS phase_name
ORDER BY ph.artifact_id, wi.artifact_id
```

#### Get all knowledge artifacts for a domain within an organization

```cypher
MATCH (n {org_id: $org_id, domain: $domain_name})
WHERE n:DomainPolicy OR n:DomainDecision OR n:DomainQuestion
RETURN labels(n)[0] AS type, n.artifact_id AS id,
       n.description, n.status
ORDER BY type, id
```

#### Get the dependency chain for a work item (variable-length path)

```cypher
MATCH path = (wi:WorkItem {org_id: $org_id, artifact_id: $work_item_id})
             -[:DEPENDS_ON*1..10]->(dep:WorkItem)
RETURN [node IN nodes(path) | node.artifact_id] AS dependency_chain,
       length(path) AS depth
ORDER BY depth
```

#### Get all findings for a cycle with their associated work items

```cypher
MATCH (f:Finding {org_id: $org_id, cycle: $cycle_number})
      -[:RELATES_TO]->(wi:WorkItem)
RETURN f.artifact_id AS finding_id, f.severity, f.verdict,
       wi.artifact_id AS work_item_id, wi.title AS work_item_title
ORDER BY
  CASE f.severity
    WHEN 'critical' THEN 0
    WHEN 'significant' THEN 1
    WHEN 'minor' THEN 2
  END
```

### 7.3 PPR Seed Expansion

Server-side PPR replaces the in-process `ppr.ts` algorithm. The graph traversal happens natively in Neo4j, eliminating the need to load all edges into memory.

#### Phase 1: Collect seed neighbors with weighted edges

```cypher
// Given seed node IDs, expand one hop collecting weighted edges
// This is used iteratively by the PPR algorithm
UNWIND $seed_ids AS seed_id
MATCH (seed {artifact_uid: seed_id})
MATCH (seed)-[r]-(neighbor)
WHERE r.weight > 0
RETURN seed.artifact_uid AS source,
       neighbor.artifact_uid AS target,
       type(r) AS rel_type,
       r.weight AS weight
```

#### Phase 2: Full PPR computation (server-side procedure)

The PPR algorithm from `ppr.ts` ports to a Neo4j server-side procedure or an application-layer implementation that uses targeted Cypher queries instead of loading all edges.

```cypher
// Iterative PPR: one propagation step
// scores_map is maintained in application memory;
// each iteration queries neighbors and their weights
UNWIND $active_nodes AS node_uid
MATCH (n {artifact_uid: node_uid})-[r]-(neighbor)
WHERE r.weight > 0
  AND neighbor.org_id = $org_id  // tenant isolation
RETURN node_uid AS source,
       neighbor.artifact_uid AS target,
       type(r) AS rel_type,
       r.weight AS weight,
       size([(neighbor)-[r2]-() | r2]) AS neighbor_degree
```

#### Phase 3: PPR with org-scoped tenant isolation

```cypher
// Ensure PPR never leaks across organizations
// All traversals include org_id filter
MATCH (seed {artifact_uid: $seed_uid, org_id: $org_id})
CALL {
  WITH seed
  MATCH path = (seed)-[r*1..5]-(connected)
  WHERE ALL(rel IN relationships(path) WHERE rel.weight > $min_weight)
    AND ALL(node IN nodes(path) WHERE node.org_id = $org_id)
  RETURN connected, reduce(w = 1.0, rel IN relationships(path) | w * rel.weight) AS path_weight
}
RETURN connected.artifact_uid AS node_id,
       labels(connected)[0] AS node_type,
       connected.title AS title,
       sum(path_weight) AS aggregate_score
ORDER BY aggregate_score DESC
LIMIT $top_k
```

### 7.4 Cross-Project Knowledge Discovery

#### Find org-level knowledge relevant to a project

```cypher
// Start from a project's work items, traverse to org knowledge layer
MATCH (p:Project {org_id: $org_id, artifact_id: $project_id})
      -[:HAS_PHASE]->(:Phase)
      -[:HAS_WORK_ITEM]->(wi:WorkItem)
      -[:GOVERNED_BY|INFORMED_BY]->(knowledge)
WHERE knowledge:GuidingPrinciple OR knowledge:DomainPolicy
      OR knowledge:DomainDecision OR knowledge:Constraint
RETURN DISTINCT knowledge.artifact_id AS id,
       labels(knowledge)[0] AS type,
       knowledge.description,
       count(wi) AS referencing_work_items
ORDER BY referencing_work_items DESC
```

#### Discover knowledge promoted from other projects

```cypher
// Find org-level knowledge that was promoted from OTHER projects
MATCH (org:Organization {org_id: $org_id})
      -[:OWNS_KNOWLEDGE]->(org_knowledge)
      <-[:PROMOTED_TO]-(project_knowledge)
      <-[:GOVERNED_BY|INFORMED_BY|DERIVED_FROM]-()
      <-[:HAS_WORK_ITEM|HAS_PHASE*1..2]-(other_project:Project)
WHERE other_project.artifact_id <> $current_project_id
RETURN org_knowledge.artifact_id AS knowledge_id,
       labels(org_knowledge)[0] AS type,
       org_knowledge.description,
       other_project.artifact_id AS source_project,
       other_project.name AS source_project_name
ORDER BY type, knowledge_id
```

#### Find similar decisions across projects

```cypher
MATCH (d1:DomainDecision {org_id: $org_id})
      -[:SIMILAR_TO {method: 'embedding'}]->
      (d2:DomainDecision {org_id: $org_id})
WHERE d1.codebase_id <> d2.codebase_id
RETURN d1.artifact_id AS decision_a, d1.description AS desc_a,
       d2.artifact_id AS decision_b, d2.description AS desc_b,
       d1.codebase_id AS codebase_a, d2.codebase_id AS codebase_b
```

### 7.5 Status and Dashboard Queries

#### Project status overview

```cypher
MATCH (p:Project {org_id: $org_id, artifact_id: $project_id})
OPTIONAL MATCH (p)-[:HAS_PHASE]->(ph:Phase)
OPTIONAL MATCH (ph)-[:HAS_WORK_ITEM]->(wi:WorkItem)
RETURN p.name AS project_name, p.status AS project_status,
       ph.artifact_id AS phase_id, ph.name AS phase_name, ph.status AS phase_status,
       count(wi) AS total_work_items,
       count(CASE WHEN wi.status = 'done' THEN 1 END) AS completed_work_items
ORDER BY ph.artifact_id
```

#### Organization-wide work item status

```cypher
MATCH (wi:WorkItem {org_id: $org_id})
RETURN wi.status AS status, count(wi) AS count
ORDER BY count DESC
```

---

## 8. Migration Mapping

This section maps the current SQLite schema to the Neo4j schema for the migration tool (WI-549).

### 8.1 Node Table Mapping

| SQLite Table | Neo4j Label | Property Mapping |
|---|---|---|
| `nodes` (base) | (label from `type` column) | `id` -> `artifact_id`, `type` -> label, `file_path` -> `file_path`, etc. |
| `work_items` | `:WorkItem` | All columns become properties; JSON columns (`scope`, `depends`, `blocks`, `criteria`) parsed to native lists |
| `findings` | `:Finding` | All columns become properties |
| `domain_policies` | `:DomainPolicy` | `derived_from` JSON -> list property or `DERIVED_FROM` edges |
| `domain_decisions` | `:DomainDecision` | All columns become properties |
| `domain_questions` | `:DomainQuestion` | All columns become properties |
| `guiding_principles` | `:GuidingPrinciple` | All columns become properties |
| `constraints` | `:Constraint` | All columns become properties |
| `module_specs` | `:ModuleSpec` | JSON columns (`provides`, `requires`, `boundary_rules`) parsed to native lists |
| `research_findings` | `:ResearchFinding` | `sources` JSON -> native list |
| `journal_entries` | `:JournalEntry` | All columns become properties |
| `metrics_events` | `:MetricsEvent` | All columns become properties |
| `document_artifacts` | `:Document` | `type` from nodes table -> `doc_type` property |
| `interview_questions` | `:InterviewQuestion` | All columns become properties |
| `proxy_human_decisions` | `:ProxyHumanDecision` | `triggered_by` JSON -> `TRIGGERED_BY` edges |
| `projects` | `:Project` | `scope_boundary` JSON -> `scope_in`/`scope_out` lists; `horizon` JSON -> `horizon_current`/`horizon_next`/`horizon_later` |
| `phases` | `:Phase` | `work_items` JSON -> native list + `HAS_WORK_ITEM` edges |

### 8.2 Edge Table Mapping

| SQLite `edge_type` | Neo4j Relationship | Default Weight |
|---|---|---|
| `depends_on` | `DEPENDS_ON` | 1.0 |
| `blocks` | `BLOCKS` | 0.3 |
| `belongs_to_module` | `BELONGS_TO_MODULE` | 0.8 |
| `derived_from` | `DERIVED_FROM` | 0.8 |
| `relates_to` | `RELATES_TO` | 0.6 |
| `addressed_by` | `ADDRESSED_BY` | 0.6 |
| `references` | `REFERENCES` | 0.4 |
| `amended_by` | `AMENDED_BY` | 0.5 |
| `supersedes` | `SUPERSEDES` | 0.5 |
| `triggered_by` | `TRIGGERED_BY` | 0.6 |
| `governed_by` | `GOVERNED_BY` | 0.8 |
| `informed_by` | `INFORMED_BY` | 0.6 |
| `belongs_to_project` | `BELONGS_TO_PROJECT` | 1.0 |
| `belongs_to_phase` | `BELONGS_TO_PHASE` | 1.0 |

> **Note:** The `belongs_to_domain` edge type is not migrated as a Neo4j relationship — domain is stored as a node property. See Section 9.

### 8.3 Migration Additions

During migration from a local `.ideate/` directory, the migration tool creates:

1. An `Organization` node (from user config or CLI prompt)
2. A `Codebase` node (from the repo URL or directory path)
3. `OWNS_CODEBASE` and `OWNS_PROJECT` relationships
4. `HAS_PHASE` relationships (derived from `belongs_to_project` edges)
5. `HAS_WORK_ITEM` relationships (derived from `belongs_to_phase` edges)
6. `OWNS_KNOWLEDGE` relationships for domain-level artifacts without project scoping
7. `artifact_uid` synthetic keys on all artifact nodes
8. `weight` properties on all relationships (using default weight table)

---

## 9. Domain Node Strategy

In the current SQLite model, `BELONGS_TO_DOMAIN` edges target a domain name string (e.g., `"workflow"`, `"agent-system"`), not an artifact node. Two strategies for Neo4j:

**Chosen approach: Domain as a property, not a node.** The `domain` field remains a property on knowledge nodes (DomainPolicy, DomainDecision, DomainQuestion, WorkItem). The `BELONGS_TO_DOMAIN` relationship type is replaced by a property-based lookup:

```cypher
// Find all artifacts in a domain
MATCH (n {org_id: $org_id, domain: $domain_name})
RETURN n
```

This avoids creating virtual "domain hub" nodes that have no properties beyond a name and would become high-degree hubs that distort PPR scores.

If domain-as-node becomes necessary later (e.g., domain metadata, cross-org domain sharing), a `Domain` label can be added without migration by creating domain nodes and converting the property-based lookups to relationship traversals.

---

## 10. Schema Initialization Script

Complete Cypher script to initialize the Neo4j schema from scratch:

```cypher
// ============================================
// Ideate Knowledge Graph — Schema Initialization
// ============================================

// --- Uniqueness constraints ---
CREATE CONSTRAINT org_id_unique IF NOT EXISTS
  FOR (o:Organization) REQUIRE o.org_id IS UNIQUE;
CREATE CONSTRAINT org_slug_unique IF NOT EXISTS
  FOR (o:Organization) REQUIRE o.slug IS UNIQUE;
CREATE CONSTRAINT codebase_id_unique IF NOT EXISTS
  FOR (c:Codebase) REQUIRE c.codebase_id IS UNIQUE;

CREATE CONSTRAINT project_uid_unique IF NOT EXISTS
  FOR (n:Project) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT phase_uid_unique IF NOT EXISTS
  FOR (n:Phase) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT work_item_uid_unique IF NOT EXISTS
  FOR (n:WorkItem) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT finding_uid_unique IF NOT EXISTS
  FOR (n:Finding) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT guiding_principle_uid_unique IF NOT EXISTS
  FOR (n:GuidingPrinciple) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT domain_policy_uid_unique IF NOT EXISTS
  FOR (n:DomainPolicy) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT domain_decision_uid_unique IF NOT EXISTS
  FOR (n:DomainDecision) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT domain_question_uid_unique IF NOT EXISTS
  FOR (n:DomainQuestion) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT constraint_uid_unique IF NOT EXISTS
  FOR (n:Constraint) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT module_spec_uid_unique IF NOT EXISTS
  FOR (n:ModuleSpec) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT research_finding_uid_unique IF NOT EXISTS
  FOR (n:ResearchFinding) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT journal_entry_uid_unique IF NOT EXISTS
  FOR (n:JournalEntry) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT metrics_event_uid_unique IF NOT EXISTS
  FOR (n:MetricsEvent) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT document_uid_unique IF NOT EXISTS
  FOR (n:Document) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT interview_question_uid_unique IF NOT EXISTS
  FOR (n:InterviewQuestion) REQUIRE n.artifact_uid IS UNIQUE;
CREATE CONSTRAINT proxy_human_decision_uid_unique IF NOT EXISTS
  FOR (n:ProxyHumanDecision) REQUIRE n.artifact_uid IS UNIQUE;

// --- Composite indexes for tenant-scoped queries ---
CREATE INDEX work_item_org_codebase IF NOT EXISTS
  FOR (n:WorkItem) ON (n.org_id, n.codebase_id);
CREATE INDEX phase_org_codebase IF NOT EXISTS
  FOR (n:Phase) ON (n.org_id, n.codebase_id);
CREATE INDEX project_org_codebase IF NOT EXISTS
  FOR (n:Project) ON (n.org_id, n.codebase_id);
CREATE INDEX finding_org_codebase IF NOT EXISTS
  FOR (n:Finding) ON (n.org_id, n.codebase_id);
CREATE INDEX document_org_codebase IF NOT EXISTS
  FOR (n:Document) ON (n.org_id, n.codebase_id);

// --- Domain-scoped indexes ---
CREATE INDEX domain_policy_domain IF NOT EXISTS
  FOR (n:DomainPolicy) ON (n.org_id, n.domain);
CREATE INDEX domain_decision_domain IF NOT EXISTS
  FOR (n:DomainDecision) ON (n.org_id, n.domain);
CREATE INDEX domain_question_domain IF NOT EXISTS
  FOR (n:DomainQuestion) ON (n.org_id, n.domain);
CREATE INDEX work_item_domain IF NOT EXISTS
  FOR (n:WorkItem) ON (n.org_id, n.domain);

// --- Status indexes ---
CREATE INDEX work_item_status IF NOT EXISTS
  FOR (n:WorkItem) ON (n.org_id, n.status);
CREATE INDEX phase_status IF NOT EXISTS
  FOR (n:Phase) ON (n.org_id, n.status);
CREATE INDEX project_status IF NOT EXISTS
  FOR (n:Project) ON (n.org_id, n.status);

// --- Cycle indexes ---
CREATE INDEX finding_cycle IF NOT EXISTS
  FOR (n:Finding) ON (n.org_id, n.cycle);
CREATE INDEX domain_decision_cycle IF NOT EXISTS
  FOR (n:DomainDecision) ON (n.org_id, n.cycle);

// --- Content hash indexes ---
CREATE INDEX work_item_hash IF NOT EXISTS
  FOR (n:WorkItem) ON (n.content_hash);
CREATE INDEX document_hash IF NOT EXISTS
  FOR (n:Document) ON (n.content_hash);

// --- Lookup indexes ---
CREATE INDEX interview_question_interview IF NOT EXISTS
  FOR (n:InterviewQuestion) ON (n.interview_id);
CREATE INDEX document_type IF NOT EXISTS
  FOR (n:Document) ON (n.org_id, n.doc_type);

// --- Full-text search ---
CREATE FULLTEXT INDEX artifact_text_search IF NOT EXISTS
  FOR (n:WorkItem|DomainPolicy|DomainDecision|DomainQuestion|GuidingPrinciple|Finding|Document)
  ON EACH [n.title, n.description, n.content];
```

---

## 11. Graph Visualization

```
                    ┌──────────────┐
                    │ Organization │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────────┐
              │            │                │
        OWNS_CODEBASE  OWNS_PROJECT   OWNS_KNOWLEDGE
              │            │                │
              v            v                v
         ┌─────────┐  ┌─────────┐    ┌───────────────┐
         │Codebase │  │ Project │    │GuidingPrinciple│
         └─────────┘  └────┬────┘    │DomainPolicy    │
              ^             │         │DomainDecision  │
              │        HAS_PHASE      │Constraint      │
    REFERENCES_CODEBASE     │         └───────┬────────┘
              │             v                 ^
              │        ┌─────────┐            │
              └────────│  Phase  │       PROMOTED_TO
                       └────┬────┘            │
                            │                 │
                     HAS_WORK_ITEM     ┌──────┴──────┐
                            │          │Project-scope│
                            v          │  knowledge  │
                       ┌──────────┐    └─────────────┘
                       │ WorkItem │
                       └────┬─────┘
                            │
              ┌─────────────┼──────────────┐
              │             │              │
         DEPENDS_ON    GOVERNED_BY    INFORMED_BY
              │             │              │
              v             v              v
         ┌──────────┐  ┌──────────┐  ┌──────────────┐
         │ WorkItem │  │ Policy/  │  │ Decision/    │
         │ (other)  │  │Principle │  │ Research     │
         └──────────┘  └──────────┘  └──────────────┘
```
