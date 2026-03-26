#!/bin/sh
# Startup wrapper for ideate-artifact-server.
# Installs dependencies on first run if node_modules is missing,
# builds the TypeScript sources if dist/.build-version is missing or stale,
# then starts the MCP server.

DIR="$(cd "$(dirname "$0")" && pwd)"

# Check for .package-lock.json — created by npm only after a successful install.
# Checking the directory alone is unreliable: a partial install leaves node_modules
# present but incomplete, causing silent failures on startup.
if [ ! -f "$DIR/node_modules/.package-lock.json" ]; then
  echo "ideate-artifact-server: installing dependencies (first run)..." >&2
  npm install --prefix "$DIR" --silent
  if [ $? -ne 0 ]; then
    echo "ideate-artifact-server: npm install failed — check that node and npm are in PATH" >&2
    exit 1
  fi
fi

# Check whether the built dist/ matches the current package.json version.
# dist/.build-version contains the version string written after the last successful build.
PKG_VERSION="$(node -e "process.stdout.write(require('$DIR/package.json').version)")"
BUILD_VERSION_FILE="$DIR/dist/.build-version"

if [ ! -f "$BUILD_VERSION_FILE" ] || [ "$(cat "$BUILD_VERSION_FILE")" != "$PKG_VERSION" ]; then
  echo "ideate-artifact-server: building (version $PKG_VERSION)..." >&2
  npm run build --prefix "$DIR"
  if [ $? -ne 0 ]; then
    echo "ideate-artifact-server: npm run build failed" >&2
    exit 1
  fi
  printf '%s' "$PKG_VERSION" > "$BUILD_VERSION_FILE"
fi

exec node "$DIR/dist/index.js"
