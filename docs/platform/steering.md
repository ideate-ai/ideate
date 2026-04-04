# Ideate Platform Steering Document

> Comprehensive record of the platform pivot from Claude Code plugin to multi-user SaaS product.
> Produced during refinement cycle 6 (2026-04-01). Serves as the canonical reference for bootstrapping all repos and projects.

---

## 1. Origin and Evolution

Ideate started as a tool to automate larger chunks of work than Claude Code's plan mode can handle. Context windows have a hard limit, and compaction results in a loss of fidelity and notable quality drops.

### Evolution Arc

1. **Interview-based quality gates** — Reverse prompting pattern to prime context with a structured interview saved in markdown. The interview served as a quality gate after code was implemented, ensuring the actual intention was accomplished even after compaction.

2. **Context explosion** — Every interview cycle created additional quality gates, slowing verification and increasing token usage. Needed to limit context used in each stage.

3. **Time-horizon review (failed)** — Attempted to limit quality review based on time horizon. Key decisions are often established early in design, so this caused unacceptable quality drops in review.

4. **Domain-Driven Design** — Added DDD concepts (domains, policies) for more strategic review. Effective stopgap but insufficient for long-term projects.

5. **Graph traversal / PPR** — Realized context assembly is a graph traversal problem. Personalized PageRank on a multigraph provides high signal-to-noise context packages. Edge weights can be tuned per phase. Traditional ML can tune the algorithm without expensive LLM token costs.

6. **YAML abstraction + MCP** — Fully abstracted markdown into YAML behind an MCP interface. Made ideate highly effective at solving basically any code challenge.

7. **Project management as the bottleneck** — Managing work by features became myopic. Review process had an upper ceiling per execution run. Drew from Lean, Six Sigma, Agile, Scrum, and Shape Up to introduce Phases (iterations within a higher concept), Projects (epic-level), and Workspaces (top-level).

8. **Company-scale vision (current)** — Considering how an entire company of agents would organize. Not all tasks are code-related, but ideate handles many non-engineering tasks. Key question: how to turn this into a business.

---

## 2. Product Vision

### Core Insight

A Claude Code plugin cannot be protected from copying. If the MCP backend is abstracted and run on a server, you have a sellable product. Free plugin driven by a paid backend knowledge graph.

### Three Pillars

**Pre-populated Knowledge Graphs** — Coding best practices, domain-specific context, historical decisions imported from Jira, institutional knowledge. Makes the tool more effective out of the box.

**Multi-Instance / Multi-Project Scaling** — PPR is highly scalable. Multiple agents interacting with a shared graph for clarity on challenges and informed decisions. Multiple humans in the loop controlling teams of agents.

**Graph-Based Insights** — Projected timelines, contributor impact analysis. Employees who effectively guide ideate create more impactful nodes. These nodes directly identify the most impactful contributors regardless of outward appearances.

### Target Market

Small companies where people wear many hats. Engineers are often thought leaders. PMs and decision makers are the first non-engineer user persona. AI is a strong current tailwind.

### Business Model

Per-seat pricing with add-on tiers (SSO, additional repos, advanced analytics). Revenue before seed funding. Shoestring budget during initial development.

---

## 3. Taxonomy

### Current (Local Plugin)

```
Workspace → Project → Phase → Cycle → Work Item
```

### Target (SaaS Platform)

```
Organization (tenant, graph root)
├── Knowledge Layer (org-wide)
│   ├── Policies, principles, decisions
│   ├── Institutional knowledge
│   └── Company vision, standards
│
├── Codebases (tracked locations)
│   ├── Codebase: "api-gateway" → github.com/acme/api-gateway
│   ├── Codebase: "web-app" → github.com/acme/web-app
│   └── Codebase: "ml-pipeline" → github.com/acme/ml-pipeline
│
└── Projects (epics, span codebases)
    └── Project: "OAuth2 Migration"
        ├── references: [api-gateway, web-app]
        ├── Phase 1: "API Auth Layer"
        │   └── Work Items (scoped to api-gateway files)
        └── Phase 2: "Frontend Auth Flow"
            └── Work Items (scoped to web-app files)
```

### Key Decisions

- **Workspace** concept eliminated in the remote model. Was an artifact of local-only design (one directory = one workspace).
- **Codebase** replaces workspace at the location level. A tracked code repository with a URL or local path and its own derived context (conventions, patterns, architecture).
- **Project** crosses codebases. A single project's phases can target different codebases. Work items specify which codebase their file scope belongs to.
- **Organization** owns the shared knowledge layer. Policies and principles defined here apply everywhere unless overridden at the project level.
- **Team** is not a first-class graph concept. Access control is handled at the schema/permissions level, not as a node type.

### Knowledge Flow

- **Raw artifacts** (interviews, findings, cycle summaries) stay project-scoped. Too granular and context-dependent for org-level consumption.
- **Distilled knowledge** (policies, decisions) is promotable to the org level via cross-cutting edges, not by moving nodes. PPR traversal from other projects discovers promoted knowledge through edge weights.
- **Graph bloat prevention**: PPR naturally handles large graphs — irrelevant nodes get near-zero scores. The real risk is edge density. Edge pruning or decay (edges lose weight over time unless reinforced) can address this.

---

## 4. Architecture

### System Architecture

```
┌─────────────────────────────────────────────────┐
│  Claude Code Plugin (free, skills + agents)     │
│  ┌───────────────────────────────────────────┐  │
│  │  MCP Artifact Server (stdio)              │  │
│  │  ┌─────────────┬──────────────────────┐   │  │
│  │  │ Local Mode  │  Remote Mode         │   │  │
│  │  │ SQLite/YAML │  HTTP → Backend API  │   │  │
│  │  └─────────────┴──────────────────────┘   │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                        │ (remote mode)
                        ▼
┌─────────────────────────────────────────────────┐
│  Backend API  (GraphQL, TypeScript)             │
│  Auth (Auth0, deferred initial implementation)  │
│  Multi-tenant, per-seat                         │
│  ┌───────────────────────────────────────────┐  │
│  │  Neo4j Graph Database                     │  │
│  │  Community → Managed (AWS/GCP)            │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────┐
│  Web Portal (dashboard, billing, account mgmt)  │
│  Auth0 integration                              │
│  Shopify billing (per-seat + add-ons)           │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│  Corporate Site (marketing, pricing, docs)      │
└─────────────────────────────────────────────────┘
```

### StorageAdapter Pattern

The adapter interface sits directly below MCP tool handlers — high in the stack, not deep in storage. The interface speaks in nodes, edges, traversals, and mutations. No YAML, SQLite, file-path, or Drizzle idioms cross the boundary.

```
MCP Tool Handler (thin — validates input, formats response)
  │
  ▼
StorageAdapter Interface (graph-native vocabulary)
  │
  ├── LocalAdapter
  │   → YAML serialization
  │   → SQLite/Drizzle operations
  │   → In-process PPR (ppr.ts)
  │   → File system I/O
  │
  └── RemoteAdapter
      → GraphQL client
      → Server-side PPR delegation
      → Auth0 token management
```

**Current MCP server modules that move behind the adapter**:
- `db-helpers.ts` → LocalAdapter internal
- `indexer.ts` → LocalAdapter internal
- `ppr.ts` → LocalAdapter internal (traverse operation)
- Storage operations in `tools/write.ts` (1289 lines) → adapter write calls
- Storage operations in `tools/context.ts` (1405 lines) → adapter traverse/read calls
- Storage operations in `tools/query.ts` (789 lines) → adapter query calls
- Storage operations in `tools/analysis.ts` (696 lines) → adapter read calls

### PPR Strategy

- **Local mode**: PPR runs in-process within the LocalAdapter (existing ppr.ts)
- **Remote mode**: PPR runs server-side. The RemoteAdapter delegates to a server endpoint that runs PPR against Neo4j. No edge overfetching, no multiple round trips.
- **Interface**: The adapter's `traverse()` operation encapsulates PPR. Takes seed IDs and options, returns ranked nodes with scores. Implementation is invisible to tool handlers.

### Graph Edge Model

Three categories of edges in the multi-tenant graph:

| Edge Category | Examples | PPR Weight Behavior |
|---|---|---|
| **Structural** | project→phase, phase→work_item, codebase→file | High weight, always traversed |
| **Knowledge** | policy→decision, principle→constraint, research→decision | Medium weight, context-dependent |
| **Cross-cutting** | project_A.decision→project_B.policy, codebase_X.pattern→codebase_Y.convention | Low default weight, tunable per query |

Cross-cutting edges are where multi-user value lives. An engineer's rate-limiting decision in `api-gateway` can be discovered by someone working on `web-app` through PPR traversal — without manual linking.

---

## 5. Technology Decisions

| Area | Decision | Rationale |
|---|---|---|
| Graph DB | Neo4j | Community edition free, AWS/GCP managed for scale |
| API | GraphQL | Natural graph fit, federation for future multi-service |
| Auth | Auth0 | Design for it, defer implementation. Don't gate velocity. |
| Billing | Shopify | Per-seat subscriptions with add-on tiers |
| Server language | TypeScript | Shared with MCP server, one language across the stack. Revisit for ML-specific PPR tuning tools. |
| IaC | Hybrid | Shared foundations in ideate-infra, service-specific co-located |
| Local storage | YAML + SQLite | Preserved as-is for freemium. .ideate/ per-repo. |
| Infrastructure | Buy, not build | Avoid vendor lock-in but don't build auth/billing from scratch |

---

## 6. Repo Structure

| Repo | Purpose | Visibility | Tech Stack |
|---|---|---|---|
| `ideate` | Claude Code plugin + local MCP backend | Public | TypeScript, Markdown (skills/agents), SQLite, YAML |
| `ideate-server` | GraphQL API + Neo4j + server-side PPR | Private | TypeScript, Apollo Server, Neo4j driver, GraphQL |
| `ideate-portal` | Web dashboard, Auth0, Shopify billing, account mgmt | Private | TypeScript, React/Next.js (TBD), Auth0 SDK, Shopify API |
| `ideate-corporate` | Marketing/sales site, pricing, docs | Private | TBD (static site generator or Next.js) |
| `ideate-infra` | Shared infrastructure (VPC, DNS, Neo4j cluster, secrets) | Private | Terraform, Docker Compose for local dev |

### IaC Boundary

- **ideate-infra owns**: VPC, DNS zones, container registry, Neo4j cluster, secrets management, monitoring, environment definitions
- **Each service owns**: Dockerfile, service-level deployment config, CI pipeline (GitHub Actions)
- **Rule of thumb**: If it has an AWS account number or a DNS zone, it's infra repo. If it's "how to build and run this service," it's co-located.

---

## 7. Project Structure

Each repo gets its own ideate project tracking its implementation work. The Platform Strategy project (in the ideate repo) handles cross-cutting concerns and bootstrapping.

| Project | Scope | Repo | Status |
|---|---|---|---|
| **PR-001: Ideate Platform Strategy** | Roadmap, architecture specs, bootstrap guides, business setup, GTM planning, pricing | ideate | Active (PH-018) |
| **PR-002: Ideate Plugin — Adapter Refactor** | StorageAdapter extraction, LocalAdapter, config extension | ideate | Planned (PH-019) |
| **Ideate Server** | Neo4j schema, GraphQL API, server-side PPR, migration/merge tool | ideate-server | Not yet created |
| **Ideate Portal** | PM dashboard, Auth0 integration, Shopify billing, account management | ideate-portal | Not yet created |
| **Ideate Corporate** | Marketing site, pricing page, getting started guide | ideate-corporate | Not yet created |
| **Ideate Infrastructure** | Shared infra, environments, local dev setup | ideate-infra | Not yet created |

### Cross-Project Dependencies

```
Platform Strategy (PR-001)
  WI-543 (StorageAdapter spec) ──→ PR-002 WI-551 (implement interface)
  WI-544 (Neo4j schema spec) ──→ ideate-server (schema implementation)
  WI-545 (GraphQL schema spec) ──→ ideate-server (API implementation)
  WI-549 (Migration tool spec) ──→ ideate-server (migration tool implementation)
  WI-547 (server bootstrap guide) ──→ human creates ideate-server repo
  WI-548 (infra bootstrap guide) ──→ human creates ideate-infra repo
```

---

## 8. Roadmap

### Phase 0: Foundation & Architecture (Current — PH-018)

**Project**: PR-001 (Platform Strategy)
**Deliverables**: Specs and checklists only. No implementation code.

- StorageAdapter interface specification
- Neo4j graph schema design
- GraphQL API schema design
- Migration/merge tool specification
- Business entity establishment (LLC, domain, bank account)
- ideate-server repo creation + ideate bootstrap
- ideate-infra repo creation + scaffold

### Phase 1: Adapter Extraction

**Project**: PR-002 (Adapter Refactor), in ideate repo
**Prerequisite**: WI-543 (StorageAdapter spec) from Phase 0

- Define StorageAdapter TypeScript interface
- Extract write operations from tool handlers → LocalAdapter
- Extract read/query operations → LocalAdapter
- Extract context assembly + PPR → LocalAdapter
- Adapter-level contract tests (reusable for RemoteAdapter)
- Config extension for backend selection (local/remote)

**Risk**: Most dangerous phase. Refactoring 2,700+ lines of interleaved storage logic without breaking anything. Multiple small work items with continuous review.

### Phase 2: Server Core

**Project**: Ideate Server, in ideate-server repo
**Prerequisite**: Phase 0 specs (Neo4j schema, GraphQL schema, migration tool spec)

- Neo4j schema implementation (node labels, relationship types, constraints, indexes)
- GraphQL API (Apollo Server, resolvers mapping to Neo4j via neo4j-driver)
- Server-side PPR implementation (port from TypeScript ppr.ts)
- Migration tool CLI (reads .ideate/ directory, writes to Neo4j)
- Merge tool (combines multiple .ideate/ directories into one graph with codebase scoping)
- Health/status endpoints
- No auth yet — local development only

**Language decision**: TypeScript. Revisit for ML-specific PPR tuning in future.

### Phase 3: Remote Adapter + Dogfood Cutover

**Projects**: PR-002 (Remote Adapter phase), plus coordination across repos
**Prerequisite**: Phase 1 (adapter exists) + Phase 2 (server running)

- Implement RemoteAdapter as GraphQL client in MCP server
- Config switch: `backend: "local" | "remote"` with connection config
- Import ideate/.ideate/ and ideate-server/.ideate/ into Neo4j
- Switch both repos to remote backend
- Run full ideate cycle (refine → execute → review) against remote backend
- Fix whatever breaks

**Milestone**: First proof that the architecture works end-to-end. Dogfooded multi-repo ideate.

### Phase 4: Portal MVP

**Project**: Ideate Portal, in ideate-portal repo
**Prerequisite**: Phase 3 (remote backend working)

- Auth0 integration (login, user management, role assignment)
- Project dashboard (projects, phases, work items, status — read-only initially)
- Codebase registration UI (add repos to org)
- Shopify billing integration (per-seat subscription, SSO add-on tier)

**Milestone**: First billable product. A PM at a small company can see what agents are doing.

### Phase 5: Corporate Site + Launch

**Project**: Ideate Corporate, in ideate-corporate repo
**Prerequisite**: Phase 4 (something to sell)

- Landing page with value proposition
- Pricing page (per-seat tiers, add-ons)
- Getting started guide (install plugin → connect to backend)
- Sign-up flow linked to portal

**Milestone**: Go-to-market presence. First customers.

### Phase 6+: Post-Launch

- Portal write operations (approve decisions, participate in interviews from browser)
- Slack/Teams integration for Andon decisions and status updates
- Graph insights dashboard (timelines, contributor impact, trend analysis)
- Knowledge graph pre-population (best practices, framework guides, importers for Jira/Confluence)
- Federation (multi-org, marketplace for shared knowledge templates)
- ML-based PPR tuning (may require Python tooling)

---

## 9. Bootstrapping Plan

The chicken-and-egg problem: ideate is needed to build ideate-server, but ideate-server enables multi-repo tracking.

### Sequence

1. Create `ideate-server` GitHub repo (private)
2. Run `ideate:init` locally in ideate-server → bootstraps .ideate/
3. Use local ideate to plan and execute server development
4. Build the migration tool as an early server feature
5. Import `ideate/.ideate/` AND `ideate-server/.ideate/` into Neo4j
6. Switch both repos to remote backend
7. Continue all development with dogfooded remote backend

Step 4 is on the critical path — the migration tool must work before the remote backend can be validated with real data.

### Local .ideate/ Mapping on Migration

A local `.ideate/` directory maps to:
- One **Organization** (the user's org)
- One **Codebase** (the repo the .ideate/ lives in)
- One **Project** (the active project)
- Policies/principles → promoted to org knowledge layer

Artifact IDs are unique within a codebase. In the merged graph, the compound key is `(org_id, codebase_id, artifact_id)`. No renumbering needed.

---

## 10. Non-Code Concerns & Timing

| Category | Examples | When |
|---|---|---|
| **Business Entity** | LLC, EIN, bank account | Phase 0 (now) |
| **Domain** | Register domain name | Phase 0 (now) |
| **Product Decisions** | Feature prioritization, pricing tiers, user personas | During Phase 4 (portal) |
| **GTM Strategy** | Launch plan, first 10 customers, sales motion | During Phase 5 (corporate) |
| **Brand** | Logo, visual identity, tone | Before Phase 5 |
| **Legal** | Terms of service, privacy policy, data processing agreements | Before first customer |
| **Finance** | Payroll, accounting, expense tracking | Before first revenue |
| **Operations** | Support channels, incident response | Before first customer |

Non-code work is tracked in ideate itself — these are projects, just not code projects. This validates GP-09 (Domain Agnosticism) in practice.

---

## 11. Open Decisions (Deferred)

| Decision | When to Resolve | Context |
|---|---|---|
| Portal frontend framework (React/Next.js vs alternatives) | Phase 4 bootstrap | Depends on team size and complexity needs |
| Corporate site framework (static gen vs Next.js) | Phase 5 bootstrap | Depends on content management needs |
| ~~IaC tool~~ | ~~Phase 0 infra bootstrap~~ | **Resolved**: Terraform chosen for broader adoption, multi-cloud readiness, and extensive community modules |
| Auth0 vs alternatives (Clerk, Cognito) | Phase 4 | Auth0 is the current preference; evaluate free tier limits before committing |
| Shopify billing details | Phase 4 | Per-seat pricing model confirmed; exact tiers and pricing TBD |
| ML tooling language for PPR tuning | Post-launch | TypeScript for now; Python if ML ecosystem is needed |
| Multi-org federation model | Post-launch | Depends on customer needs and graph partition strategy |

---

## 12. Guiding Principles (Confirmed Unchanged)

All 16 existing guiding principles (GP-01 through GP-16) were reviewed during this refinement and confirmed to still hold. No principles were changed, deprecated, or added. The principles were designed to be domain-agnostic (GP-09) and scale-independent (GP-07), which positions them well for the platform pivot.

Key principles that directly support the pivot:
- **GP-08** (Durable Knowledge Capture) — The MCP artifact server and graph backend are implementations of this principle at different scales
- **GP-09** (Domain Agnosticism) — Validates that non-code work (business, GTM, legal) can be tracked in ideate
- **GP-14** (MCP Abstraction Boundary) — Already established the boundary that the StorageAdapter formalizes
- **GP-15** (Progressive Elaboration) — Justifies feature-level specs for later repos while fully specifying current phase work
