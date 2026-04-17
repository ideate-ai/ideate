#!/bin/sh
# restart.sh — Restart the local ideate-artifact-server MCP process after a build.
#
# Usage:
#   cd mcp/artifact-server
#   npm run build && sh scripts/restart.sh
#
# Safety guarantees:
#   - Only kills processes whose command line matches the dist/index.js path
#     WITHIN this repository, not any other Node process on the system.
#   - Skips gracefully if no matching process is found.
#   - Sends SIGTERM first for graceful shutdown; escalates to SIGKILL after ${GRACE}s if the process does not exit.
#
# This script is INTENTIONALLY local-only. It discovers the server by matching
# the absolute path to THIS repository's dist/index.js. Remote-backend
# deployments (Docker, Fly.io, etc.) are unaffected because those processes
# run with different absolute paths.
#
# See docs/deployment-notes.md for operator guidance and the 2026-04-16 incident.

set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$DIR/dist/index.js"

if [ ! -f "$TARGET" ]; then
  echo "[restart] ERROR: $TARGET not found. Run 'npm run build' first." >&2
  exit 1
fi

# Escape regex metacharacters in TARGET before passing to pgrep -f.
# Without this, path components like '.' would be treated as regex wildcards.
TARGET_RE="$(printf '%s' "$TARGET" | sed 's/[.[\*^$]/\\&/g')"

# Find PIDs of node processes whose argv contains our exact dist/index.js path.
# The 'ps' output format varies by OS, so we use pgrep -f when available,
# falling back to manual ps parsing.
PIDS=""
if command -v pgrep > /dev/null 2>&1; then
  PIDS="$(pgrep -f "node.*$TARGET_RE" 2>/dev/null || true)"
fi

if [ -z "$PIDS" ]; then
  echo "[restart] No running ideate-artifact-server process found for $TARGET." >&2
  echo "[restart] Start the server manually: node $TARGET" >&2
  exit 0
fi

for PID in $PIDS; do
  echo "[restart] Sending SIGTERM to PID $PID (ideate-artifact-server)" >&2
  kill -TERM "$PID" 2>/dev/null || true
done

# Wait up to 5 seconds for graceful shutdown, then escalate to SIGKILL.
GRACE=5
ELAPSED=0
STILL_RUNNING=""
while [ "$ELAPSED" -lt "$GRACE" ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  STILL_RUNNING=""
  for PID in $PIDS; do
    if kill -0 "$PID" 2>/dev/null; then
      STILL_RUNNING="$STILL_RUNNING $PID"
    fi
  done
  if [ -z "$STILL_RUNNING" ]; then
    break
  fi
done

if [ -n "$STILL_RUNNING" ]; then
  echo "[restart] Process(es)$STILL_RUNNING still alive after ${GRACE}s; escalating to SIGKILL." >&2
  for PID in $STILL_RUNNING; do
    echo "[restart] Sending SIGKILL to PID $PID" >&2
    kill -KILL "$PID" 2>/dev/null || true
  done
  sleep 1
  STILL_AFTER_KILL=""
  for PID in $STILL_RUNNING; do
    if kill -0 "$PID" 2>/dev/null; then
      STILL_AFTER_KILL="$STILL_AFTER_KILL $PID"
    fi
  done
  if [ -n "$STILL_AFTER_KILL" ]; then
    echo "[restart] ERROR: Process(es)$STILL_AFTER_KILL could not be killed. Check for zombie processes." >&2
    exit 1
  fi
fi

echo "[restart] Done. The MCP host (Claude Desktop / VS Code) will restart the server on next tool call." >&2
