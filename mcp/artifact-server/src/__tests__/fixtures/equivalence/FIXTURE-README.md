# Equivalence Test Fixture

Synthetic `.ideate/` directory with fully deterministic, known-value YAML artifacts.

Designed to exercise every extension table column introduced in schema v5, all known
edge extraction paths, and all nullable-field edge cases documented in the triage report.

## Purpose

This fixture is the canonical input for equivalence tests between:
- **LocalAdapter** (YAML to SQLite indexer)
- **Migration CLI** (YAML to Neo4j)

Both adapters must produce identical node counts, edge counts, and field values when
given this fixture as input. Any divergence is a bug.

---

## config.json

| Field          | Value |
|----------------|-------|
| schema_version | 5     |

---

## Artifact Inventory

### Work Items

#### WI-001 — `work-items/WI-001.yaml`
| Field          | Value                                             |
|----------------|---------------------------------------------------|
| id             | WI-001                                            |
| type           | work_item                                         |
| title          | Implement schema v5 extension columns             |
| status         | done                                              |
| complexity     | medium                                            |
| work_item_type | feature                                           |
| domain         | artifact-structure                                |
| phase          | PH-001                                            |
| scope          | [{path: mcp/artifact-server/src/schema.ts, op: modify}, {path: mcp/artifact-server/src/db.ts, op: modify}] |
| depends        | []                                                |
| blocks         | [WI-002]                                          |
| criteria       | 6 items (see file)                                |
| governed_by    | [GP-01]                                           |
| resolution     | "Completed in cycle 1. All five extension columns landed in schema v5 migration." |
| cycle_created  | 1                                                 |
| cycle_modified | 2                                                 |

**Edges extracted:**
- `belongs_to_phase`: WI-001 → PH-001 (via `phase` field)
- `belongs_to_domain`: WI-001 → artifact-structure (via `domain` field)
- `governed_by`: WI-001 → GP-01 (via `governed_by` field)

**Extension table columns exercised:**
- `resolution` (non-null): "Completed in cycle 1..."
- `scope` (JSON array)
- `criteria` (JSON array)
- `depends` (empty JSON array)

#### WI-002 — `work-items/WI-002.yaml`
| Field          | Value                                             |
|----------------|---------------------------------------------------|
| id             | WI-002                                            |
| type           | work_item                                         |
| title          | Write equivalence test fixture                    |
| status         | pending                                           |
| complexity     | small                                             |
| work_item_type | chore                                             |
| domain         | artifact-structure                                |
| phase          | PH-001                                            |
| depends        | [WI-001]                                          |
| blocks         | []                                                |
| governed_by    | [GP-01]                                           |
| resolution     | null                                              |
| cycle_created  | 1                                                 |
| cycle_modified | null                                              |

**Edges extracted:**
- `depends_on`: WI-002 → WI-001 (via `depends` field)
- `belongs_to_phase`: WI-002 → PH-001 (via `phase` field)
- `belongs_to_domain`: WI-002 → artifact-structure (via `domain` field)
- `governed_by`: WI-002 → GP-01 (via `governed_by` field)

**Extension table columns exercised:**
- `resolution` (null): exercises nullable column with explicit null

#### WI-003 — `work-items/WI-003.yaml`
| Field          | Value                           |
|----------------|---------------------------------|
| id             | WI-003                          |
| type           | work_item                       |
| title          | Validate nullable cycle fields  |
| status         | done                            |
| depends        | [WI-001]                        |
| resolution     | null                            |
| cycle_created  | null                            |
| cycle_modified | null                            |

**Purpose:** exercises null `cycle_created` and null `cycle_modified` in the nodes base table.

**Edges extracted:**
- `depends_on`: WI-003 → WI-001 (via `depends` field)
- `belongs_to_phase`: WI-003 → PH-001 (via `phase` field)
- `belongs_to_domain`: WI-003 → artifact-structure (via `domain` field)

---

### Guiding Principles

#### GP-01 — `principles/GP-01.yaml`
| Field          | Value                          |
|----------------|--------------------------------|
| id             | GP-01                          |
| type           | guiding_principle              |
| name           | Deterministic Fixture Values   |
| status         | active                         |
| cycle_created  | 1                              |
| cycle_modified | null                           |

**Note:** Uses `name` field (canonical field). The indexer maps `name` directly to the
`guiding_principles.name` column. This artifact is a target for `governed_by` edges
from WI-001 and WI-002, and a `derived_from` edge from P-01.

#### GP-02 — `principles/GP-02.yaml`
| Field          | Value                          |
|----------------|--------------------------------|
| id             | GP-02                          |
| type           | guiding_principle              |
| title          | Schema Coverage                |
| status         | active                         |
| cycle_created  | 1                              |
| cycle_modified | null                           |

**Note:** Uses `title` field (legacy format). The indexer's `buildExtensionRow` for
`guiding_principles` maps `doc.name ?? doc.title` to the `name` column. This exercises
the legacy title-fallback path. The `amendment_history` array is also populated.

---

### Constraints

#### C-01 — `constraints/C-01.yaml`
| Field          | Value                          |
|----------------|--------------------------------|
| id             | C-01                          |
| type           | constraint                     |
| category       | technology                     |
| status         | active                         |
| cycle_created  | 1                              |
| cycle_modified | null                           |

---

### Domain Policies

#### P-01 — `policies/P-01.yaml`
| Field          | Value                          |
|----------------|--------------------------------|
| id             | P-01                           |
| type           | domain_policy                  |
| domain         | artifact-structure             |
| derived_from   | [GP-01]                        |
| established    | cycle 1                        |
| amended        | null                           |
| status         | active                         |
| cycle_created  | 1                              |
| cycle_modified | null                           |

**Edges extracted:**
- `derived_from`: P-01 → GP-01 (via `derived_from` field)
- `belongs_to_domain`: P-01 → artifact-structure (via `domain` field)

---

### Domain Decisions

#### D-01 — `decisions/D-01.yaml`
| Field          | Value                                                   |
|----------------|---------------------------------------------------------|
| id             | D-01                                                    |
| type           | domain_decision                                         |
| domain         | artifact-structure                                      |
| cycle          | 1                                                       |
| supersedes     | null                                                    |
| title          | "Use YAML block scalars for multi-line fixture values"  |
| source         | "triage report — schema v5 fixture spec"                |
| status         | settled                                                 |
| cycle_created  | 1                                                       |
| cycle_modified | null                                                    |

**Extension table columns exercised:**
- `title` (non-null): "Use YAML block scalars for multi-line fixture values"
- `source` (non-null): "triage report — schema v5 fixture spec"

#### D-02 — `decisions/D-02.yaml`
| Field          | Value              |
|----------------|--------------------|
| id             | D-02               |
| type           | domain_decision    |
| domain         | artifact-structure |
| cycle          | 1                  |
| title          | null               |
| source         | null               |
| status         | open               |
| cycle_created  | 1                  |
| cycle_modified | null               |

**Extension table columns exercised:**
- `title` (null): explicit null value
- `source` (null): explicit null value

---

### Domain Questions

#### Q-01 — `questions/Q-01.yaml`
| Field          | Value                          |
|----------------|--------------------------------|
| id             | Q-01                           |
| type           | domain_question                |
| domain         | artifact-structure             |
| status         | resolved                       |
| resolution     | "Resolved by including..."     |
| resolved_in    | 1                              |
| cycle_created  | 1                              |
| cycle_modified | null                           |

---

### Module Specs

#### MS-01 — `modules/MS-01.yaml`
| Field          | Value                          |
|----------------|--------------------------------|
| id             | MS-01                          |
| type           | module_spec                    |
| name           | artifact-indexer               |
| status         | active                         |
| scope          | mcp/artifact-server/src/indexer.ts |
| provides       | [rebuildIndex, indexFiles, removeFiles, detectCycles] |
| requires       | [better-sqlite3, drizzle-orm, js-yaml] |
| boundary_rules | 3 items (see file)             |
| governed_by    | [C-01]                         |
| cycle_created  | 1                              |
| cycle_modified | null                           |

**Edges extracted:**
- `governed_by`: MS-01 → C-01 (via `governed_by` field)

---

### Projects

#### PR-001 — `projects/PR-001.yaml`
| Field            | Value                          |
|------------------|--------------------------------|
| id               | PR-001                         |
| type             | project                        |
| name             | Artifact Server Schema v5      |
| status           | active                         |
| current_phase_id | PH-001                         |
| cycle_created    | 1                              |
| cycle_modified   | null                           |

**Extension table columns exercised:**
- `current_phase_id` (non-null): "PH-001"

---

### Phases

#### PH-001 — `phases/PH-001.yaml`
| Field          | Value                          |
|----------------|--------------------------------|
| id             | PH-001                         |
| type           | phase                          |
| name           | Schema v5 Implementation       |
| project        | PR-001                         |
| phase_type     | implementation                 |
| status         | complete                       |
| completed_date | "2026-04-01"                   |
| work_items     | [WI-001, WI-002, WI-003]       |
| cycle_created  | 1                              |
| cycle_modified | 1                              |

**Extension table columns exercised:**
- `completed_date` (non-null): "2026-04-01"

**Edges extracted:**
- `belongs_to_project`: PH-001 → PR-001 (via `project` field)

#### PH-002 — `phases/PH-002.yaml`
| Field          | Value                          |
|----------------|--------------------------------|
| id             | PH-002                         |
| type           | phase                          |
| name           | Schema v5 Validation           |
| project        | PR-001                         |
| phase_type     | review                         |
| status         | active                         |
| completed_date | null                           |
| work_items     | []                             |
| cycle_created  | 1                              |
| cycle_modified | null                           |

**Extension table columns exercised:**
- `completed_date` (null): explicit null value

**Edges extracted:**
- `belongs_to_project`: PH-002 → PR-001 (via `project` field)

---

### Findings

#### F-WI-001-001 — `cycles/001/findings/F-WI-001-001.yaml`
| Field          | Value                                              |
|----------------|----------------------------------------------------|
| id             | F-WI-001-001                                       |
| type           | finding                                            |
| title          | "Missing resolution column in initial schema migration" |
| severity       | significant                                        |
| work_item      | WI-001                                             |
| verdict        | fail                                               |
| cycle          | 1                                                  |
| reviewer       | code-reviewer                                      |
| addressed_by   | WI-001                                             |
| cycle_created  | 1                                                  |
| cycle_modified | null                                               |

**Extension table columns exercised:**
- `title` (non-null): "Missing resolution column in initial schema migration"

**Edges extracted:**
- `relates_to`: F-WI-001-001 → WI-001 (via `work_item` field)
- `addressed_by`: F-WI-001-001 → WI-001 (via `addressed_by` field)

---

### Journal Entries

#### J-001-001 — `cycles/001/journal/J-001-001.yaml`
| Field          | Value                                  |
|----------------|----------------------------------------|
| id             | J-001-001                              |
| type           | journal_entry                          |
| phase          | execute                                |
| date           | "2026-04-01"                           |
| title          | Schema v5 work items completed         |
| work_item      | WI-001                                 |
| cycle_created  | 1                                      |
| cycle_modified | null                                   |

---

### Metrics Events

#### ME-001 — `metrics/ME-001.yaml`
| Field          | Value                              |
|----------------|------------------------------------|
| id             | ME-001                             |
| type           | metrics_event                      |
| event_name     | work_item_complete                 |
| agent_type     | worker                             |
| timestamp      | "2026-04-01T10:00:00Z"             |
| input_tokens   | 15200                              |
| output_tokens  | 3400                               |
| outcome        | pass                               |
| finding_count  | 1                                  |
| cycle_created  | 1                                  |
| cycle_modified | null                               |

**Purpose:** both `event_name` and `agent_type` are set. The indexer's precedence rule
(`event_name ?? agent_type`) means `event_name` ("work_item_complete") wins and is
stored in `metrics_events.event_name`. This verifies that precedence is respected.

#### ME-002 — `metrics/ME-002.yaml`
| Field          | Value                |
|----------------|----------------------|
| id             | ME-002               |
| type           | metrics_event        |
| event_name     | null                 |
| agent_type     | reviewer             |
| timestamp      | "2026-04-01T10:05:00Z" |
| cycle_created  | 1                    |
| cycle_modified | null                 |

**Purpose:** `event_name` is null but `agent_type` is set. The indexer maps
`event_name ?? agent_type` to `metrics_events.event_name`, so the stored value
is "reviewer". This verifies the fallback path.

---

### Research Findings

#### RF-001 — `research/RF-001.yaml`
| Field          | Value                                          |
|----------------|------------------------------------------------|
| id             | RF-001                                         |
| type           | research_finding                               |
| topic          | SQLite nullable column handling in better-sqlite3 |
| date           | "2026-04-01"                                   |
| status         | active                                         |
| sources        | [mcp/artifact-server/src/indexer.ts, ...]      |
| cycle_created  | 1                                              |
| cycle_modified | null                                           |

---

## Known Edges Summary

| Source       | Edge Type          | Target             | Via YAML Field   |
|--------------|--------------------|--------------------|------------------|
| WI-001       | belongs_to_phase   | PH-001             | phase            |
| WI-001       | belongs_to_domain  | artifact-structure | domain           |
| WI-001       | governed_by        | GP-01              | governed_by      |
| WI-001       | blocks             | WI-002             | blocks           |
| WI-002       | depends_on         | WI-001             | depends          |
| WI-002       | belongs_to_phase   | PH-001             | phase            |
| WI-002       | belongs_to_domain  | artifact-structure | domain           |
| WI-002       | governed_by        | GP-01              | governed_by      |
| WI-003       | depends_on         | WI-001             | depends          |
| WI-003       | belongs_to_phase   | PH-001             | phase            |
| WI-003       | belongs_to_domain  | artifact-structure | domain           |
| P-01         | derived_from       | GP-01              | derived_from     |
| P-01         | belongs_to_domain  | artifact-structure | domain           |
| D-01         | belongs_to_domain  | artifact-structure | domain           |
| D-02         | belongs_to_domain  | artifact-structure | domain           |
| Q-01         | belongs_to_domain  | artifact-structure | domain           |
| MS-01        | governed_by        | C-01               | governed_by      |
| PH-001       | belongs_to_project | PR-001             | project          |
| PH-002       | belongs_to_project | PR-001             | project          |
| F-WI-001-001 | relates_to         | WI-001             | work_item        |
| F-WI-001-001 | addressed_by       | WI-001             | addressed_by     |

---

## Schema v5 Extension Column Coverage

| Table            | Column           | Fixture artifact | Value          |
|------------------|------------------|------------------|----------------|
| work_items       | resolution       | WI-001           | non-null string |
| work_items       | resolution       | WI-002           | null           |
| findings         | title            | F-WI-001-001     | non-null string |
| domain_decisions | title            | D-01             | non-null string |
| domain_decisions | title            | D-02             | null           |
| domain_decisions | source           | D-01             | non-null string |
| domain_decisions | source           | D-02             | null           |
| phases           | completed_date   | PH-001           | non-null string |
| phases           | completed_date   | PH-002           | null           |
| projects         | current_phase_id | PR-001           | non-null string |

---

## Edge Cases Covered

| Edge case                              | Artifact(s)         |
|----------------------------------------|---------------------|
| null cycle_created                     | WI-003              |
| null cycle_modified                    | WI-003, GP-01, GP-02 (most) |
| GP with `name` field (canonical)       | GP-01               |
| GP with `title` field (legacy)         | GP-02               |
| Phase with completed_date populated    | PH-001              |
| Phase with null completed_date         | PH-002              |
| Project with current_phase_id          | PR-001              |
| Finding with title                     | F-WI-001-001        |
| Decision with null title and null source | D-02              |
| ME with both event_name and agent_type | ME-001 (event_name wins) |
| ME with null event_name, agent_type set | ME-002 (agent_type used) |
