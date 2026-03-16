#!/bin/sh
# Startup wrapper for ideate-artifact-server.
# Installs dependencies on first run if node_modules is missing,
# then starts the MCP server.

DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$DIR/node_modules" ]; then
  echo "ideate-artifact-server: installing dependencies (first run)..." >&2
  npm install --prefix "$DIR" --omit=dev --silent 2>&1 >&2
  if [ $? -ne 0 ]; then
    echo "ideate-artifact-server: npm install failed — check that node/npm are available" >&2
    exit 1
  fi
fi

exec node "$DIR/dist/index.js"
