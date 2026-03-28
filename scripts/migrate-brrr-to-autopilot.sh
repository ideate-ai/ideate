#!/usr/bin/env bash
# migrate-brrr-to-autopilot.sh — Rename brrr → autopilot in .ideate/ artifacts
#
# Usage: ./scripts/migrate-brrr-to-autopilot.sh [path]
#
# Takes an optional path argument (defaults to current directory).
# Finds .ideate/ under that path and replaces brrr references with autopilot.
#
# Idempotent: safe to run multiple times.

set -uo pipefail

# ── Argument parsing ─────────────────────────────────────────────────────────

TARGET_DIR="${1:-.}"
TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"

IDEATE_DIR="$TARGET_DIR/.ideate"

if [[ ! -d "$IDEATE_DIR" ]]; then
  echo "ERROR: .ideate/ not found in $TARGET_DIR" >&2
  exit 1
fi

echo "==> migrate-brrr-to-autopilot: $IDEATE_DIR"

FILES_MODIFIED=0

# ── Step 1: Rename brrr-state.yaml → autopilot-state.yaml ───────────────────

if [[ -f "$IDEATE_DIR/brrr-state.yaml" ]]; then
  if [[ -f "$IDEATE_DIR/autopilot-state.yaml" ]]; then
    echo "  WARNING: both brrr-state.yaml and autopilot-state.yaml exist; skipping rename"
  else
    mv "$IDEATE_DIR/brrr-state.yaml" "$IDEATE_DIR/autopilot-state.yaml"
    echo "  renamed: brrr-state.yaml → autopilot-state.yaml"
    FILES_MODIFIED=$((FILES_MODIFIED + 1))
  fi
elif [[ -f "$IDEATE_DIR/autopilot-state.yaml" ]]; then
  echo "  autopilot-state.yaml already exists (already migrated)"
else
  echo "  no brrr-state.yaml or autopilot-state.yaml found (nothing to rename)"
fi

# ── Step 2: Replace brrr references in all YAML files ───────────────────────

# Collect all .yaml files under .ideate/
yaml_files=()
while IFS= read -r -d '' f; do
  yaml_files+=("$f")
done < <(find "$IDEATE_DIR" -name '*.yaml' -type f -print0)

if [[ ${#yaml_files[@]} -eq 0 ]]; then
  echo "  no .yaml files found under .ideate/"
else
  echo "  scanning ${#yaml_files[@]} .yaml files..."

  for f in "${yaml_files[@]}"; do
    # Check if the file contains any brrr references before modifying
    if ! grep -q 'brrr' "$f" 2>/dev/null; then
      continue
    fi

    # Apply replacements in order from most-specific to least-specific
    # to avoid partial replacements

    # Tool name references (most specific, then without ideate_ prefix)
    sed -i '' 's/ideate_get_brrr_state/ideate_get_autopilot_state/g' "$f"
    sed -i '' 's/ideate_update_brrr_state/ideate_update_autopilot_state/g' "$f"
    sed -i '' 's/get_brrr_state/get_autopilot_state/g' "$f"
    sed -i '' 's/update_brrr_state/update_autopilot_state/g' "$f"

    # File/artifact references
    sed -i '' 's/brrr-state/autopilot-state/g' "$f"

    # Skill invocation references
    sed -i '' 's|/ideate:brrr|/ideate:autopilot|g' "$f"
    sed -i '' 's/skill: brrr/skill: autopilot/g' "$f"
    sed -i '' 's/skill: "brrr"/skill: "autopilot"/g' "$f"
    sed -i '' "s/skill: 'brrr'/skill: 'autopilot'/g" "$f"

    # Whole-word brrr → autopilot in remaining prose
    # Use perl for proper \b word boundary support (works on macOS and Linux)
    # This matches "brrr" as a standalone word, including in compounds like
    # "brrr-driven" → "autopilot-driven" and "update_brrr_state" → "update_autopilot_state"
    # but will NOT match inside longer alphabetic words (e.g. "abrrr" would not match)
    perl -pi -e 's/\bbrrr\b/autopilot/g' "$f"

    FILES_MODIFIED=$((FILES_MODIFIED + 1))
  done
fi

# ── Step 3: Delete index.db (MCP server rebuilds on next start) ──────────────

if [[ -f "$IDEATE_DIR/index.db" ]]; then
  rm "$IDEATE_DIR/index.db"
  echo "  deleted: index.db (will be rebuilt by MCP server)"
fi

# ── Report ───────────────────────────────────────────────────────────────────

echo ""
echo "==> Migration complete: $FILES_MODIFIED file(s) modified"
exit 0
