# Bootstrap Guide: ideate-server

> Step-by-step instructions for creating the `ideate-server` repo, scaffolding the TypeScript project, and running `ideate:init` to plan the implementation.
>
> **What this repo builds**: GraphQL API + Neo4j backend for the ideate knowledge graph, with server-side PPR, multi-tenant support, and migration tooling.
>
> **Spec documents** (keep these handy — you will provide them as context to `ideate:init`):
> - `docs/platform/adapter-interface.md` — StorageAdapter interface the server must implement
> - `docs/platform/neo4j-schema.md` — Neo4j graph schema to implement
> - `docs/platform/graphql-schema.md` + `docs/platform/graphql-schema.graphql` — GraphQL API contract
> - `docs/platform/migration-tool-spec.md` — Migration CLI specification

---

## 1. Create the GitHub Repo

1. Go to github.com → New repository
2. Name: `ideate-server`
3. Visibility: **Private**
4. Initialize with a README
5. Clone locally:

```bash
git clone git@github.com:<your-org>/ideate-server.git
cd ideate-server
```

---

## 2. Recommended Directory Structure

```
ideate-server/
├── src/
│   ├── index.ts                  # Apollo Server entry point
│   ├── schema/
│   │   ├── index.ts              # Schema assembly (typeDefs + resolvers)
│   │   ├── typeDefs.ts           # GraphQL SDL (imports graphql-schema.graphql)
│   │   └── scalars.ts            # JSON scalar, DateTime scalar
│   ├── resolvers/
│   │   ├── index.ts              # Resolver map assembly
│   │   ├── queries/
│   │   │   ├── artifact.ts       # artifact, artifacts, artifactQuery
│   │   │   ├── context.ts        # assembleContext (PPR)
│   │   │   ├── graph.ts          # graphQuery
│   │   │   ├── domain.ts         # domainState
│   │   │   ├── status.ts         # workspaceStatus, projectStatus, executionStatus, convergenceStatus
│   │   │   └── tenant.ts         # organization, codebases, projects
│   │   ├── mutations/
│   │   │   ├── node.ts           # putNode, patchNode, deleteNode
│   │   │   ├── batch.ts          # batchMutate, writeWorkItems, updateWorkItems
│   │   │   ├── edge.ts           # putEdge, removeEdges
│   │   │   └── lifecycle.ts      # appendJournal, archiveCycle
│   │   └── subscriptions/
│   │       └── index.ts          # workItemStatusChanged, newFinding, andonTriggered, etc.
│   ├── services/
│   │   ├── neo4j.ts              # Neo4j driver singleton + session factory
│   │   ├── ppr.ts                # Server-side PPR implementation (ported from ideate ppr.ts)
│   │   ├── context-assembly.ts   # Token-budget-aware context packing
│   │   └── id-generator.ts       # Next ID logic (WI-NNN, GP-NN, etc.)
│   ├── middleware/
│   │   ├── auth.ts               # JWT validation → AuthContext (Auth0, stubbed initially)
│   │   └── dev-auth.ts           # Dev-mode auth bypass
│   ├── loaders/
│   │   └── index.ts              # DataLoader instances (node, edges, content)
│   ├── migration/
│   │   ├── cli.ts                # CLI entry point (ideate-migrate)
│   │   ├── discovery.ts          # Walk .ideate/ directory tree
│   │   ├── parser.ts             # YAML parsing + validation
│   │   ├── transformer.ts        # YAML → Neo4j node/relationship transform
│   │   └── writer.ts             # Neo4j write (upsert nodes + relationships)
│   └── types/
│       ├── storage-adapter.ts    # StorageAdapter interface (from adapter-interface.md)
│       └── context.ts            # ResolverContext, AuthContext types
├── tests/
│   ├── unit/
│   │   ├── ppr.test.ts
│   │   ├── id-generator.test.ts
│   │   └── transformer.test.ts
│   ├── integration/
│   │   ├── resolvers/
│   │   │   └── artifact.test.ts
│   │   └── migration/
│   │       └── migrate.test.ts
│   └── helpers/
│       └── neo4j-test-client.ts  # Test utilities for Neo4j setup/teardown
├── docker-compose.yml            # Local dev: Neo4j Community Edition
├── .env.example                  # Environment variable template
├── Dockerfile                    # Production container image
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 3. Initial Dependencies

### Runtime

| Package | Version | Purpose |
|---|---|---|
| `neo4j-driver` | `^5.19.0` | Neo4j Bolt protocol client |
| `@apollo/server` | `^4.10.0` | GraphQL server (Apollo Server 4) |
| `graphql` | `^16.8.1` | GraphQL reference implementation |
| `graphql-ws` | `^5.16.0` | WebSocket transport for subscriptions |
| `ws` | `^8.17.0` | WebSocket server (used with graphql-ws) |
| `graphql-scalars` | `^1.23.0` | JSON scalar, DateTime scalar |
| `dataloader` | `^2.2.2` | Request-scoped DataLoader for N+1 prevention |
| `@graphql-tools/schema` | `^10.0.0` | Schema stitching utilities |
| `zod` | `^3.23.0` | Runtime input validation |
| `commander` | `^12.1.0` | CLI framework for migration tool |
| `js-yaml` | `^4.1.0` | YAML parsing for migration tool |
| `dotenv` | `^16.4.5` | Environment variable loading |
| `pino` | `^9.0.0` | Structured JSON logging |
| `pino-pretty` | `^11.0.0` | Human-readable log output for local dev |

### Dev / Tooling

| Package | Version | Purpose |
|---|---|---|
| `typescript` | `^5.4.5` | TypeScript compiler |
| `vitest` | `^1.6.0` | Test runner (fast, native TS) |
| `@types/node` | `^20.0.0` | Node.js type definitions |
| `@types/ws` | `^8.5.10` | WebSocket type definitions |
| `@types/js-yaml` | `^4.0.9` | YAML type definitions |
| `tsx` | `^4.11.0` | TypeScript execution for dev (replaces ts-node) |
| `eslint` | `^9.3.0` | Linting |
| `@typescript-eslint/eslint-plugin` | `^7.9.0` | TypeScript ESLint rules |
| `@typescript-eslint/parser` | `^7.9.0` | TypeScript ESLint parser |
| `prettier` | `^3.2.5` | Code formatting |
| `@graphql-inspector/core` | `^5.0.0` | SDL validation and schema diffing |

---

## 4. Configuration Templates

### `package.json`

```json
{
  "name": "ideate-server",
  "version": "0.1.0",
  "description": "GraphQL API + Neo4j backend for ideate knowledge graph",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "lint": "eslint src tests",
    "lint:fix": "eslint src tests --fix",
    "format": "prettier --write \"src/**/*.ts\" \"tests/**/*.ts\"",
    "migrate": "tsx src/migration/cli.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@apollo/server": "^4.10.0",
    "@graphql-tools/schema": "^10.0.0",
    "commander": "^12.1.0",
    "dataloader": "^2.2.2",
    "dotenv": "^16.4.5",
    "graphql": "^16.8.1",
    "graphql-scalars": "^1.23.0",
    "graphql-ws": "^5.16.0",
    "js-yaml": "^4.1.0",
    "neo4j-driver": "^5.19.0",
    "pino": "^9.0.0",
    "pino-pretty": "^11.0.0",
    "ws": "^8.17.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@graphql-inspector/core": "^5.0.0",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.0.0",
    "@types/ws": "^8.5.10",
    "@typescript-eslint/eslint-plugin": "^7.9.0",
    "@typescript-eslint/parser": "^7.9.0",
    "eslint": "^9.3.0",
    "prettier": "^3.2.5",
    "tsx": "^4.11.0",
    "typescript": "^5.4.5",
    "vitest": "^1.6.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### `vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/migration/cli.ts"],
    },
    testTimeout: 30000, // 30s for integration tests against Neo4j
  },
});
```

---

## 5. Local Development Setup (Docker Compose)

The Docker Compose setup from `ideate-infra` is the canonical local stack. For standalone ideate-server development before `ideate-infra` is set up, include a minimal `docker-compose.yml` co-located in the repo:

### `docker-compose.yml`

```yaml
version: "3.9"

services:
  neo4j:
    image: neo4j:2026-community
    container_name: ideate-neo4j
    ports:
      - "7474:7474"   # Neo4j Browser
      - "7687:7687"   # Bolt protocol
    environment:
      NEO4J_AUTH: neo4j/${NEO4J_PASSWORD:-localpassword}
      NEO4J_PLUGINS: '["apoc"]'
      NEO4J_dbms_memory_pagecache_size: 512M
      NEO4J_dbms_memory_heap_initial__size: 512M
      NEO4J_dbms_memory_heap_max__size: 1G
    volumes:
      - neo4j_data:/data
      - neo4j_logs:/logs
    # healthcheck for the neo4j container itself — uses cypher-shell to verify the database engine is ready
    healthcheck:
      test: ["CMD", "cypher-shell", "-u", "neo4j", "-p", "${NEO4J_PASSWORD:-localpassword}", "RETURN 1"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s

  # ideate-server (add once the server image is available):
  # server:
  #   build: .
  #   ports:
  #     - "4000:4000"
  #   depends_on:
  #     neo4j:
  #       condition: service_healthy
  #   # Once the server is running, use the /health endpoint for the server container healthcheck.
  #   # The cypher-shell healthcheck above applies to the neo4j container only.
  #   healthcheck:
  #     test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
  #     interval: 10s
  #     timeout: 5s
  #     retries: 5
  #     start_period: 15s

volumes:
  neo4j_data:
  neo4j_logs:
```

### `.env.example`

```bash
# Copy to .env and adjust values
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=localpassword

# Server
PORT=4000
NODE_ENV=development

# Auth (stubbed in development — leave blank to enable dev-mode bypass)
AUTH0_DOMAIN=
AUTH0_AUDIENCE=

# Dev mode: when set, skips JWT validation and uses a static dev AuthContext
IDEATE_DEV_MODE=true
```

### Start Neo4j

```bash
# Copy environment template
cp .env.example .env

# Start Neo4j
docker compose up neo4j

# Verify it's running — open in browser
open http://localhost:7474
# Connect with: bolt://localhost:7687, user: neo4j, password: localpassword

# Start the server (in another terminal)
npm run dev
# GraphQL endpoint: http://localhost:4000/graphql

# Full reset (wipes Neo4j data volume)
docker compose down -v
```

---

## 6. Auth Context Stub

Auth0 is deferred. The server ships with a dev-mode bypass that activates when `IDEATE_DEV_MODE=true` is set (or when `AUTH0_DOMAIN` is absent). No Auth0 tenant, no JWKS endpoint, no JWT library configuration is required during initial development.

The dev AuthContext injected by the stub:

```typescript
// src/middleware/dev-auth.ts
export const devAuth = {
  userId: "dev-user",
  orgId: "dev-org",
  roles: ["OWNER"] as const,
  codebaseAccess: null, // null = access to all codebases
};
```

When Auth0 integration is added in Phase 4 (portal), replace `dev-auth.ts` with a real JWT middleware in `src/middleware/auth.ts`. The `AuthContext` shape does not change — only the middleware that populates it changes.

---

## 7. CI/CD Baseline (GitHub Actions)

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-test-lint:
    runs-on: ubuntu-latest
    timeout-minutes: 15

    services:
      neo4j:
        image: neo4j:2026-community
        ports:
          - 7687:7687
          - 7474:7474
        env:
          NEO4J_AUTH: neo4j/testpassword
          NEO4J_PLUGINS: '["apoc"]'
        options: >-
          --health-cmd "cypher-shell -u neo4j -p testpassword 'RETURN 1'"
          --health-interval 10s
          --health-timeout 5s
          --health-retries 10
          --health-start-period 30s

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Type check
        run: npm run typecheck

      - name: Lint
        run: npm run lint

      - name: Validate SDL
        run: npx graphql-inspector validate src/schema/schema.graphql

      - name: Build
        run: npm run build

      - name: Test
        run: npm test
        env:
          NEO4J_URI: bolt://localhost:7687
          NEO4J_USER: neo4j
          NEO4J_PASSWORD: testpassword
          NODE_ENV: test
          IDEATE_DEV_MODE: "true"
```

This single workflow covers type-checking, linting, build verification, and tests (including integration tests against the ephemeral Neo4j service container). No separate lint or build jobs are needed at this stage.

---

## 8. Health Endpoint

The server exposes a plain HTTP `/health` endpoint (not a GraphQL operation). It is used by Docker Compose healthchecks, load balancers, and uptime monitors.

### Behavior

| Condition | HTTP status | Response body |
|---|---|---|
| Neo4j reachable | 200 | `{"status": "ok", "neo4j": "connected"}` |
| Neo4j unreachable | 503 | `{"status": "error", "neo4j": "disconnected"}` |

### Implementation notes

- Register the endpoint before Apollo's middleware so it does not go through the GraphQL stack.
- Check Neo4j connectivity using `driver.verifyConnectivity()`. Catch any thrown error and return the 503 response.
- Response `Content-Type` must be `application/json`.

### Example handler (Express / raw HTTP)

```typescript
// src/health.ts
import type { Driver } from "neo4j-driver";
import type { IncomingMessage, ServerResponse } from "node:http";

export async function healthHandler(
  driver: Driver,
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    await driver.verifyConnectivity();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", neo4j: "connected" }));
  } catch {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "error", neo4j: "disconnected" }));
  }
}
```

Wire it in `src/index.ts` before Apollo's `expressMiddleware` call:

```typescript
app.get("/health", (req, res) => healthHandler(driver, req, res));
```

---

## 9. Logging Strategy

Use **pino** for structured JSON logging. Pino is fast, has low overhead, and produces machine-readable output suitable for log aggregation (Datadog, CloudWatch, etc.). In local dev, pipe through `pino-pretty` for human-readable output.

### Start command (local dev)

```bash
npm run dev | npx pino-pretty
```

### Required fields on every log line

Every log entry must include these fields:

| Field | Type | Source | Notes |
|---|---|---|---|
| `orgId` | string | Auth context | `'dev'` in local / dev-mode |
| `requestId` | string (UUID) | Generated per request | Use `crypto.randomUUID()` |
| `operationName` | string \| null | GraphQL operation name | Null for introspection or unknown |
| `durationMs` | number | Request lifecycle | Milliseconds, integer |

Add these fields to every logger instance via child logger:

```typescript
// src/middleware/logging.ts
import pino from "pino";

export const rootLogger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export function requestLogger(orgId: string, requestId: string) {
  return rootLogger.child({ orgId, requestId });
}
```

Attach `operationName` and `durationMs` at the end of the request lifecycle once both values are known.

### Log levels by event category

| Event category | Level | Notes |
|---|---|---|
| Neo4j connection failure | `ERROR` | Logged by `driver.verifyConnectivity()` catch blocks and session error handlers |
| Slow query (>1 s) | `WARN` | Log `operationName`, `durationMs`, and (if available) query type |
| Mutation completed | `INFO` | Log `operationName`, mutation type, affected node count |
| Query details (Cypher, params) | `DEBUG` | Do not log in production; may contain PII or large payloads |
| Server startup / shutdown | `INFO` | Port, Neo4j URI (no credentials) |

---

## 10. Testing Strategy

### Unit tests

Unit tests mock the Neo4j driver. They do not require a running Neo4j instance and must run without any external dependencies.

**What to unit test:**
- PPR service logic (`src/services/ppr.ts`)
- ID generation (`src/services/id-generator.ts`)
- YAML transformer logic (`src/migration/transformer.ts`)
- Resolver helper functions (input validation, pagination cursor encode/decode)

**Mocking pattern:**

```typescript
// tests/helpers/mock-driver.ts
import { vi } from "vitest";

export function createMockDriver() {
  const session = {
    run: vi.fn().mockResolvedValue({ records: [] }),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    session: vi.fn().mockReturnValue(session),
    verifyConnectivity: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    _session: session, // expose for per-test assertion setup
  };
}
```

### Integration tests

Integration tests run against a real Neo4j instance using an ephemeral container (same image as the CI workflow: `neo4j:2026-community`).

**Setup:**
- `tests/helpers/neo4j-test-client.ts` manages driver creation, constraint/index initialization, and per-test database cleanup.
- Each test suite creates its own isolated set of nodes using a test-run-scoped `orgId` prefix to avoid cross-test contamination.
- The CI workflow (see section 7) provides the Neo4j service container automatically.

**What to integration test:**
- All CRUD resolvers (`putNode`, `patchNode`, `deleteNode`, `batchMutate`)
- Relationship resolvers (`putEdge`, `removeEdges`)
- Query resolvers with real data (`artifact`, `artifactQuery`, `graphQuery`)
- Migration writer (`src/migration/writer.ts`) — upsert correctness, idempotency

### Contract tests (Phase 3 dependency)

The contract test suite from **WI-555** (adapter-level tests defined against the `StorageAdapter` interface) will be run against the `RemoteAdapter` in Phase 3. These tests validate that `ideate-server` satisfies the same contract as the local YAML adapter.

**Dependency:** The `RemoteAdapter` implementation and the WI-555 contract suite must both be complete before Phase 3 contract testing can run. Do not duplicate the WI-555 test suite here — import and reuse it.

### Test file layout

```
tests/
├── unit/
│   ├── ppr.test.ts
│   ├── id-generator.test.ts
│   ├── transformer.test.ts
│   └── health.test.ts          # healthHandler unit test (mock driver)
├── integration/
│   ├── resolvers/
│   │   ├── artifact.test.ts
│   │   ├── mutation.test.ts
│   │   └── query.test.ts
│   └── migration/
│       └── migrate.test.ts
└── helpers/
    ├── neo4j-test-client.ts
    └── mock-driver.ts
```

---

## 11. Scaffold the Project

```bash
# From the repo root
mkdir -p src/{schema,resolvers/{queries,mutations,subscriptions},services,middleware,loaders,migration,types}
mkdir -p tests/{unit,integration/{resolvers,migration},helpers}

# Install dependencies
npm install

# Copy the SDL from the ideate plugin repo into the server repo
cp /path/to/ideate/docs/platform/graphql-schema.graphql src/schema/schema.graphql

# Validate the GraphQL SDL parses without errors
npx graphql-inspector validate src/schema/schema.graphql

# Verify TypeScript compiles
npm run typecheck

# Start Neo4j
docker compose up neo4j

# Start dev server
npm run dev
# → Server running at http://localhost:4000/graphql
# → Health endpoint: http://localhost:4000/health
```

> **SDL validation:** `graphql-inspector validate` confirms the SDL file is well-formed and all referenced types are defined. The SDL originates from the `ideate` plugin repo at `docs/platform/graphql-schema.graphql` — copy it to `src/schema/schema.graphql` during initial setup and when the SDL is updated upstream. Run validation whenever the SDL changes.

---

## 12. Initialize ideate in This Repo

Once the repo is scaffolded (or even before — ideate:init works on an empty repo), run ideate to plan the implementation work.

### What to provide as context

Open the following files in your Claude Code session before running `ideate:init`. These give ideate the full picture of what needs to be built:

| File | What it covers |
|---|---|
| `docs/platform/steering.md` | Platform vision, architecture, roadmap, technology decisions |
| `docs/platform/adapter-interface.md` | StorageAdapter TypeScript interface the server must implement (WI-543) |
| `docs/platform/neo4j-schema.md` | Neo4j node labels, relationships, constraints, indexes (WI-544) |
| `docs/platform/graphql-schema.md` | GraphQL API design: queries, mutations, subscriptions, auth, pagination (WI-545) |
| `docs/platform/graphql-schema.graphql` | Complete GraphQL SDL |
| `docs/platform/migration-tool-spec.md` | Migration CLI specification (WI-549) |

### Run ideate:init

```bash
cd ideate-server
/ideate:init
```

When prompted for **project intent**, use exactly:

> `GraphQL API + Neo4j backend for ideate knowledge graph with server-side PPR, multi-tenant support, and migration tooling`

When prompted about the first phase or initial scope, suggest:

> **Phase: "Core API + Schema"** — Implement the Neo4j schema (node labels, relationships, constraints, indexes), wire up Apollo Server with the complete GraphQL SDL, and build CRUD resolvers for the core artifact types. Exclude PPR, subscriptions, and the migration CLI (those are follow-on phases).

### What ideate:init will produce

With the spec documents as context, ideate:init will create work items for the server implementation in `.ideate/`. Expected first-phase work items include:

- Neo4j schema initialization (constraints, indexes, seed Organization/Codebase nodes)
- Apollo Server bootstrap (HTTP + WebSocket transport)
- Core resolvers: `artifact`, `artifactQuery`, `graphQuery`, `putNode`, `patchNode`, `deleteNode`, `batchMutate`
- Dev-mode auth middleware stub
- DataLoader setup (node, edges, content)
- Integration test scaffold (Neo4j test client, fixture helpers)

PPR implementation, subscriptions, the migration CLI, and RemoteAdapter integration are planned in subsequent phases.

---

## 13. After Bootstrap

Once the repo is scaffolded and `ideate:init` has run:

1. **Start Neo4j**: `cd docker && docker compose up neo4j` — verifies your local Neo4j is working
2. **Run the schema init script**: Execute the Cypher initialization script from `neo4j-schema.md` Section 10 against your local Neo4j instance. Verify all constraints and indexes are created.
3. **Validate the SDL**: `npx graphql-inspector validate src/schema/schema.graphql` — confirms the SDL you copied is syntactically valid
4. **Begin executing**: Run `/ideate:execute` in the server repo to start building from the work items `ideate:init` created

The spec documents in the `ideate` repo (`docs/platform/`) are the authoritative references throughout implementation. The key ones:

- `graphql-schema.graphql` + `graphql-schema.md` — what the API looks like
- `neo4j-schema.md` — what the database looks like
- `adapter-interface.md` — the interface contract the server must satisfy
- `migration-tool-spec.md` — the migration CLI spec (critical path for dogfooding)
