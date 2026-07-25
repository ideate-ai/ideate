#!/bin/sh
# hooks/bootstrap.sh — ensure the plugin's built output (dist/) and its one
# runtime dependency (node_modules) exist AND ARE CURRENT, (re)building them on
# first launch or after a plugin update.
#
# Claude Code installs a plugin by cloning it into a cache with NO build step
# and bundles no runtime, so a fresh install has neither dist/ nor node_modules.
# A plugin update is a git operation on that same clone: it refreshes the
# tracked src/ but leaves the gitignored, untracked dist//node_modules in place
# — so an existence-only check would keep running stale compiled code forever.
# This script therefore rebuilds whenever any source is newer than the build
# output, not only when the output is absent.
#
# Written in POSIX sh (not Node) so it can run and report clearly even when Node
# is absent. Contract:
#   - Writes ONLY to stderr. stdout is reserved for the MCP stdio protocol and
#     the priming digest — one stray byte there corrupts them.
#   - Concurrency-safe via a liveness-aware lock: it waits while the builder is
#     alive, reclaims only a DEAD builder's lock, and never steals a live one.
#   - Always exits 0. It never blocks/fails the host; on an unrecoverable
#     problem it prints actionable guidance and returns.

ROOT="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"

# Fresh = built, deps present, and no source newer than the build output.
is_fresh() {
  [ -f "$ROOT/dist/server.js" ] || return 1
  [ -d "$ROOT/node_modules/@modelcontextprotocol" ] || return 1
  # Any src/package.json/tsconfig.json newer than dist/server.js => stale.
  [ -z "$(find "$ROOT/src" "$ROOT/package.json" "$ROOT/tsconfig.json" \
            -newer "$ROOT/dist/server.js" -print 2>/dev/null | head -n 1)" ]
}

# Fast path: already built and current.
is_fresh && exit 0

# Runtime prerequisite: Node present and recent enough for node:sqlite.
if ! command -v node >/dev/null 2>&1; then
  echo "ideate: Node.js was not found on PATH. ideate requires Node >=22.5 (https://nodejs.org)." >&2
  echo "ideate: Claude Code bundles no runtime; install Node and restart to enable the ideate MCP server, hooks, and CLIs." >&2
  exit 0
fi
if ! node -e 'var v=process.versions.node.split(".").map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)' 2>/dev/null; then
  echo "ideate: Node $(node -v 2>/dev/null) is too old — ideate requires Node >=22.5 (it uses node:sqlite). Please upgrade and restart." >&2
  exit 0
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ideate: npm was not found on PATH, so dependencies cannot be installed. Run 'npm install && npm run build' in $ROOT, then restart." >&2
  exit 0
fi

run_build() {
  echo "ideate: setup — installing dependencies and building (may take a minute)..." >&2
  # 1>&2 : npm's own stdout must never reach the caller's stdout.
  if ( cd "$ROOT" && npm install --no-audit --no-fund --loglevel=error 1>&2 && npm run build 1>&2 ); then
    echo "ideate: setup complete." >&2
    return 0
  fi
  echo "ideate: setup FAILED. Run 'npm install && npm run build' in $ROOT manually, then restart." >&2
  return 1
}

# Build under an exclusive lock. mkdir is atomic; the lock records the builder's
# PID so contenders can tell a live builder from a crashed one.
LOCK="$ROOT/.bootstrap.lock"
attempt=0
while [ "$attempt" -lt 4 ]; do
  attempt=$((attempt + 1))
  if mkdir "$LOCK" 2>/dev/null; then
    echo "$$" >"$LOCK/pid" 2>/dev/null
    trap 'rm -rf "$LOCK" 2>/dev/null' EXIT INT TERM
    run_build
    exit 0
  fi
  # Lock is held. Is the holder still alive?
  holder="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    echo "ideate: waiting for a concurrent first-launch build (pid $holder)..." >&2
    waited=0
    while kill -0 "$holder" 2>/dev/null; do
      is_fresh && exit 0
      [ "$waited" -ge 900 ] && break   # 15-min safety cap on a stuck holder
      sleep 2
      waited=$((waited + 2))
    done
    is_fresh && exit 0
    # Holder died (or capped) without producing a fresh build → reclaim + re-race.
  else
    # Stale lock: no live holder (crashed builder, or empty/foreign pid). Reclaim.
    rm -rf "$LOCK" 2>/dev/null
  fi
done
echo "ideate: could not acquire the build lock after several attempts; run 'npm install && npm run build' in $ROOT, then restart." >&2
exit 0
