# ideate artifact server

An MCP server that loads, indexes, and serves ideate artifact content on demand. Replaces the pattern of multiple `Read`/`Glob` tool calls per agent with single focused queries.

The server is **read-only** — it never writes to the artifact directory. It watches for file changes and invalidates cached entries automatically.

## Tools

| Tool | What it does |
|---|---|
| `ideate_get_work_item_context` | Work item spec + module spec + domain policies + research, pre-assembled |
| `ideate_get_context_package` | Shared context package: Architecture, Guiding Principles, Constraints, Source Code Index, Full Document Paths |
| `ideate_artifact_query` | Keyword search across all artifacts — returns top 10 chunks with source citations |
| `ideate_artifact_index` | Full artifact directory structure as JSON with file metadata |
| `ideate_domain_policies` | Active domain policies, optionally filtered by domain name |
| `ideate_source_index` | Source code index table: File | Language | Key Exports |

All tools accept `{project_root}` as a parameter — you can use multiple artifact directories in a single server session without reconfiguring.

## Requirements

- **Node.js** ≥ 18.0.0 (ESM + `fs/promises` are used throughout; 20 LTS recommended)
- **npm** ≥ 9

**Supported platforms** (prebuilt native binaries available):

| Platform | Supported |
|---|---|
| macOS x64 (Intel, ≥ 10.14) | ✅ |
| macOS arm64 (Apple Silicon) | ✅ |
| Linux x64, glibc ≥ 2.17 (Ubuntu 16.04+, Debian 9+, RHEL 7+) | ✅ |
| Linux arm64, glibc | ✅ |
| Windows x64 | ✅ |
| Alpine Linux / musl libc | ⚠️ `onnxruntime-node` has no musl prebuilt — semantic search (RAG) unavailable |
| Linux 32-bit / armv7 | ❌ |

The server has three native dependencies: `better-sqlite3` (SQLite), `onnxruntime-node` (embeddings via `@xenova/transformers`), and `sharp` (transitive image dep — never called by ideate). On unsupported platforms, `npm install` may fail or skip native modules; the non-RAG tools (`ideate_get_context_package`, `ideate_get_work_item_context`, etc.) do not require native code and may still work.

If prebuilts are missing for your Node version, `npm install` will compile from source — requires a C++ toolchain (`xcode-select --install` on macOS, `build-essential` on Linux).

**The MCP server is optional.** If Node is unavailable or the server fails to start, all ideate skills fall back to reading artifact files directly with no loss of functionality — only the context-assembly optimizations are skipped.

## Build

```bash
cd mcp/artifact-server
npm install
npm run build
```

> **Plugin users**: `dist/` is pre-built and committed to the repository. No build step is needed when installing via the Claude Code marketplace.

## Configure in Claude Code

Add to `.claude/settings.json` (or the project's MCP settings):

```json
{
  "mcpServers": {
    "ideate-artifact-server": {
      "command": "node",
      "args": ["/absolute/path/to/ideate/mcp/artifact-server/dist/index.js"]
    }
  }
}
```

Or using `npx` / `ts-node` for development:

```json
{
  "mcpServers": {
    "ideate-artifact-server": {
      "command": "node",
      "args": ["--loader", "ts-node/esm", "/absolute/path/to/ideate/mcp/artifact-server/src/index.ts"]
    }
  }
}
```

## Usage in skill prompts

### Availability check pattern

Skills check for MCP tool availability at runtime and fall back to inline assembly if the server is not configured:

```
If MCP tool `ideate_get_context_package` is available:
  context_package = call ideate_get_context_package({project_root})
Else:
  [assemble inline from architecture.md, guiding-principles.md, constraints.md]
```

### Example tool calls

```
ideate_get_work_item_context(
  project_root: "/path/to/specs",
  work_item_id: "082"
)

ideate_get_context_package(
  project_root: "/path/to/specs"
)

ideate_artifact_query(
  project_root: "/path/to/specs",
  query: "caching invalidation strategy"
)

ideate_domain_policies(
  project_root: "/path/to/specs",
  domain: "workflow"
)

ideate_source_index(
  project_root: "/path/to/specs",
  source_dir: "/path/to/project/src"
)
```

## Architecture

- **`src/index.ts`** — Server entry point. Registers tools with the MCP SDK, handles `CallTool` dispatch, manages graceful shutdown.
- **`src/tools.ts`** — Tool definitions (JSON Schema) and argument parsing/dispatch.
- **`src/indexer.ts`** — All tool implementations. In-memory LRU cache (50MB), file dependency tracking, context package assembly, keyword search.
- **`src/watcher.ts`** — `chokidar`-based file watcher. Emits `change` events that trigger cache invalidation in `indexer.ts`.

### Caching

- Cache key: `{tool_name}:{project_root}:{...tool-specific-args}`
- Each cached response records which files it depended on.
- When chokidar detects a file change, all cache keys that depended on that file are invalidated.
- LRU eviction keeps total cache size under 50MB.

### Response size bounds

| Tool | Target |
|---|---|
| `ideate_get_work_item_context` | 200–500 lines. Research truncated at 1000 lines with pointer to full file. |
| `ideate_get_context_package` | 500–800 lines. Architecture truncated if >300 lines. Stricter filtering above 1000 lines total. |
| `ideate_artifact_query` | Top 10 chunks, each ≤50 lines, with `file:startLine–endLine` citations. |

## Development

```bash
npm run dev   # run with ts-node (no build step)
npm run build # compile to dist/
npm start     # run compiled output
```
