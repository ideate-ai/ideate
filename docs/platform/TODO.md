# Ideate Platform — Launch Checklist

> Single source of truth for what to do next. Check items off as you go.
> Items are ordered by dependency — work top to bottom.

---

## Phase 0: Business Setup (parallel with everything below)

- [ ] Check domain name availability (ideate.ai, ideate.dev, useideate.com, ideate.io, ideate.app)
- [ ] Register domain
- [ ] File LLC (see `business-setup-checklist.md` for state selection guidance)
- [ ] Apply for EIN (requires LLC)
- [ ] Open business bank account (requires EIN)
- [ ] Create GitHub organization (private repos need this)
- [ ] Create AWS account under business entity
- [ ] Sign up for service free tiers: Auth0, Neo4j Aura, Shopify (defer until needed)

---

## Phase 0: Server Bootstrap

- [ ] Clone `ideate-server` repo
- [ ] Scaffold directory structure (`src/schema/`, `src/resolvers/`, `src/services/`, `tests/`, etc.)
- [ ] Copy `ideate/docs/platform/graphql-schema.graphql` → `ideate-server/src/schema/schema.graphql`
- [ ] Create `package.json` from template in `bootstrap-ideate-server.md` Section 4
- [ ] Create `tsconfig.json` from template in `bootstrap-ideate-server.md` Section 4
- [ ] Run `npm install`
- [ ] Set up Docker Compose for local Neo4j (see `bootstrap-ideate-server.md` Section 5)
- [ ] Start Neo4j: `docker compose up neo4j`
- [ ] Verify Neo4j Browser at http://localhost:7474
- [ ] Run Neo4j schema init script from `neo4j-schema.md` Section 10
- [ ] Validate SDL: `npx graphql-inspector validate src/schema/schema.graphql`
- [ ] Set up GitHub Actions CI from `bootstrap-ideate-server.md` Section 7
- [ ] Run `ideate:init` in the server repo (provide spec docs as context — see Section 12)
- [ ] Run `/ideate:execute` to begin building

---

## Phase 0: Infra Bootstrap

- [ ] Create `ideate-infra` GitHub repo (private)
- [ ] Scaffold Terraform structure (`modules/`, `environments/`, `docker/`)
- [ ] Create `docker/docker-compose.yml` from `bootstrap-ideate-infra.md` Section 6
- [ ] Create `docker/.env` from `.env.example`
- [ ] Verify `docker compose up neo4j` works from infra repo
- [ ] Create `.terraform-version` (pin to 1.14.8)
- [ ] Bootstrap Terraform remote state (S3 + DynamoDB) — defer until cloud deploy needed

---

## Phase 1: Adapter Refactor (in ideate repo, parallel with server work)

- [x] Activate PR-002 project
- [x] Run `/ideate:execute` for PH-019 (WI-551 through WI-556)
  - [x] WI-551: Define StorageAdapter TypeScript interface
  - [x] WI-552: LocalAdapter — write operations
  - [x] WI-553: LocalAdapter — read and query operations
  - [x] WI-554: LocalAdapter — context assembly and PPR
  - [x] WI-555: Adapter-level contract tests
  - [x] WI-556: Config extension for backend selection
- [ ] Run `/ideate:review` to verify

---

## Phase 2: Server Core (in ideate-server repo)

- [ ] Neo4j schema implementation (constraints, indexes, seed nodes)
- [ ] Apollo Server bootstrap (HTTP + WebSocket)
- [ ] Core CRUD resolvers
- [ ] DataLoader setup
- [ ] Server-side PPR (port from ideate ppr.ts)
- [ ] `assembleContext` resolver
- [ ] Health endpoint (`/health`)
- [ ] Structured logging (pino)
- [ ] Integration test suite

---

## Phase 3: Migration + Dogfood Cutover

- [x] Build migration CLI (in ideate-server)
- [x] Import `ideate/.ideate/` into local Neo4j (1551 nodes, 530 edges)
- [ ] Import `ideate-server/.ideate/` into same Neo4j
- [ ] Verify dogfood acceptance criteria (`migration-tool-spec.md` Section 15)
- [x] Implement RemoteAdapter in ideate MCP server (PR-002 Phase 2)
- [ ] Switch ideate repo to remote backend
- [ ] Switch ideate-server repo to remote backend
- [ ] Run full ideate cycle against remote backend to validate
- **Known issue**: Server enum case mismatch (lowercase in Neo4j, UPPER_CASE in GraphQL enum) — server-side fix needed

---

## Phase 4: Portal MVP

- [ ] Create `ideate-portal` GitHub repo (private)
- [ ] Bootstrap with `ideate:init`
- [ ] Auth0 integration (login, user management)
- [ ] Project dashboard (read-only: projects, phases, work items, status)
- [ ] Codebase registration UI
- [ ] Shopify billing (per-seat subscription)

---

## Phase 5: Go-to-Market

- [ ] Create `ideate-corporate` GitHub repo (private)
- [ ] Register business email
- [ ] Landing page with value proposition
- [ ] Pricing page
- [ ] Getting started guide
- [ ] Terms of service, privacy policy
- [ ] First customers

---

## Reference: Per-Project Steering

Each project has its own scope, intent, and governance. The platform strategy project (PR-001) provides cross-cutting decisions; implementation projects inherit those decisions and add their own.

### PR-001: Ideate Platform Strategy (this repo — `ideate`)

- **Intent**: Strategic planning and bootstrapping for the platform pivot
- **Phase**: PH-018 (Foundation & Architecture) — converged
- **Governance**: All 16 guiding principles (GP-01 through GP-16), all constraints (C-01 through C-16)
- **Key decisions**: Neo4j, GraphQL, Auth0, Shopify, Terraform, TypeScript throughout, adapter pattern, domain-as-property (not node), 3-value complexity scale, archiveCycle on core adapter interface
- **Domain policies**: P-53 (interface specs must not reference storage formats), P-54 (mapping tables must have detail sections)
- **Spec documents**: All in `docs/platform/` (see table below)

### PR-002: Ideate Plugin — Adapter Refactor (this repo — `ideate`)

- **Intent**: Refactor MCP artifact server to decouple storage via StorageAdapter interface
- **Phase**: PH-019 (StorageAdapter Extraction) — complete, pending review
- **Governance**: Inherits all PR-001 principles + P-53 (critical — the adapter IS the interface)
- **Key constraint**: Zero behavior change. All existing tests must pass. This is internal restructuring only.
- **Spec dependency**: `docs/platform/adapter-interface.md` drives WI-551 (interface definition)
- **Work items**: WI-551 through WI-556

### Ideate Server (repo: `ideate-server`)

- **Intent**: GraphQL API + Neo4j backend for ideate knowledge graph with server-side PPR, multi-tenant support, and migration tooling
- **Phase**: To be created via `ideate:init`
- **Governance**: Inherits PR-001 principles. Server-specific policies TBD during init.
- **Key specs** (all in `ideate/docs/platform/`):
  - `graphql-schema.graphql` + `graphql-schema.md` — API contract
  - `neo4j-schema.md` — database schema
  - `adapter-interface.md` — interface the server must satisfy
  - `migration-tool-spec.md` — migration CLI spec
- **Bootstrap guide**: `docs/platform/bootstrap-ideate-server.md`

### Ideate Infrastructure (repo: `ideate-infra`)

- **Intent**: Shared cloud foundations — VPC, DNS, Neo4j cluster, container registry, secrets
- **Phase**: To be created via `ideate:init`
- **Governance**: Inherits PR-001 principles. IaC decision: Terraform.
- **Key specs**: `docs/platform/bootstrap-ideate-infra.md` (environments, cost estimates, Docker Compose)
- **Boundary rule**: If it has an AWS account number or DNS zone, it belongs here. If it's "how to run this service," it stays co-located.

### Ideate Portal (repo: `ideate-portal` — not yet created)

- **Intent**: Web dashboard for PMs and decision makers. Auth0 login, project status, Shopify billing.
- **Phase**: Not yet planned. Starts after Phase 4 in the roadmap.
- **Governance**: Inherits PR-001 principles. Frontend framework TBD.
- **Target users**: PMs and decision makers at small companies who won't use a terminal.

### Ideate Corporate (repo: `ideate-corporate` — not yet created)

- **Intent**: Marketing/sales site with pricing, getting started guide, sign-up flow.
- **Phase**: Not yet planned. Starts after Phase 5 in the roadmap.
- **Governance**: Inherits PR-001 principles. Framework TBD.
- **Depends on**: Portal (needs something to sell) and business entity (needs legal docs).

---

## Reference: Spec Documents

All in `ideate/docs/platform/`:

| Document | What it covers |
|---|---|
| `steering.md` | Vision, taxonomy, architecture, roadmap, all decisions |
| `adapter-interface.md` | StorageAdapter interface contract |
| `architecture-overview.md` | System diagrams, refactoring plan |
| `neo4j-schema.md` | Neo4j labels, relationships, Cypher examples |
| `graphql-schema.graphql` | Complete GraphQL SDL |
| `graphql-schema.md` | GraphQL design doc (auth, pagination, federation) |
| `migration-tool-spec.md` | Migration/merge tool + dogfood acceptance criteria |
| `business-setup-checklist.md` | LLC, domain, bank, service accounts |
| `bootstrap-ideate-server.md` | Server repo setup guide |
| `bootstrap-ideate-infra.md` | Infra repo setup guide |
| `TODO.md` | This checklist |
