# ideate-artifact-server

An MCP server that indexes ideate YAML artifacts in SQLite and serves them to agents via focused tool calls. Replaces repeated `Read`/`Glob` calls with single queries. Supports both read and write operations.

## Quick start

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "ideate-artifact-server": {
      "command": "sh",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/artifact-server/start.sh"],
      "env": {
        "CLAUDE_PLUGIN_ROOT": "."
      }
    }
  }
}
```

`start.sh` installs dependencies and builds TypeScript on first run, then starts the server. No manual build step required.

## Tools

All 22 tools are scoped to a single project root configured at server startup.

### Read tools

| Tool | What it does |
|---|---|
| `ideate_get_artifact_context` | Context package for any artifact by ID: work item, phase, or generic artifact |
| `ideate_get_context_package` | Full project context: principles, constraints, architecture, policies, strategy |
| `ideate_get_config` | Parsed project config with defaults (agent_budgets, model_overrides, ppr) |
| `ideate_artifact_query` | Query artifacts by type with filters, pagination, and graph traversal |
| `ideate_get_execution_status` | Work item counts by status; ready-to-start items |
| `ideate_get_review_manifest` | Review manifest for a cycle: items reviewed, reviewers, verdict |
| `ideate_get_convergence_status` | Open findings by severity; convergence assessment for a cycle |
| `ideate_get_domain_state` | Domain knowledge: policies, decisions, questions, optionally filtered by domain |
| `ideate_get_workspace_status` | Current cycle, work item counts, journal entries, open questions |
| `ideate_get_metrics` | Aggregated metrics by agent, work item, or cycle scope |
| `ideate_assemble_context` | PPR-ranked context assembled within a token budget from seed artifact IDs |
| `ideate_get_next_id` | Next available ID for a given artifact type |

### Write tools

| Tool | What it does |
|---|---|
| `ideate_append_journal` | Append an entry to the project journal |
| `ideate_archive_cycle` | Archive a completed review cycle with its summary artifacts |
| `ideate_write_work_items` | Write or create work items atomically |
| `ideate_update_work_items` | Update work item fields (status, scope, criteria, etc.) without full overwrite |
| `ideate_write_artifact` | Write any artifact to the project store (findings, policies, decisions, phases, etc.) |
| `ideate_emit_event` | Fire registered hooks for a lifecycle event |
| `ideate_emit_metric` | Record a metric event for the current session |
| `ideate_bootstrap_workspace` | Initialize workspace artifacts for a new project |
| `ideate_manage_autopilot_state` | Get or update autopilot state for crash recovery and persistence |
| `ideate_update_config` | Deep-merge a partial patch into the project config |

## Architecture

```
src/
├── index.ts          # Entry point: MCP SDK wiring, tool dispatch, graceful shutdown
├── server.ts         # Server initialization, index build, watcher startup
├── config.ts         # Config loading with defaults (agent_budgets, model_overrides, ppr)
├── schema.ts         # SQLite schema definitions and migrations
├── db.ts             # Database connection management
├── db-helpers.ts     # Low-level SQL query helpers
├── indexer.ts        # Artifact indexing: YAML parsing, graph edge extraction, upserts
├── ppr.ts            # Personalized PageRank context assembly
├── watcher.ts        # chokidar file watcher — triggers re-index on artifact changes
├── hooks.ts          # Hook registration and event dispatch
├── migrations.ts     # Schema version migrations
├── types.ts          # Shared TypeScript types
└── tools/
    ├── index.ts      # TOOLS array (all 22 definitions) and handleTool dispatcher
    ├── context.ts    # ideate_get_artifact_context, ideate_get_context_package, ideate_assemble_context
    ├── query.ts      # ideate_artifact_query, ideate_get_next_id
    ├── execution.ts  # ideate_get_execution_status, ideate_get_review_manifest
    ├── analysis.ts   # ideate_get_convergence_status, ideate_get_domain_state, ideate_get_workspace_status
    ├── write.ts      # ideate_append_journal, ideate_archive_cycle, ideate_write_work_items, ideate_update_work_items, ideate_write_artifact
    ├── events.ts     # ideate_emit_event
    ├── metrics.ts    # ideate_emit_metric, ideate_get_metrics
    ├── bootstrap.ts  # ideate_bootstrap_workspace
    ├── autopilot-state.ts  # ideate_manage_autopilot_state
    └── config.ts     # ideate_update_config, ideate_get_config
```

Artifacts are indexed into SQLite on startup. The watcher re-indexes changed files incrementally. Tool calls block until the initial index build completes.

## Development

```bash
cd mcp/artifact-server
npm install
npm run build   # compile TypeScript to dist/
npm test        # run vitest test suite
```

## TLS Configuration

For production deployments using the RemoteAdapter to connect to ideate-server over HTTPS, see [TLS Configuration Guide](docs/tls-configuration.md).

Quick example:
```typescript
const adapter = new RemoteAdapter({
  endpoint: "https://ideate-server.example.com/graphql",
  org_id: "my-org",
  codebase_id: "my-codebase",
  auth_token: process.env.IDEATE_AUTH_TOKEN,
});
```

For mTLS (mutual TLS) authentication, see the full guide.
