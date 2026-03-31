#!/usr/bin/env bash
# migrate-to-hierarchy.sh — Bootstrap project/phase hierarchy artifacts (WI-442)
#
# Creates the planning hierarchy artifacts needed for the project/phase hierarchy
# introduced in the cycle change plan. This script operates offline directly on
# YAML files — it does not require the MCP server to be running.
#
# What it does:
#   1. Creates .ideate/projects/PR-001.yaml  (retroactive project artifact)
#   2. Creates .ideate/phases/PH-001.yaml   (single implementation phase with all non-obsolete WIs)
#   3. Updates .ideate/config.json          (schema_version → 3, circuit_breaker/appetite defaults)
#
# Usage:
#   scripts/migrate-to-hierarchy.sh [--dry-run] [<artifact-dir>]
#
#   <artifact-dir>  Path to .ideate/ directory (default: .ideate/ relative to cwd)
#   --dry-run       Print what would be created/changed without writing anything
#
# Exit codes: 0 = success, 1 = error

set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────────────

DRY_RUN=false
ARTIFACT_DIR=""

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    -*)        echo "ERROR: unknown option: $arg" >&2; exit 1 ;;
    *)         ARTIFACT_DIR="$arg" ;;
  esac
done

# Default to .ideate/ relative to cwd if not specified
if [[ -z "$ARTIFACT_DIR" ]]; then
  ARTIFACT_DIR="$(pwd)/.ideate"
fi

# ── Validate .ideate/ exists ──────────────────────────────────────────────────

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  echo "ERROR: artifact directory does not exist: $ARTIFACT_DIR" >&2
  echo "  Run this script from your project root, or pass the path to .ideate/ as an argument." >&2
  exit 1
fi

ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
CREATED=()
UPDATED=()
SKIPPED=()

# ── Helpers ───────────────────────────────────────────────────────────────────

say() { echo "$1"; }

would() {
  # In dry-run mode, announce what would happen but do nothing.
  echo "  [dry-run] would: $1"
}

write_file() {
  local path="$1"
  local content="$2"
  local label="$3"

  if [[ "$DRY_RUN" == true ]]; then
    would "create $path"
  else
    mkdir -p "$(dirname "$path")"
    printf '%s\n' "$content" > "$path"
    CREATED+=("$label")
    say "  created: $path"
  fi
}

# ── Step 1: Extract project intent from overview.yaml ────────────────────────

OVERVIEW_FILE="$ARTIFACT_DIR/plan/overview.yaml"
PROJECT_TITLE="Ideate structured SDLC workflow"
PROJECT_INTENT="A Claude Code plugin providing a structured SDLC workflow — taking rough ideas through planning, execution, review, and refinement."

if [[ -f "$OVERVIEW_FILE" ]]; then
  # Extract title line (field: title: ...)
  RAW_TITLE="$(grep -m1 '^title:' "$OVERVIEW_FILE" | sed 's/^title:[[:space:]]*//' | sed 's/^"\(.*\)"$/\1/' || true)"
  if [[ -n "$RAW_TITLE" ]]; then
    PROJECT_TITLE="$RAW_TITLE"
  fi

  # Extract first line of body for a short intent blurb (strip leading "## ..." headers)
  RAW_BODY_FIRST="$(grep -A1 '^body:' "$OVERVIEW_FILE" | tail -1 | sed 's/^[[:space:]]*//' || true)"
  if [[ -n "$RAW_BODY_FIRST" && "$RAW_BODY_FIRST" != "|-" && "$RAW_BODY_FIRST" != "|" ]]; then
    PROJECT_INTENT="$RAW_BODY_FIRST"
  fi
  say "Extracted intent from: $OVERVIEW_FILE"
else
  say "WARNING: $OVERVIEW_FILE not found — using defaults for project intent"
fi

# ── Step 2: Build non-obsolete work item list ─────────────────────────────────

WI_DIR="$ARTIFACT_DIR/work-items"
NON_OBSOLETE_WIS=()

if [[ -d "$WI_DIR" ]]; then
  for wi_file in "$WI_DIR"/WI-*.yaml; do
    [[ -f "$wi_file" ]] || continue
    wi_status="$(grep -m1 '^status:' "$wi_file" | sed 's/^status:[[:space:]]*//' || echo "unknown")"
    if [[ "$wi_status" != "obsolete" && "$wi_status" != "cancelled" ]]; then
      wi_id="$(basename "$wi_file" .yaml)"
      NON_OBSOLETE_WIS+=("$wi_id")
    fi
  done
fi

WI_COUNT="${#NON_OBSOLETE_WIS[@]}"
say "Found $WI_COUNT non-obsolete work items for phase membership"

# Build YAML list of work item IDs for the phase artifact
WI_LIST_YAML=""
if [[ "$WI_COUNT" -gt 0 ]]; then
  for wi_id in "${NON_OBSOLETE_WIS[@]}"; do
    WI_LIST_YAML+="  - ${wi_id}"$'\n'
  done
fi
# Trim trailing newline
WI_LIST_YAML="${WI_LIST_YAML%$'\n'}"

# ── Step 3: Create PR-001.yaml ────────────────────────────────────────────────

say ""
say "=== Step 1/3: Project artifact (PR-001) ==="

PROJECTS_DIR="$ARTIFACT_DIR/projects"
PR_FILE="$PROJECTS_DIR/PR-001.yaml"

if [[ -f "$PR_FILE" ]]; then
  say "  skipped: $PR_FILE already exists (idempotent)"
  SKIPPED+=("PR-001.yaml")
else
  PR_CONTENT="id: PR-001
type: project
status: active
appetite: 6

intent: |-
  ${PROJECT_INTENT}

scope_boundary:
  in:
    - \"*\"
  out: []

success_criteria: []

horizon:
  current: PH-001
  next: []
  later: []
"

  write_file "$PR_FILE" "$PR_CONTENT" "PR-001.yaml"
fi

# ── Step 4: Create PH-001.yaml ────────────────────────────────────────────────

say ""
say "=== Step 2/3: Phase artifact (PH-001) ==="

PHASES_DIR="$ARTIFACT_DIR/phases"
PH_FILE="$PHASES_DIR/PH-001.yaml"

if [[ -f "$PH_FILE" ]]; then
  say "  skipped: $PH_FILE already exists (idempotent)"
  SKIPPED+=("PH-001.yaml")
else
  PH_CONTENT="id: PH-001
type: phase
phase_type: implementation
project: PR-001
status: active

intent: |-
  Retroactive phase grouping all existing work items. Contains the full history
  of the workspace prior to the project/phase hierarchy introduction.

work_items:
${WI_LIST_YAML}
"

  write_file "$PH_FILE" "$PH_CONTENT" "PH-001.yaml"
fi

# ── Step 5: Update config.json ────────────────────────────────────────────────

say ""
say "=== Step 3/3: config.json update ==="

CONFIG_FILE="$ARTIFACT_DIR/config.json"

if [[ ! -f "$CONFIG_FILE" ]]; then
  say "  WARNING: $CONFIG_FILE not found — creating minimal config"
  if [[ "$DRY_RUN" == false ]]; then
    printf '{\n  "schema_version": 3,\n  "circuit_breaker_threshold": 5,\n  "default_appetite": 6\n}\n' > "$CONFIG_FILE"
    CREATED+=("config.json (created fresh)")
  else
    would "create minimal $CONFIG_FILE"
  fi
else
  # Read current config to check which fields are present
  CURRENT_VERSION="$(grep -o '"schema_version"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | grep -o '[0-9]*$' || echo "0")"
  HAS_CIRCUIT="$(grep -c '"circuit_breaker_threshold"' "$CONFIG_FILE" || true)"
  HAS_APPETITE="$(grep -c '"default_appetite"' "$CONFIG_FILE" || true)"

  NEEDS_UPDATE=false

  if [[ "$CURRENT_VERSION" -lt 3 ]]; then
    NEEDS_UPDATE=true
  fi
  if [[ "$HAS_CIRCUIT" -eq 0 ]]; then
    NEEDS_UPDATE=true
  fi
  if [[ "$HAS_APPETITE" -eq 0 ]]; then
    NEEDS_UPDATE=true
  fi

  if [[ "$NEEDS_UPDATE" == false ]]; then
    say "  skipped: config.json already at schema_version 3 with required fields"
    SKIPPED+=("config.json")
  else
    if [[ "$DRY_RUN" == true ]]; then
      [[ "$CURRENT_VERSION" -lt 3 ]]    && would "set schema_version → 3 (currently $CURRENT_VERSION)"
      [[ "$HAS_CIRCUIT" -eq 0 ]]        && would "add circuit_breaker_threshold: 5"
      [[ "$HAS_APPETITE" -eq 0 ]]       && would "add default_appetite: 6"
    else
      # Back up before modifying
      BACKUP="${CONFIG_FILE}.pre-hierarchy-migration"
      if [[ ! -f "$BACKUP" ]]; then
        cp "$CONFIG_FILE" "$BACKUP"
        say "  backed up: $CONFIG_FILE → $BACKUP"
      fi

      # Use Python (standard on macOS/Linux) for safe JSON rewrite.
      # Falls back to a manual sed approach if Python is unavailable.
      if command -v python3 &>/dev/null; then
        python3 - "$CONFIG_FILE" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    cfg = json.load(f)
cfg["schema_version"] = 3
if "circuit_breaker_threshold" not in cfg:
    cfg["circuit_breaker_threshold"] = 5
if "default_appetite" not in cfg:
    cfg["default_appetite"] = 6
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PYEOF
      else
        # Minimal sed fallback — replaces schema_version value in place,
        # then appends missing fields before the closing brace.
        sed -i.bak "s/\"schema_version\"[[:space:]]*:[[:space:]]*[0-9]*/\"schema_version\": 3/" "$CONFIG_FILE"
        if ! grep -q '"circuit_breaker_threshold"' "$CONFIG_FILE"; then
          sed -i.bak 's/}[[:space:]]*$/,\n  "circuit_breaker_threshold": 5\n}/' "$CONFIG_FILE"
        fi
        if ! grep -q '"default_appetite"' "$CONFIG_FILE"; then
          sed -i.bak 's/}[[:space:]]*$/,\n  "default_appetite": 6\n}/' "$CONFIG_FILE"
        fi
        rm -f "${CONFIG_FILE}.bak"
      fi

      UPDATED+=("config.json (schema_version→3, circuit_breaker_threshold, default_appetite)")
      say "  updated: $CONFIG_FILE"
    fi
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

say ""
say "════════════════════════════════════════════"
say "Migration summary"
say "════════════════════════════════════════════"

if [[ "$DRY_RUN" == true ]]; then
  say "  Mode: DRY RUN — no files were written"
  say ""
  say "  Re-run without --dry-run to apply changes."
  exit 0
fi

if [[ "${#CREATED[@]}" -gt 0 ]]; then
  say "  Created:"
  for item in "${CREATED[@]}"; do
    say "    + $item"
  done
fi

if [[ "${#UPDATED[@]}" -gt 0 ]]; then
  say "  Updated:"
  for item in "${UPDATED[@]}"; do
    say "    ~ $item"
  done
fi

if [[ "${#SKIPPED[@]}" -gt 0 ]]; then
  say "  Skipped (already present):"
  for item in "${SKIPPED[@]}"; do
    say "    = $item"
  done
fi

if [[ "${#CREATED[@]}" -eq 0 && "${#UPDATED[@]}" -eq 0 ]]; then
  say "  Nothing to do — workspace already migrated."
fi

say ""
say "Done."

# ── Self-Check ────────────────────────────────────────────────────────────────
#
# Verify the script's output is coherent before exiting. Failures here
# indicate a bug in the script itself.
#
# Checks:
#   1. PR-001.yaml exists and contains required fields
#   2. PH-001.yaml exists and contains required fields
#   3. config.json schema_version is 3
#   4. config.json has circuit_breaker_threshold and default_appetite

SELF_CHECK_FAILURES=0

check() {
  local desc="$1"
  local result="$2"  # "ok" or an error string
  if [[ "$result" == "ok" ]]; then
    say "  [self-check] PASS: $desc"
  else
    say "  [self-check] FAIL: $desc — $result"
    SELF_CHECK_FAILURES=$(( SELF_CHECK_FAILURES + 1 ))
  fi
}

say ""
say "--- Self-check ---"

# Check PR-001
if [[ -f "$PR_FILE" ]]; then
  check "PR-001.yaml exists" "ok"
  grep -q '^type: project' "$PR_FILE" \
    && check "PR-001 has type=project" "ok" \
    || check "PR-001 has type=project" "type field missing or wrong"
  grep -q '^status: active' "$PR_FILE" \
    && check "PR-001 has status=active" "ok" \
    || check "PR-001 has status=active" "status field missing or wrong"
  grep -q '^appetite: 6$' "$PR_FILE" \
    && check "PR-001 has appetite=6 (integer)" "ok" \
    || check "PR-001 has appetite=6 (integer)" "appetite field missing, wrong, or quoted"
  grep -q '^scope_boundary:' "$PR_FILE" \
    && check "PR-001 has scope_boundary object" "ok" \
    || check "PR-001 has scope_boundary object" "scope_boundary field missing"
  grep -q '^  in:' "$PR_FILE" \
    && check "PR-001 scope_boundary.in is present" "ok" \
    || check "PR-001 scope_boundary.in is present" "scope_boundary.in missing"
  grep -q '^  out: \[\]' "$PR_FILE" \
    && check "PR-001 scope_boundary.out is present" "ok" \
    || check "PR-001 scope_boundary.out is present" "scope_boundary.out missing"
  grep -q '^horizon:' "$PR_FILE" \
    && check "PR-001 has horizon object" "ok" \
    || check "PR-001 has horizon object" "horizon field missing"
  grep -q '^  current: PH-001' "$PR_FILE" \
    && check "PR-001 horizon.current=PH-001" "ok" \
    || check "PR-001 horizon.current=PH-001" "horizon.current missing or wrong"
  ! grep -q '^title:' "$PR_FILE" \
    && check "PR-001 has no title field" "ok" \
    || check "PR-001 has no title field" "title field must not be present"
  ! grep -q '^created_at:' "$PR_FILE" \
    && check "PR-001 has no created_at field" "ok" \
    || check "PR-001 has no created_at field" "created_at field must not be present"
  ! grep -q '^current_phase:' "$PR_FILE" \
    && check "PR-001 has no current_phase field" "ok" \
    || check "PR-001 has no current_phase field" "current_phase field must not be present"
else
  check "PR-001.yaml exists" "file not found: $PR_FILE"
fi

# Check PH-001
if [[ -f "$PH_FILE" ]]; then
  check "PH-001.yaml exists" "ok"
  grep -q '^phase_type: implementation' "$PH_FILE" \
    && check "PH-001 has phase_type=implementation" "ok" \
    || check "PH-001 has phase_type=implementation" "phase_type missing or wrong"
  grep -q '^project: PR-001' "$PH_FILE" \
    && check "PH-001 links to PR-001" "ok" \
    || check "PH-001 links to PR-001" "project field missing or wrong"
  ! grep -q '^title:' "$PH_FILE" \
    && check "PH-001 has no title field" "ok" \
    || check "PH-001 has no title field" "title field must not be present"
  ! grep -q '^created_at:' "$PH_FILE" \
    && check "PH-001 has no created_at field" "ok" \
    || check "PH-001 has no created_at field" "created_at field must not be present"
else
  check "PH-001.yaml exists" "file not found: $PH_FILE"
fi

# Check config.json
if [[ -f "$CONFIG_FILE" ]]; then
  FINAL_VERSION="$(grep -o '"schema_version"[[:space:]]*:[[:space:]]*[0-9]*' "$CONFIG_FILE" | grep -o '[0-9]*$' || echo "0")"
  [[ "$FINAL_VERSION" -eq 3 ]] \
    && check "config.json schema_version=3" "ok" \
    || check "config.json schema_version=3" "got $FINAL_VERSION"

  grep -q '"circuit_breaker_threshold"' "$CONFIG_FILE" \
    && check "config.json has circuit_breaker_threshold" "ok" \
    || check "config.json has circuit_breaker_threshold" "field missing"

  grep -q '"default_appetite"' "$CONFIG_FILE" \
    && check "config.json has default_appetite" "ok" \
    || check "config.json has default_appetite" "field missing"
else
  check "config.json exists" "file not found: $CONFIG_FILE"
fi

if [[ "$SELF_CHECK_FAILURES" -gt 0 ]]; then
  say ""
  say "ERROR: $SELF_CHECK_FAILURES self-check(s) failed — migration may be incomplete." >&2
  exit 1
fi

say "All self-checks passed."
