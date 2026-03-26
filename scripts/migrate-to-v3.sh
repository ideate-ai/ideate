#!/usr/bin/env bash
# migrate-to-v3.sh — shell wrapper for migrate-to-v3.ts
#
# Usage:
#   scripts/migrate-to-v3.sh <source-specs-dir> <target-dir> [--dry-run] [--force]
#
# Requires: npx / tsx in PATH

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec npx tsx "$SCRIPT_DIR/migrate-to-v3.ts" "$@"
