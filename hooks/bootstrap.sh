#!/bin/sh
# hooks/bootstrap.sh — ensure the plugin's built output (dist/) and its one
# runtime dependency (node_modules) exist, building them on first launch.
#
# Claude Code installs a plugin by cloning it into a cache with NO build step
# and NO runtime bundled, so a fresh install has neither dist/ nor node_modules.
# This script closes that gap. It is written in POSIX sh (not Node) so it can
# run and report a clear message even when Node is absent.
#
# Contract:
#   - Writes ONLY to stderr. stdout is reserved for the MCP stdio protocol and
#     the priming digest — a single stray byte on stdout would corrupt them.
#   - Idempotent: fast-path exits when already built.
#   - Concurrency-safe: an atomic mkdir lock so the MCP launcher and the
#     SessionStart hook never build at the same time.
#   - Always exits 0. It never blocks or fails the host session; on an
#     unrecoverable problem it prints actionable guidance and returns.

ROOT="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"

# Fast path: already built with deps present.
if [ -f "$ROOT/dist/server.js" ] && [ -d "$ROOT/node_modules/@modelcontextprotocol" ]; then
  exit 0
fi

# Runtime prerequisite: Node must be present and recent enough for node:sqlite.
if ! command -v node >/dev/null 2>&1; then
  echo "ideate: Node.js was not found on PATH. ideate requires Node >=22.5 (https://nodejs.org)." >&2
  echo "ideate: Claude Code bundles no runtime; install Node and restart to enable the ideate MCP server, hooks, and CLIs." >&2
  exit 0
fi
if ! node -e 'var v=process.versions.node.split(".").map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)' 2>/dev/null; then
  echo "ideate: Node $(node -v 2>/dev/null) is too old — ideate requires Node >=22.5 (it uses the built-in node:sqlite). Please upgrade and restart." >&2
  exit 0
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ideate: npm was not found on PATH, so dependencies cannot be installed. Run 'npm install && npm run build' in $ROOT, then restart." >&2
  exit 0
fi

# Concurrency lock (mkdir is atomic across processes). Clear a stale lock left
# by a crashed prior run (>10 min old).
LOCK="$ROOT/.bootstrap.lock"
[ -d "$LOCK" ] && find "$LOCK" -maxdepth 0 -mmin +10 -exec rmdir {} \; 2>/dev/null

if mkdir "$LOCK" 2>/dev/null; then
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
  echo "ideate: first-launch setup — installing dependencies and building (one-time; may take a minute)..." >&2
  # 1>&2 : npm's own stdout must never reach the caller's stdout.
  if ( cd "$ROOT" && npm install --no-audit --no-fund --loglevel=error 1>&2 && npm run build 1>&2 ); then
    echo "ideate: setup complete." >&2
  else
    echo "ideate: setup FAILED. Run 'npm install && npm run build' in $ROOT manually, then restart." >&2
  fi
else
  # Another process holds the lock and is building — wait (bounded) for dist.
  echo "ideate: waiting for a concurrent first-launch build to finish..." >&2
  i=0
  while [ ! -f "$ROOT/dist/server.js" ] && [ "$i" -lt 180 ]; do
    sleep 1
    i=$((i + 1))
  done
fi
exit 0
