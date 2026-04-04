# YAML-to-Neo4j Migration and Merge Tool

> Implementation specification for the ideate-server migration CLI.
> Reads local `.ideate/` directories (YAML artifacts) and writes to Neo4j via the server's service layer.
> Companion to: `neo4j-schema.md` (WI-544), `steering.md` (platform vision).
> Produced for WI-549 (2026-04-01).

---

## 1. Purpose

The migration tool bridges the gap between the local plugin (YAML + SQLite) and the remote backend (Neo4j). It is the first mechanism for populating the Neo4j graph with real data and is on the critical path for dogfooding the remote backend.

### Primary Use Cases

1. **Initial migration**: Import a single `.ideate/` directory into a fresh Neo4j graph.
2. **Multi-repo merge**: Import multiple `.ideate/` directories (e.g., `ideate/.ideate/` and `ideate-server/.ideate/`) into a single graph under one Organization, each scoped to its own Codebase node.
3. **Incremental sync**: Re-import a previously imported `.ideate/` directory without creating duplicates. Only changed or new artifacts are written.
4. **Validation**: Dry-run mode that parses and transforms without writing, reporting what would change.

### Dogfooding Scenario

The first real use: import `ideate/.ideate/` and `ideate-server/.ideate/` into a single Neo4j graph. Each import creates a Codebase node and scopes its artifacts under it. Both belong to the same Organization. The merged graph should allow PPR traversal across both codebases.

---

## 2. Data Flow

```
                                    ┌─────────────────┐
                                    │   CLI Arguments  │
                                    │  --org-id        │
                                    │  --codebase-name │
                                    │  --repo-url      │
                                    │  --ideate-dir    │
                                    └────────┬────────┘
                                             │
                                             v
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 1: DISCOVERY                                                  │
│                                                                      │
│  Walk .ideate/ directory tree                                        │
│  Collect all *.yaml / *.yml files                                    │
│  Group by subdirectory (type hint)                                   │
│  Report: file count per subdirectory                                 │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   v
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 2: PARSE                                                      │
│                                                                      │
│  For each YAML file:                                                 │
│    1. Read file content                                              │
│    2. Parse YAML (reuse safeParseYaml pattern from indexer.ts)       │
│    3. Validate: must have `id` and `type` fields                     │
│    4. Compute content_hash (reuse computeArtifactHash from           │
│       db-helpers.ts)                                                 │
│    5. Extract edges (reuse EDGE_TYPE_REGISTRY-driven logic           │
│       from indexer.ts extractEdges)                                  │
│    6. Extract file refs (for work_items with scope)                  │
│    7. Collect parse errors (continue on error, don't abort)          │
│                                                                      │
│  Output: ParsedArtifact[] + ParsedEdge[] + ParseError[]              │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   v
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 3: TRANSFORM                                                  │
│                                                                      │
│  For each ParsedArtifact:                                            │
│    1. Map YAML type -> Neo4j label (TYPE_TO_LABEL_MAP)               │
│    2. Map YAML fields -> Neo4j node properties                       │
│       - Deserialize JSON-encoded arrays to native lists              │
│       - Flatten nested objects (scope_boundary -> scope_in/scope_out)│
│       - Add tenant fields: org_id, codebase_id                      │
│       - Compute artifact_uid = "{org_id}:{codebase_id}:{artifact_id}│
│       - Add timestamps: created_at, updated_at                      │
│    3. For document types: set doc_type from original YAML type       │
│                                                                      │
│  For each ParsedEdge:                                                │
│    1. Map edge_type -> Neo4j relationship type (UPPER_SNAKE_CASE)    │
│    2. Resolve source/target artifact_uid compound keys               │
│    3. Assign default weight from weight table                        │
│    4. Add relationship properties: weight, created_at, source        │
│                                                                      │
│  Generate containment edges:                                         │
│    - OWNS_CODEBASE (org -> codebase)                                 │
│    - OWNS_PROJECT (org -> each project)                              │
│    - HAS_PHASE (project -> phase, derived from belongs_to_project)   │
│    - HAS_WORK_ITEM (phase -> work_item, derived from                │
│      belongs_to_phase)                                               │
│    - OWNS_KNOWLEDGE (org -> knowledge artifacts without project      │
│      scoping)                                                        │
│    - REFERENCES_CODEBASE (project -> codebase)                       │
│                                                                      │
│  Output: Neo4jNode[] + Neo4jRelationship[]                           │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   v
┌──────────────────────────────────────────────────────────────────────┐
│  Phase 4: WRITE (or DRY-RUN report)                                  │
│                                                                      │
│  If --dry-run:                                                       │
│    Print summary of what would be written (counts by label/type)     │
│    Print any validation warnings                                     │
│    Exit 0                                                            │
│                                                                      │
│  Otherwise:                                                          │
│    1. Ensure Organization node exists (MERGE by org_id)              │
│    2. Ensure Codebase node exists (MERGE by codebase_id)             │
│    3. Ensure OWNS_CODEBASE relationship exists                       │
│    4. Batch-upsert artifact nodes (MERGE by artifact_uid)            │
│       - On create: set all properties                                │
│       - On match: update changed properties (content_hash mismatch) │
│    5. Batch-upsert relationships (MERGE by source+target+type)       │
│       - Set weight and properties                                    │
│    6. Create containment relationships                               │
│    7. Report: created, updated, skipped, failed counts               │
│                                                                      │
│  Batching: 100 nodes per transaction, 200 edges per transaction      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 3. Import Format

### 3.1 Input Directory Structure

The tool reads a standard `.ideate/` directory as defined by `IDEATE_SUBDIRS` in `config.ts`:

```
.ideate/
  config.json              # Read for project_name, ppr config
  plan/                    # architecture.yaml, overview.yaml, execution-strategy.yaml
  steering/                # guiding-principles.yaml, constraints.yaml
  work-items/              # WI-{NNN}.yaml
  principles/              # GP-{NN}.yaml
  constraints/             # C-{NN}.yaml
  policies/                # P-{NN}.yaml
  decisions/               # D-{NN}.yaml
  questions/               # Q-{NN}.yaml
  modules/                 # Module specs
  research/                # RF-*.yaml
  interviews/              # Grouped by cycle: refine-{NNN}/
  cycles/                  # {NNN}/ per cycle (findings, journal entries, summaries)
  domains/                 # Domain index files
  metrics/                 # Metrics events
  projects/                # PR-{NNN}.yaml
  phases/                  # PH-{NNN}.yaml
```

### 3.2 File Discovery

The tool walks the entire `.ideate/` directory tree recursively, collecting all files with `.yaml` or `.yml` extensions. This matches the `walkDir` function in `indexer.ts`. Files outside YAML extensions are ignored.

### 3.3 YAML Parsing

Each file is parsed using the same `yaml` library (`parse` from the `yaml` npm package) and the same error-tolerant pattern as `indexer.ts`:

```typescript
interface ParsedArtifact {
  filePath: string;           // relative to .ideate/
  id: string;                 // from doc.id
  type: string;               // from doc.type
  contentHash: string;        // SHA-256 of content fields (same as computeArtifactHash)
  rawDoc: Record<string, unknown>;  // full parsed YAML
  tokenCount: number;         // rough estimate: content.length / 4
}

interface ParseError {
  filePath: string;
  error: string;              // human-readable error message
  phase: 'read' | 'parse' | 'validate' | 'transform';
}
```

**Validation rules** (applied per file):

1. File must parse as valid YAML (not null, must be an object).
2. Document must have an `id` field (string). If missing, the file path is used as a fallback ID.
3. Document must have a `type` field (string). If missing, the file is skipped with an error.
4. The `type` field must map to a known Neo4j label (see Section 4). Unknown types are skipped with a warning.

Files that fail validation are logged and counted but do not abort the migration. The tool processes all valid files and reports errors at the end.

### 3.4 Interview Entry Expansion

Interview files (`type: "interview"`) with an `entries` array are expanded into individual `InterviewQuestion` nodes, matching the logic in `indexer.ts` lines 564-596. Each entry becomes a separate node with a `REFERENCES` edge back to the parent interview Document node.

---

## 4. Node Mapping

### 4.1 YAML Type to Neo4j Label

This table maps the `type` field from YAML artifacts to Neo4j node labels. It covers all 27 YAML types from `TYPE_TO_EXTENSION_TABLE` in `db.ts`.

| YAML `type` value | Neo4j Label | Notes |
|---|---|---|
| `work_item` | `WorkItem` | |
| `finding` | `Finding` | |
| `domain_policy` | `DomainPolicy` | |
| `domain_decision` | `DomainDecision` | |
| `domain_question` | `DomainQuestion` | |
| `guiding_principle` | `GuidingPrinciple` | |
| `constraint` | `Constraint` | |
| `module_spec` | `ModuleSpec` | |
| `research_finding` | `ResearchFinding` | |
| `journal_entry` | `JournalEntry` | |
| `metrics_event` | `MetricsEvent` | |
| `interview_question` | `InterviewQuestion` | |
| `proxy_human_decision` | `ProxyHumanDecision` | |
| `project` | `Project` | |
| `phase` | `Phase` | |
| `decision_log` | `Document` | `doc_type: "decision_log"` |
| `cycle_summary` | `Document` | `doc_type: "cycle_summary"` |
| `review_output` | `Document` | `doc_type: "review_output"` |
| `review_manifest` | `Document` | `doc_type: "review_manifest"` |
| `architecture` | `Document` | `doc_type: "architecture"` |
| `overview` | `Document` | `doc_type: "overview"` |
| `execution_strategy` | `Document` | `doc_type: "execution_strategy"` |
| `guiding_principles` | `Document` | `doc_type: "guiding_principles"` |
| `constraints` | `Document` | `doc_type: "constraints"` |
| `research` | `Document` | `doc_type: "research"` |
| `interview` | `Document` | `doc_type: "interview"` |
| `domain_index` | `Document` | `doc_type: "domain_index"` |

Implementation:

```typescript
const TYPE_TO_LABEL_MAP: Record<string, string> = {
  work_item:          'WorkItem',
  finding:            'Finding',
  domain_policy:      'DomainPolicy',
  domain_decision:    'DomainDecision',
  domain_question:    'DomainQuestion',
  guiding_principle:  'GuidingPrinciple',
  constraint:         'Constraint',
  module_spec:        'ModuleSpec',
  research_finding:   'ResearchFinding',
  journal_entry:      'JournalEntry',
  metrics_event:      'MetricsEvent',
  interview_question: 'InterviewQuestion',
  proxy_human_decision: 'ProxyHumanDecision',
  project:            'Project',
  phase:              'Phase',
  // Document subtypes
  decision_log:       'Document',
  cycle_summary:      'Document',
  review_output:      'Document',
  review_manifest:    'Document',
  architecture:       'Document',
  overview:           'Document',
  execution_strategy: 'Document',
  guiding_principles: 'Document',
  constraints:        'Document',
  research:           'Document',
  interview:          'Document',
  domain_index:       'Document',
};

// Document subtypes that need doc_type property
const DOCUMENT_SUBTYPES = new Set([
  'decision_log', 'cycle_summary', 'review_output', 'review_manifest',
  'architecture', 'overview', 'execution_strategy', 'guiding_principles',
  'constraints', 'research', 'interview', 'domain_index',
]);
```

### 4.2 Property Mapping by Label

Each label has specific property transformations. The common properties (`artifact_id`, `org_id`, `codebase_id`, `artifact_uid`, `content_hash`, `token_count`, `file_path`, `status`, `cycle_created`, `cycle_modified`, `created_at`, `updated_at`) are added to every node.

#### WorkItem

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `title` | `title` | Direct |
| `complexity` | `complexity` | Direct |
| `scope` | `scope` | Keep as JSON string (array of `{path, op}` objects) |
| `depends` | -- | Extracted as `DEPENDS_ON` edges, not stored as property |
| `blocks` | -- | Extracted as `BLOCKS` edges, not stored as property |
| `criteria` | `criteria` | JSON array -> native String[] list |
| `module` | -- | Extracted as `BELONGS_TO_MODULE` edge |
| `domain` | `domain` | Direct (property-based domain strategy) |
| `phase` | -- | Extracted as `BELONGS_TO_PHASE` edge |
| `notes` | `notes` | Direct |
| `work_item_type` | `work_item_type` | Direct |

#### Project

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `name` | `name` | Direct |
| `description` | `description` | Direct |
| `intent` | `intent` | Direct |
| `scope_boundary` | `scope_in`, `scope_out` | JSON `{in: [], out: []}` -> two native String[] lists |
| `success_criteria` | `success_criteria` | JSON array -> native String[] list |
| `appetite` | `appetite` | Direct |
| `steering` | `steering` | Direct |
| `horizon` | `horizon_current`, `horizon_next`, `horizon_later` | JSON `{current, next, later}` -> three properties |
| `status` | `status` | Direct |

#### Phase

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `name` | `name` | Direct |
| `description` | `description` | Direct |
| `project` | -- | Extracted as `BELONGS_TO_PROJECT` edge + `HAS_PHASE` containment |
| `phase_type` | `phase_type` | Direct |
| `intent` | `intent` | Direct |
| `steering` | `steering` | Direct |
| `status` | `status` | Direct |
| `work_items` | `work_items` | JSON array -> native String[] list; also generates `HAS_WORK_ITEM` edges |

#### Finding

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `severity` | `severity` | Direct |
| `work_item` | -- | Extracted as `RELATES_TO` edge |
| `file_refs` | `file_refs` | Keep as JSON string |
| `verdict` | `verdict` | Direct |
| `cycle` | `cycle` | Direct |
| `reviewer` | `reviewer` | Direct |
| `description` | `description` | Direct |
| `suggestion` | `suggestion` | Direct |
| `addressed_by` | -- | Extracted as `ADDRESSED_BY` edge |

#### DomainPolicy

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `domain` | `domain` | Direct |
| `derived_from` | -- | Extracted as `DERIVED_FROM` edges |
| `established` | `established` | Direct |
| `amended` | `amended` | Direct |
| `amended_by` | -- | Extracted as `AMENDED_BY` edge |
| `description` | `description` | Direct |

#### DomainDecision

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `domain` | `domain` | Direct |
| `cycle` | `cycle` | Direct |
| `supersedes` | -- | Extracted as `SUPERSEDES` edge |
| `description` | `description` | Direct |
| `rationale` | `rationale` | Direct |

#### DomainQuestion

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `domain` | `domain` | Direct |
| `impact` | `impact` | Direct |
| `source` | `source` | Direct |
| `resolution` | `resolution` | Direct |
| `resolved_in` | `resolved_in` | Direct |
| `description` | `description` | Direct |
| `addressed_by` | -- | Extracted as `ADDRESSED_BY` edge |

#### GuidingPrinciple

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `name` | `name` | Direct |
| `description` | `description` | Direct |
| `amendment_history` | `amendment_history` | Keep as JSON string |

#### Constraint

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `category` | `category` | Direct |
| `description` | `description` | Direct |

#### ModuleSpec

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `name` | `name` | Direct |
| `scope` | `scope` | Direct |
| `provides` | `provides` | JSON array -> native String[] list |
| `requires` | `requires` | JSON array -> native String[] list |
| `boundary_rules` | `boundary_rules` | JSON array -> native String[] list |

#### ResearchFinding

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `topic` | `topic` | Direct |
| `date` | `date` | Direct |
| `content` | `content` | Direct |
| `sources` | `sources` | JSON array -> native String[] list |

#### JournalEntry

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `phase` | `phase` | Direct |
| `date` | `date` | Direct |
| `title` | `title` | Direct |
| `work_item` | -- | Extracted as `RELATES_TO` edge (if present) |
| `content` | `content` | Direct |

#### MetricsEvent

All fields mapped directly. `payload` kept as JSON string. Numeric fields (`input_tokens`, `output_tokens`, etc.) mapped as Integer.

#### Document (12 subtypes)

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `type` (original) | `doc_type` | YAML type value becomes the discriminator |
| `title` | `title` | Direct |
| `cycle` | `cycle` | Direct |
| `content` | `content` | Direct |

#### InterviewQuestion

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `interview_id` | `interview_id` | Direct |
| `question` | `question` | Direct |
| `answer` | `answer` | Direct |
| `domain` | `domain` | Direct |
| `seq` | `seq` | Direct |

#### ProxyHumanDecision

| YAML Field | Neo4j Property | Transformation |
|---|---|---|
| `cycle` | `cycle` | Direct |
| `trigger` | `trigger` | Direct |
| `triggered_by` | -- | Extracted as `TRIGGERED_BY` edges |
| `decision` | `decision` | Direct |
| `rationale` | `rationale` | Direct |
| `timestamp` | `timestamp` | Direct |
| `status` | `status` | Direct |

### 4.3 JSON-to-Native Transformations

Several YAML fields are stored as JSON strings in SQLite but should become native Neo4j types:

| Field | Source Format | Target Format |
|---|---|---|
| `criteria` (WorkItem) | JSON `string[]` | Neo4j `String[]` |
| `success_criteria` (Project) | JSON `string[]` | Neo4j `String[]` |
| `scope_boundary` (Project) | JSON `{in: string[], out: string[]}` | Two properties: `scope_in: String[]`, `scope_out: String[]` |
| `horizon` (Project) | JSON `{current, next, later}` | Three properties: `horizon_current`, `horizon_next: String[]`, `horizon_later: String[]` |
| `provides`, `requires`, `boundary_rules` (ModuleSpec) | JSON `string[]` | Neo4j `String[]` |
| `sources` (ResearchFinding) | JSON `string[]` | Neo4j `String[]` |
| `work_items` (Phase) | JSON `string[]` | Neo4j `String[]` |

Implementation helper:

```typescript
function parseJsonList(val: unknown): string[] | null {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val.map(String);
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* not JSON */ }
  }
  return null;
}
```

---

## 5. Edge Mapping

### 5.1 EDGE_TYPE_REGISTRY to Neo4j Relationships

Each entry in `EDGE_TYPE_REGISTRY` (from `schema.ts`) maps to a Neo4j relationship type. Edge extraction follows the same registry-driven logic as `extractEdges` in `indexer.ts`.

| SQLite `edge_type` | Neo4j Relationship | YAML Field | Default Weight | Category |
|---|---|---|---|---|
| `depends_on` | `DEPENDS_ON` | `depends` | 1.0 | Structural |
| `blocks` | `BLOCKS` | `blocks` | 0.3 | Structural |
| `belongs_to_module` | `BELONGS_TO_MODULE` | `module` | 0.8 | Structural |
| `belongs_to_domain` | -- | `domain` | -- | See Section 9 of neo4j-schema.md: domain is a property, not a relationship |
| `derived_from` | `DERIVED_FROM` | `derived_from` | 0.8 | Knowledge |
| `relates_to` | `RELATES_TO` | `work_item` | 0.6 | Knowledge |
| `addressed_by` | `ADDRESSED_BY` | `addressed_by` | 0.6 | Knowledge |
| `references` | `REFERENCES` | (explicit) | 0.4 | Cross-cutting |
| `amended_by` | `AMENDED_BY` | `amended_by` | 0.5 | Knowledge |
| `supersedes` | `SUPERSEDES` | `supersedes` | 0.5 | Knowledge |
| `triggered_by` | `TRIGGERED_BY` | `triggered_by` | 0.6 | Knowledge |
| `governed_by` | `GOVERNED_BY` | `governed_by` | 0.8 | Knowledge |
| `informed_by` | `INFORMED_BY` | `informed_by` | 0.6 | Knowledge |
| `belongs_to_project` | `BELONGS_TO_PROJECT` | `project` | 1.0 | Structural |
| `belongs_to_phase` | `BELONGS_TO_PHASE` | `phase` | 1.0 | Structural |

### 5.2 Domain Edge Handling

Per Section 9 of `neo4j-schema.md`, the `BELONGS_TO_DOMAIN` edge type is **not** migrated as a relationship. Instead, the `domain` field remains a property on the node. The migration tool:

1. Skips `belongs_to_domain` when generating relationships.
2. Preserves the `domain` property on DomainPolicy, DomainDecision, DomainQuestion, and WorkItem nodes.

### 5.3 Containment Edge Generation

The migration tool generates containment relationships that do not exist in the YAML source but are required by the Neo4j multi-tenant model:

| Relationship | Generated From | Logic |
|---|---|---|
| `OWNS_CODEBASE` | CLI arguments | `(org) -[:OWNS_CODEBASE]-> (codebase)` |
| `OWNS_PROJECT` | Each `Project` artifact | `(org) -[:OWNS_PROJECT]-> (project)` |
| `HAS_PHASE` | `belongs_to_project` edges | Inverted: if Phase has `project: PR-001`, create `(PR-001) -[:HAS_PHASE]-> (Phase)` |
| `HAS_WORK_ITEM` | `belongs_to_phase` edges | Inverted: if WorkItem has `phase: PH-001`, create `(PH-001) -[:HAS_WORK_ITEM]-> (WorkItem)` |
| `OWNS_KNOWLEDGE` | Knowledge artifacts | GuidingPrinciple, DomainPolicy, DomainDecision, Constraint without project scoping get `(org) -[:OWNS_KNOWLEDGE]-> (artifact)` |
| `REFERENCES_CODEBASE` | Each `Project` artifact | `(project) -[:REFERENCES_CODEBASE]-> (codebase)` for the codebase being imported |

### 5.4 Relationship Properties

All relationships created by the migration tool carry:

```typescript
interface RelationshipProperties {
  weight: number;       // Default from weight table (Section 5.1)
  created_at: DateTime; // Server timestamp at import time
  source: string;       // "yaml_field" for EDGE_TYPE_REGISTRY edges,
                        // "migration" for generated containment edges
}
```

### 5.5 Edge Target Resolution

Edges in the YAML source reference targets by local artifact ID (e.g., `WI-044`, `GP-01`). The migration tool resolves these to `artifact_uid` compound keys:

1. Build a lookup map: `local_id -> artifact_uid` for all artifacts in the current import batch.
2. For each edge, resolve both source and target to their `artifact_uid`.
3. If a target ID cannot be resolved within the current import batch (e.g., it references an artifact in another codebase), log a warning and create the edge anyway with a best-effort `artifact_uid` using the current codebase scope. The edge may need manual correction after multi-repo merge.

```typescript
function resolveArtifactUid(
  localId: string,
  orgId: string,
  codebaseId: string,
  lookupMap: Map<string, string>  // localId -> artifact_uid
): string {
  return lookupMap.get(localId) ?? `${orgId}:${codebaseId}:${localId}`;
}
```

---

## 6. Merge Semantics

### 6.1 Multi-Codebase Merge Model

Multiple `.ideate/` directories combine into one graph by creating separate Codebase nodes under the same Organization:

```
Organization (org_id: "ideate-dev")
  |-- OWNS_CODEBASE --> Codebase (name: "ideate", repo_url: "github.com/org/ideate")
  |                       |-- artifacts from ideate/.ideate/
  |
  |-- OWNS_CODEBASE --> Codebase (name: "ideate-server", repo_url: "github.com/org/ideate-server")
  |                       |-- artifacts from ideate-server/.ideate/
  |
  |-- OWNS_PROJECT --> Project (PR-001, from ideate)
  |-- OWNS_PROJECT --> Project (PR-001, from ideate-server)  // same local ID, different codebase
  |
  |-- OWNS_KNOWLEDGE --> promoted knowledge artifacts
```

### 6.2 Artifact ID Uniqueness

Artifact IDs (e.g., `WI-001`, `GP-01`) are only unique within a codebase. The compound key `(org_id, codebase_id, artifact_id)` provides global uniqueness.

**No renumbering is needed.** Two codebases can both have `WI-001` without conflict because the `artifact_uid` is different:

- `ideate-dev:codebase-ideate:WI-001`
- `ideate-dev:codebase-server:WI-001`

### 6.3 Conflict Resolution

| Conflict Type | Resolution |
|---|---|
| **Duplicate artifact_uid** (same org + codebase + artifact_id) | MERGE semantics: upsert. The existing node is updated if content_hash differs. |
| **Same local ID, different codebases** | No conflict. Different artifact_uid values. |
| **Organization node already exists** | MERGE by org_id. Properties updated only if explicitly provided. |
| **Codebase node already exists** | MERGE by codebase_id. Properties updated only if explicitly provided. |
| **Relationship already exists** | MERGE by (source_uid, target_uid, type). Weight updated to latest import value. |
| **Cross-codebase edge target not found** | Warning logged. Edge created with best-effort target_uid. Neo4j allows dangling references (no FK enforcement). |

### 6.4 Import Order Independence

The merge is designed to work regardless of import order. Importing `ideate/` then `ideate-server/` produces the same graph as importing in reverse order. This is guaranteed by:

1. MERGE-based writes (idempotent create-or-update).
2. `artifact_uid` compound keys that are deterministic from input data.
3. Content-hash-based change detection that skips unchanged nodes.

### 6.5 Cross-Codebase Edges

During initial migration, edges are scoped within a single codebase. Cross-codebase relationships (`CROSS_REFERENCES`, `SIMILAR_TO`) are not created automatically by the migration tool. They are created later by:

1. Automated analysis (embedding-based similarity detection).
2. Manual user action through the portal or API.
3. Knowledge promotion (`PROMOTED_TO` edges).

---

## 7. Org/Codebase/Project Assignment

### 7.1 Organization Resolution

The user provides organization identity through CLI arguments or a config file:

```bash
# Option A: org already exists (use org_id)
ideate-migrate --org-id "org-uuid-123" ...

# Option B: create new org
ideate-migrate --org-name "Ideate Dev" --org-slug "ideate-dev" ...
```

Logic:

1. If `--org-id` is provided, MERGE the Organization node by `org_id`. Update `name` and `slug` only if also provided.
2. If `--org-name` and `--org-slug` are provided without `--org-id`, generate a UUID for `org_id` and CREATE the Organization node.
3. If neither is provided, check the config file (`~/.ideate/migrate.yaml` or `--config` path).
4. If no org identity can be resolved, error and exit.

### 7.2 Codebase Creation

Each import creates or merges a Codebase node:

```bash
ideate-migrate \
  --codebase-name "ideate" \
  --repo-url "github.com/user/ideate" \
  --ideate-dir /path/to/ideate/.ideate
```

Logic:

1. If `--codebase-id` is provided, MERGE by `codebase_id`.
2. If `--codebase-name` is provided without `--codebase-id`, generate a UUID for `codebase_id` and use `--codebase-name` as the `name` property.
3. The `repo_url` and `local_path` are optional metadata on the Codebase node.
4. Set `org_id` on the Codebase node (denormalized for query convenience).
5. Create `OWNS_CODEBASE` relationship between Organization and Codebase.

### 7.3 Project Assignment

All `Project` artifacts found in the `.ideate/` directory are scoped to the codebase and linked to the Organization:

1. Each Project node gets `org_id` and `codebase_id` properties.
2. An `OWNS_PROJECT` relationship is created: `(org) -[:OWNS_PROJECT]-> (project)`.
3. A `REFERENCES_CODEBASE` relationship is created: `(project) -[:REFERENCES_CODEBASE]-> (codebase)`.

In the dogfooding scenario, `ideate/.ideate/` has `PR-001` (Platform Strategy) and `PR-002` (Adapter Refactor). After import, both projects reference the `ideate` codebase and belong to the `ideate-dev` organization.

### 7.4 Knowledge Promotion During Import

During initial migration, all knowledge artifacts (GuidingPrinciple, DomainPolicy, DomainDecision, Constraint) are created as codebase-scoped nodes. The `OWNS_KNOWLEDGE` relationship connects them to the Organization for org-wide visibility.

Knowledge promotion (`PROMOTED_TO` edges) is not performed automatically during migration. It is a post-migration activity performed through the portal or API.

---

## 8. Idempotency

### 8.1 Content-Hash-Based Dedup

Re-importing the same `.ideate/` directory does not create duplicates. The idempotency mechanism:

1. **Node dedup**: MERGE by `artifact_uid`. If a node with the same `artifact_uid` exists, check `content_hash`. If identical, skip the update. If different, update all properties.

2. **Relationship dedup**: MERGE by `(source_uid, target_uid, relationship_type)`. The UNIQUE constraint `(source_id, target_id, edge_type)` from the SQLite model is replicated by Cypher MERGE semantics.

3. **Content hash computation**: Uses the same `computeArtifactHash` function from `db-helpers.ts`. The hash is computed from YAML content fields, excluding `content_hash`, `token_count`, and `file_path`.

### 8.2 Change Detection Cypher

```cypher
// Check if node needs update (content hash comparison)
MATCH (n:WorkItem {artifact_uid: $artifact_uid})
WHERE n.content_hash = $content_hash
RETURN true AS up_to_date

// If no match (new or changed), MERGE with full property set
MERGE (n:WorkItem {artifact_uid: $artifact_uid})
ON CREATE SET
  n += $properties,
  n.created_at = datetime()
ON MATCH SET
  n += $changed_properties,
  n.updated_at = datetime()
```

### 8.3 Optimized Re-Import

For large `.ideate/` directories, the tool optimizes re-imports:

1. **Phase 0 (pre-check)**: Query all existing `artifact_uid` and `content_hash` pairs for the codebase being imported.
2. **Phase 1 (diff)**: Compare local content hashes against existing hashes. Partition artifacts into `new`, `changed`, `unchanged`.
3. **Phase 2 (write)**: Only write `new` and `changed` artifacts. Skip `unchanged` entirely (no Cypher executed).
4. **Phase 3 (report)**: Report counts for each category.

```typescript
interface ImportDiff {
  new: ParsedArtifact[];
  changed: ParsedArtifact[];
  unchanged: ParsedArtifact[];
}
```

### 8.4 Stale Node Handling

The migration tool does **not** automatically delete nodes that are no longer present in the `.ideate/` directory. Deletion is destructive and the source of truth may have legitimate reasons for removing a file (e.g., archival). Instead:

- A `--prune` flag enables deletion of nodes whose `artifact_uid` matches the current codebase but whose `artifact_id` is not found in the current import set.
- Without `--prune`, stale nodes remain in the graph. A separate `ideate-prune` command can clean them up with confirmation prompts.

---

## 9. CLI Interface

### 9.1 Command Syntax

```bash
ideate-migrate [options]

# Subcommands
ideate-migrate import   # Import a single .ideate/ directory
ideate-migrate status   # Show import status for a codebase
ideate-migrate prune    # Remove stale nodes for a codebase
```

### 9.2 Import Command

```bash
ideate-migrate import \
  --ideate-dir <path>        # Required. Path to .ideate/ directory
  --org-id <uuid>            # Organization ID (existing org)
  --org-name <string>        # Organization name (creates new org if --org-id not set)
  --org-slug <string>        # Organization slug (required with --org-name)
  --codebase-id <uuid>       # Codebase ID (existing codebase)
  --codebase-name <string>   # Codebase name (creates new if --codebase-id not set)
  --repo-url <string>        # Repository URL (optional metadata)
  --neo4j-uri <string>       # Neo4j connection URI (default: bolt://localhost:7687)
  --neo4j-user <string>      # Neo4j username (default: neo4j)
  --neo4j-password <string>  # Neo4j password (required)
  --config <path>            # Config file path (default: ~/.ideate/migrate.yaml)
  --dry-run                  # Parse and transform only, report what would be written
  --prune                    # Delete stale nodes not in current import set
  --batch-size <number>      # Nodes per transaction (default: 100)
  --verbose                  # Detailed progress output
  --quiet                    # Suppress all output except errors
  --json                     # Output results as JSON (for scripting)
```

### 9.3 Status Command

```bash
ideate-migrate status \
  --org-id <uuid>            # Required
  --codebase-id <uuid>       # Optional (shows all codebases if omitted)
  --neo4j-uri <string>
  --neo4j-user <string>
  --neo4j-password <string>
```

Output:

```
Organization: Ideate Dev (ideate-dev)
Codebases: 2

  ideate (github.com/user/ideate)
    Last imported: 2026-04-01T14:30:00Z
    Artifacts: 478
    Relationships: 1,247
    By type:
      WorkItem: 289
      Finding: 87
      DomainPolicy: 14
      ...

  ideate-server (github.com/user/ideate-server)
    Last imported: 2026-04-01T15:00:00Z
    Artifacts: 42
    ...
```

### 9.4 Config File Format

```yaml
# ~/.ideate/migrate.yaml

# Default connection settings
neo4j:
  uri: bolt://localhost:7687
  user: neo4j
  password: ${NEO4J_PASSWORD}    # Environment variable expansion

# Default organization
org:
  id: "org-uuid-123"
  name: "Ideate Dev"
  slug: "ideate-dev"

# Codebase aliases for quick import
codebases:
  ideate:
    id: "codebase-uuid-1"
    name: "ideate"
    repo_url: "github.com/user/ideate"
    ideate_dir: "/path/to/ideate/.ideate"

  ideate-server:
    id: "codebase-uuid-2"
    name: "ideate-server"
    repo_url: "github.com/user/ideate-server"
    ideate_dir: "/path/to/ideate-server/.ideate"

# Import settings
import:
  batch_size: 100
  prune: false
```

With a config file, the dogfooding import becomes:

```bash
# Import both codebases
ideate-migrate import --config ~/.ideate/migrate.yaml --codebase ideate
ideate-migrate import --config ~/.ideate/migrate.yaml --codebase ideate-server
```

### 9.5 Environment Variables

| Variable | CLI Equivalent | Notes |
|---|---|---|
| `NEO4J_URI` | `--neo4j-uri` | Connection URI |
| `NEO4J_USER` | `--neo4j-user` | Username |
| `NEO4J_PASSWORD` | `--neo4j-password` | Password (prefer env var over CLI for security) |
| `IDEATE_ORG_ID` | `--org-id` | Default organization |

Priority: CLI flag > environment variable > config file > default.

---

## 10. Error Handling

### 10.1 Error Categories

| Category | Severity | Behavior |
|---|---|---|
| **Connection failure** | Fatal | Retry with exponential backoff (3 attempts, 1s/2s/4s). Abort if all retries fail. |
| **Authentication failure** | Fatal | Abort immediately with clear error message. |
| **YAML parse error** | Warning | Skip file, log error, continue processing. |
| **Missing required field** | Warning | Skip file, log error, continue processing. |
| **Unknown artifact type** | Warning | Skip file, log warning, continue processing. |
| **Edge target not found** | Warning | Create edge with best-effort target_uid, log warning. |
| **Neo4j write failure** | Error | Retry the failed batch once. If retry fails, log all artifacts in the batch and continue with next batch. |
| **Constraint violation** | Error | Log the specific violation. Usually indicates a data integrity issue in the source YAML. |
| **Disk read error** | Warning | Skip file, log error, continue processing. |

### 10.2 Error Reporting

Errors are accumulated during the import and reported in a summary at the end:

```
Import Summary
==============
Source:    /path/to/ideate/.ideate
Codebase:  ideate (codebase-uuid-1)
Org:       Ideate Dev (org-uuid-123)

Files scanned:    482
Files parsed:     478
Files skipped:      4

Nodes created:    320
Nodes updated:    158
Nodes skipped:      0 (unchanged)

Edges created:  1,147
Edges updated:    100
Edges skipped:      0

Containment edges:
  OWNS_CODEBASE:        1
  OWNS_PROJECT:         2
  HAS_PHASE:           18
  HAS_WORK_ITEM:      289
  OWNS_KNOWLEDGE:      34
  REFERENCES_CODEBASE:  2

Warnings:
  [WARN] interviews/refine-003/INT-003-07.yaml: YAML parse error - unexpected end of stream
  [WARN] cycles/002/F-002-legacy.yaml: missing required field 'type'
  [WARN] edge target 'MOD-legacy' not found in current import set (referenced by WI-089)
  [WARN] edge target 'MOD-legacy' not found in current import set (referenced by WI-112)

Duration: 12.4s
```

### 10.3 Exit Codes

| Code | Meaning |
|---|---|
| 0 | Success (may include warnings) |
| 1 | Partial failure (some files or batches failed) |
| 2 | Fatal error (connection, auth, no valid files found) |
| 3 | Invalid arguments or configuration |

---

## 11. Progress Reporting

### 11.1 Phases

The tool reports progress through four phases, each with its own progress indicator:

```
[1/4] Discovering files...
      Found 482 YAML files in 16 directories

[2/4] Parsing artifacts...
      [====================================] 482/482 (100%)
      478 parsed, 4 errors

[3/4] Transforming to graph model...
      478 nodes, 1,247 edges, 346 containment edges

[4/4] Writing to Neo4j...
      Nodes:  [====================================] 478/478 (100%)
      Edges:  [================================    ] 1,447/1,593 (91%)
      ...
      Nodes:  [====================================] 478/478 (100%)
      Edges:  [====================================] 1,593/1,593 (100%)
```

### 11.2 Per-Type Breakdown

With `--verbose`, include per-type counts during discovery:

```
[1/4] Discovering files...
      work-items/     289 files
      cycles/          87 files
      policies/        14 files
      decisions/       12 files
      principles/      16 files
      questions/        8 files
      constraints/      7 files
      phases/          18 files
      projects/         2 files
      interviews/      12 files
      research/         6 files
      plan/             3 files
      steering/         2 files
      metrics/          4 files
      modules/          1 file
      domains/          1 file
      ──────────────────────
      Total:           482 files
```

### 11.3 JSON Output Mode

With `--json`, all output is structured JSON written to stdout (no progress bars):

```json
{
  "source": "/path/to/ideate/.ideate",
  "org_id": "org-uuid-123",
  "codebase_id": "codebase-uuid-1",
  "codebase_name": "ideate",
  "dry_run": false,
  "files": {
    "scanned": 482,
    "parsed": 478,
    "skipped": 4
  },
  "nodes": {
    "created": 320,
    "updated": 158,
    "skipped": 0,
    "by_label": {
      "WorkItem": 289,
      "Finding": 87,
      "DomainPolicy": 14,
      "Document": 24
    }
  },
  "edges": {
    "artifact": 1247,
    "containment": 346
  },
  "errors": [
    {
      "file": "interviews/refine-003/INT-003-07.yaml",
      "phase": "parse",
      "message": "YAML parse error - unexpected end of stream"
    }
  ],
  "duration_ms": 12400
}
```

---

## 12. Performance Considerations

### 12.1 Batching Strategy

For large `.ideate/` directories (ideate's own has 478+ artifacts), the tool batches Neo4j writes:

| Operation | Batch Size | Rationale |
|---|---|---|
| Node MERGE | 100 per transaction | Balance between transaction overhead and memory usage |
| Edge MERGE | 200 per transaction | Edges are smaller; higher batch size reduces round trips |
| Hash pre-check | 500 per query | Read-only; can be larger |
| Containment edges | All in one transaction | Small count (< 50 typically) |

Batch size is configurable via `--batch-size` and config file.

### 12.2 Cypher Optimization

**Parameterized UNWIND for batch operations:**

```cypher
// Batch node creation using UNWIND
UNWIND $nodes AS node
MERGE (n:WorkItem {artifact_uid: node.artifact_uid})
ON CREATE SET n += node.properties, n.created_at = datetime()
ON MATCH SET n += node.changed_properties, n.updated_at = datetime()
```

This approach:
- Sends one Cypher statement per batch instead of one per node.
- Uses parameterized queries (no string interpolation).
- Allows Neo4j to optimize the execution plan across the batch.

**Label-specific batching:** Nodes are grouped by label before batching. Each batch contains nodes of a single label, allowing the MERGE to use the label-specific uniqueness constraint index.

### 12.3 Connection Pooling

The tool uses the official `neo4j-driver` package which manages connection pooling internally. Configuration:

```typescript
const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), {
  maxConnectionPoolSize: 10,
  connectionAcquisitionTimeout: 30_000,
  maxTransactionRetryTime: 15_000,
});
```

### 12.4 Memory Budget

The tool loads artifacts into memory in three stages:

1. **File content**: Read one file at a time, parse, extract, discard raw content. Peak memory is proportional to the largest single YAML file, not the total corpus.
2. **Parsed artifacts**: All `ParsedArtifact` objects are held in memory for edge resolution (edges reference artifacts by local ID). For 500 artifacts, this is approximately 2-5 MB.
3. **Write batches**: Batched writes keep only the current batch in memory. After each batch commits, its objects are eligible for GC.

For the dogfooding scenario (~500 artifacts), total memory usage should stay under 50 MB.

### 12.5 Parallelism

The initial implementation is single-threaded (sequential file reads, sequential Neo4j writes). Parallelism is deferred to a future optimization:

- **File parsing**: Embarrassingly parallel but I/O-bound. Marginal benefit for < 1000 files.
- **Neo4j writes**: Must respect transaction isolation. Parallel writes to different labels could conflict on relationship creation. Not worth the complexity for initial implementation.

### 12.6 Expected Performance

Based on the dogfooding scenario (~500 artifacts, ~1500 edges):

| Phase | Estimated Duration | Notes |
|---|---|---|
| Discovery | < 100ms | Directory walk |
| Parse | 500ms - 1s | 500 YAML files, sequential |
| Transform | < 100ms | In-memory transformation |
| Write (cold) | 5-15s | First import, all nodes are new |
| Write (warm) | 1-3s | Re-import, most nodes unchanged (hash skip) |
| **Total (cold)** | **6-17s** | |
| **Total (warm)** | **2-5s** | |

---

## 13. Implementation Architecture

### 13.1 Module Structure

The migration tool lives in the `ideate-server` repo as a CLI command:

```
ideate-server/
  src/
    cli/
      migrate.ts              # CLI entry point (argument parsing, orchestration)
      commands/
        import.ts             # Import command implementation
        status.ts             # Status command implementation
        prune.ts              # Prune command implementation
    migration/
      discovery.ts            # Walk .ideate/ directory, collect YAML files
      parser.ts               # Parse YAML, validate, compute content hash
      transformer.ts          # Map parsed artifacts to Neo4j nodes and edges
      writer.ts               # Batch write to Neo4j
      diff.ts                 # Content-hash-based change detection
      config.ts               # Config file parsing, CLI/env/config merging
      types.ts                # Shared type definitions
      constants.ts            # TYPE_TO_LABEL_MAP, weight tables, batch sizes
    services/
      neo4j.ts                # Neo4j driver wrapper (shared with GraphQL API)
```

### 13.2 Shared Code with MCP Server

The migration tool reuses logic patterns from the MCP artifact server but does **not** import from it directly (different repo). Instead, the following logic is ported:

| MCP Source | Migration Target | What is Ported |
|---|---|---|
| `indexer.ts` `walkDir` | `discovery.ts` | Directory walking logic |
| `indexer.ts` `safeParseYaml` | `parser.ts` | Error-tolerant YAML parsing |
| `indexer.ts` `extractEdges` | `parser.ts` | EDGE_TYPE_REGISTRY-driven edge extraction |
| `indexer.ts` `buildExtensionRow` | `transformer.ts` | Field mapping per type |
| `db-helpers.ts` `computeArtifactHash` | `parser.ts` | Content hash computation |
| `schema.ts` `EDGE_TYPE_REGISTRY` | `constants.ts` | Edge type definitions |
| `config.ts` `IDEATE_SUBDIRS` | `constants.ts` | Directory structure |
| `db.ts` `TYPE_TO_EXTENSION_TABLE` | `constants.ts` | Type mapping (adapted for Neo4j labels) |

### 13.3 Dependency on Server Service Layer

The migration tool writes to Neo4j via the same service layer the GraphQL API uses. This ensures:

1. The same Cypher queries and patterns are used for both API writes and migration writes.
2. Constraint validation is consistent.
3. The migration tool serves as an integration test for the service layer.

The `writer.ts` module calls the Neo4j service layer (e.g., `neo4jService.upsertNode(label, properties)`) rather than executing raw Cypher directly.

---

## 14. Testing Strategy

### 14.1 Unit Tests

| Test Target | What is Tested |
|---|---|
| `parser.ts` | YAML parsing, validation, content hash computation, edge extraction |
| `transformer.ts` | Type-to-label mapping, property transformation, JSON-to-native conversion, containment edge generation |
| `diff.ts` | Change detection, partition into new/changed/unchanged |
| `config.ts` | Config file parsing, CLI/env/config priority merging |

### 14.2 Integration Tests

| Test | Setup | Assertion |
|---|---|---|
| Import single `.ideate/` | Fixture directory with 10-20 artifacts | Correct node count, labels, properties, edges |
| Re-import unchanged | Import same fixture twice | Zero nodes updated on second run |
| Re-import with changes | Modify one artifact, re-import | Exactly one node updated |
| Multi-codebase merge | Two fixture directories | Both codebases exist, separate artifact_uids |
| Dry-run | Fixture directory | Zero writes to Neo4j, correct summary output |
| Prune stale | Import, delete a file, re-import with `--prune` | Deleted file's node removed |
| Parse errors | Fixture with malformed YAML | Error logged, valid files still imported |

### 14.3 Dogfood Validation

After implementation, validate by importing `ideate/.ideate/`:

1. Verify artifact count matches: `SELECT COUNT(*) FROM nodes` in SQLite vs. node count in Neo4j.
2. Verify edge count matches: `SELECT COUNT(*) FROM edges` in SQLite vs. relationship count in Neo4j (minus containment edges which are new).
3. Run a PPR query from a known seed node and verify the top-K results are reasonable.
4. Import `ideate-server/.ideate/` into the same graph. Verify both codebases are queryable.

---

## 15. Dogfood Acceptance Criteria

This section defines the definition of done for the Phase 3 dogfood cutover. All criteria must pass before the migration tool is considered ready for production use.

### 15.1 Expected Node Counts — ideate Repo

Before importing, run the migration tool's `status` subcommand (or count YAML files per subdirectory) against `/path/to/ideate/.ideate/` to establish baseline counts. The import result should match these approximate counts:

| Neo4j Label | Approximate Count | Source Directory |
|---|---|---|
| `WorkItem` | ~478 | `work-items/` |
| `DomainDecision` | ~150 | `decisions/` |
| `DomainPolicy` | ~50 | `policies/` |
| `ResearchFinding` | ~25 | `research/` |
| `GuidingPrinciple` | ~16 | `principles/` |
| `Constraint` | ~16 | `constraints/` |
| `Phase` | ~17 | `phases/` |
| `Project` | 1 | `projects/` |
| `JournalEntry` | ~475 | `cycles/` |

Counts are approximate — exact values can be verified by running `ideate-migrate status` against the `.ideate/` directory before import and comparing against post-import Neo4j counts. Deviations greater than 5% (excluding parse errors reported in the import summary) are a failure.

### 15.2 PPR Cross-Codebase Traversal

After importing both `ideate/.ideate/` and `ideate-server/.ideate/` into the same Neo4j graph:

1. Run an `assembleContext` query seeded on a known work item from the ideate codebase (e.g., WI-543).
2. Verify the result set includes at least one node whose `codebase_id` corresponds to the `ideate-server` codebase.

This criterion proves that PPR traversal crosses codebase boundaries within a single organization graph. A result set containing only nodes from one codebase is a failure.

### 15.3 Constraint Verification — No Uniqueness Violations

After import, run Neo4j constraint checks:

1. No uniqueness constraint violations exist for `artifact_uid` across any label.
2. All `artifact_uid` values in the graph follow the `{org_id}:{codebase_id}:{artifact_id}` pattern. Spot-check at least 10 nodes of different labels to confirm the pattern.
3. No two nodes of the same label share an `artifact_uid`.

A single uniqueness violation is a failure. The import summary's reported constraint violations must be zero.

### 15.4 Status Command Output Matches Source Counts

Run `ideate-migrate status` after import and verify:

1. The per-label node counts reported by the status command match the pre-import source directory artifact counts (within tolerance for parse errors logged in the import summary).
2. The total artifact count reported by status equals `files_parsed` from the import summary.
3. If parse errors were logged, the count of skipped files plus the count of imported nodes equals the total files scanned.

A discrepancy between `status` output and source directory counts that exceeds the number of reported parse errors is a failure.

---

## 16. Future Considerations

### 16.1 Bidirectional Sync

The initial migration tool is one-way (YAML -> Neo4j). Future work may add:
- Neo4j -> YAML export for users who want to start with a remote graph and initialize a local `.ideate/` directory.
- Real-time sync via the RemoteAdapter (writes go to Neo4j via GraphQL, not to YAML).

### 16.2 Streaming for Large Datasets

For organizations with thousands of artifacts across many codebases, streaming writes (one file at a time, no full in-memory artifact list) would reduce memory usage. This requires a different edge resolution strategy (two-pass: first pass creates nodes, second pass creates edges).

### 16.3 Knowledge Promotion Automation

Post-migration, an automated process could analyze imported knowledge artifacts and suggest promotion candidates (e.g., policies referenced by multiple codebases).

### 16.4 Incremental File Watching

Rather than batch re-import, a file watcher (similar to the existing MCP watcher) could push changes to Neo4j in real-time via the GraphQL API. This is effectively what the RemoteAdapter will do.
