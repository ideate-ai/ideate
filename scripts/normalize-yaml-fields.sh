#!/usr/bin/env bash
# normalize-yaml-fields.sh — Normalize legacy YAML field names in .ideate/ artifacts
#
# Fixes three classes of legacy field names:
#   1. GP-01: title → name, body → description
#   2. Phases: project_id → project
#   3. Phases: add intent: "" after name: if intent field is absent
#
# Uses Python 3 with a YAML parser to identify which changes are needed,
# then performs surgical line-anchored replacements so multiline block scalars
# are never disrupted.
#
# Usage:
#   scripts/normalize-yaml-fields.sh [--dry-run] [<artifact-dir>]
#
#   <artifact-dir>  Path to .ideate/ directory (default: .ideate/ relative to cwd)
#   --dry-run       Print what would change without writing anything
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

if [[ -z "$ARTIFACT_DIR" ]]; then
  ARTIFACT_DIR="$(pwd)/.ideate"
fi

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  echo "ERROR: artifact directory does not exist: $ARTIFACT_DIR" >&2
  echo "  Run from your project root, or pass the path to .ideate/ as an argument." >&2
  exit 1
fi

ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"

# Require Python 3
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 is required but not found in PATH." >&2
  exit 1
fi

MODIFIED=()
SKIPPED=()
DRY_RUN_ACTIONS=()

say() { echo "$1"; }

# ── Python normalizer ─────────────────────────────────────────────────────────
#
# Invoked once per file. Prints a JSON object describing what changes are
# needed, then (unless --dry-run) applies them and writes the modified content.
#
# We use yaml.safe_load to parse and detect field presence. We then apply
# changes as surgical line-anchored substitutions on the raw text — this
# preserves all multiline block scalars, comments, and formatting exactly.
#
# "Surgical line-anchored" means we only match lines where the key appears at
# column 0 (^key:) so we never accidentally rename a key that appears inside
# a multiline value.

run_normalizer() {
  local file="$1"
  local dry_run_flag="$2"  # "true" or "false"

  python3 - "$file" "$dry_run_flag" <<'PYEOF'
import sys
import re
import yaml

path = sys.argv[1]
dry_run = sys.argv[2] == "true"

with open(path, "r") as f:
    raw = f.read()

try:
    data = yaml.safe_load(raw)
except yaml.YAMLError as e:
    print(f"ERROR: {path}: failed to parse YAML: {e}", file=sys.stderr)
    sys.exit(1)

if not isinstance(data, dict):
    # Not a mapping — nothing to normalize
    print("SKIP:not_a_mapping")
    sys.exit(0)

changes = []
new_raw = raw

# ── GP-01: title → name ───────────────────────────────────────────────────────
# Only rename if 'title' key exists at top level AND 'name' does not.
if "title" in data and "name" not in data:
    # Match line starting with exactly 'title:' at column 0
    new_raw, count = re.subn(r"^title:", "name:", new_raw, count=1, flags=re.MULTILINE)
    if count:
        changes.append("title → name")
    else:
        print(f"ERROR: {path}: could not locate 'title:' line for rename", file=sys.stderr)
        sys.exit(1)

# ── GP-01: body → description ─────────────────────────────────────────────────
# Only rename if 'body' key exists at top level AND 'description' does not.
if "body" in data and "description" not in data:
    new_raw, count = re.subn(r"^body:", "description:", new_raw, count=1, flags=re.MULTILINE)
    if count:
        changes.append("body → description")
    else:
        print(f"ERROR: {path}: could not locate 'body:' line for rename", file=sys.stderr)
        sys.exit(1)

# ── Phases: project_id → project ──────────────────────────────────────────────
if "project_id" in data and "project" not in data:
    new_raw, count = re.subn(r"^project_id:", "project:", new_raw, count=1, flags=re.MULTILINE)
    if count:
        changes.append("project_id → project")
    else:
        print(f"ERROR: {path}: could not locate 'project_id:' line for rename", file=sys.stderr)
        sys.exit(1)

# ── Phases: add intent: "" after name: if missing ────────────────────────────
# Re-parse new_raw to get current state (in case title was just renamed to name)
current_data = yaml.safe_load(new_raw)
if isinstance(current_data, dict) and current_data.get("type") == "phase":
    if "intent" not in current_data:
        # Insert 'intent: ""' on the line immediately after the 'name:' line.
        # The name: line may be:
        #   name: some text
        # We match the full name: line and append the new field on the next line.
        name_pattern = re.compile(r"^(name:.*)$", re.MULTILINE)
        if name_pattern.search(new_raw):
            new_raw = name_pattern.sub(r'\1\nintent: ""', new_raw, count=1)
            changes.append('intent: "" added after name:')
        else:
            print(f"ERROR: {path}: phase missing 'name:' line — cannot insert intent", file=sys.stderr)
            sys.exit(1)

if not changes:
    print("SKIP:already_normalized")
    sys.exit(0)

# ── Validate the modified YAML parses cleanly ─────────────────────────────────
try:
    yaml.safe_load(new_raw)
except yaml.YAMLError as e:
    print(f"ERROR: {path}: modified YAML failed to parse: {e}", file=sys.stderr)
    sys.exit(1)

# ── Report and (optionally) write ─────────────────────────────────────────────
print("CHANGED:" + "|".join(changes))

if not dry_run:
    with open(path, "w") as f:
        f.write(new_raw)
PYEOF
}

# ── Process GP-01 ─────────────────────────────────────────────────────────────

say ""
say "=== Step 1/3: GP-01.yaml (title/body field rename) ==="

GP01="$ARTIFACT_DIR/principles/GP-01.yaml"

if [[ ! -f "$GP01" ]]; then
  say "  WARNING: $GP01 not found — skipping"
  SKIPPED+=("GP-01.yaml (not found)")
else
  result="$(run_normalizer "$GP01" "$DRY_RUN")"
  if [[ "$result" == SKIP:* ]]; then
    say "  skipped: $GP01 (${result#SKIP:})"
    SKIPPED+=("GP-01.yaml")
  elif [[ "$result" == CHANGED:* ]]; then
    changes="${result#CHANGED:}"
    if [[ "$DRY_RUN" == true ]]; then
      say "  [dry-run] would modify: $GP01"
      say "    changes: $changes"
      DRY_RUN_ACTIONS+=("GP-01.yaml: $changes")
    else
      say "  modified: $GP01"
      say "    changes: $changes"
      MODIFIED+=("GP-01.yaml: $changes")
    fi
  fi
fi

# ── Process phase files ───────────────────────────────────────────────────────

say ""
say "=== Step 2/3 & 3/3: PH-*.yaml (project_id rename + intent field) ==="

PHASES_DIR="$ARTIFACT_DIR/phases"

if [[ ! -d "$PHASES_DIR" ]]; then
  say "  WARNING: $PHASES_DIR not found — no phase files to process"
else
  phase_count=0
  for ph_file in "$PHASES_DIR"/PH-*.yaml; do
    [[ -f "$ph_file" ]] || continue
    phase_count=$(( phase_count + 1 ))
    basename="$(basename "$ph_file")"

    result="$(run_normalizer "$ph_file" "$DRY_RUN")"
    if [[ "$result" == SKIP:* ]]; then
      say "  skipped: $basename (${result#SKIP:})"
      SKIPPED+=("$basename")
    elif [[ "$result" == CHANGED:* ]]; then
      changes="${result#CHANGED:}"
      if [[ "$DRY_RUN" == true ]]; then
        say "  [dry-run] would modify: $basename"
        say "    changes: $changes"
        DRY_RUN_ACTIONS+=("$basename: $changes")
      else
        say "  modified: $basename"
        say "    changes: $changes"
        MODIFIED+=("$basename: $changes")
      fi
    fi
  done

  if [[ "$phase_count" -eq 0 ]]; then
    say "  (no PH-*.yaml files found)"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

say ""
say "════════════════════════════════════════════"
say "Normalization summary"
say "════════════════════════════════════════════"

if [[ "$DRY_RUN" == true ]]; then
  say "  Mode: DRY RUN — no files were written"
  if [[ "${#DRY_RUN_ACTIONS[@]}" -gt 0 ]]; then
    say "  Would modify:"
    for item in "${DRY_RUN_ACTIONS[@]}"; do
      say "    ~ $item"
    done
  else
    say "  Nothing to do — all files already normalized."
  fi
  say ""
  say "  Re-run without --dry-run to apply changes."
  exit 0
fi

if [[ "${#MODIFIED[@]}" -gt 0 ]]; then
  say "  Modified:"
  for item in "${MODIFIED[@]}"; do
    say "    ~ $item"
  done
fi

if [[ "${#SKIPPED[@]}" -gt 0 ]]; then
  say "  Skipped (already normalized or missing):"
  for item in "${SKIPPED[@]}"; do
    say "    = $item"
  done
fi

if [[ "${#MODIFIED[@]}" -eq 0 ]]; then
  say "  Nothing to do — all files already normalized."
fi

# ── Post-write validation ─────────────────────────────────────────────────────
#
# Re-parse every file that was modified to confirm it is valid YAML.

if [[ "${#MODIFIED[@]}" -gt 0 ]]; then
  say ""
  say "--- Post-write YAML validation ---"

  VALIDATION_FAILURES=0

  validate_yaml() {
    local file="$1"
    python3 - "$file" <<'PYEOF'
import sys
import yaml
path = sys.argv[1]
try:
    with open(path) as f:
        yaml.safe_load(f)
    print("ok")
except Exception as e:
    print(f"FAIL: {e}")
PYEOF
  }

  # Validate GP-01 if it was in the modified set
  for item in "${MODIFIED[@]}"; do
    fname="${item%%:*}"
    if [[ "$fname" == "GP-01.yaml" ]]; then
      vresult="$(validate_yaml "$GP01")"
      if [[ "$vresult" == "ok" ]]; then
        say "  PASS: GP-01.yaml"
      else
        say "  FAIL: GP-01.yaml — $vresult"
        VALIDATION_FAILURES=$(( VALIDATION_FAILURES + 1 ))
      fi
    elif [[ "$fname" == PH-*.yaml ]]; then
      vresult="$(validate_yaml "$PHASES_DIR/$fname")"
      if [[ "$vresult" == "ok" ]]; then
        say "  PASS: $fname"
      else
        say "  FAIL: $fname — $vresult"
        VALIDATION_FAILURES=$(( VALIDATION_FAILURES + 1 ))
      fi
    fi
  done

  if [[ "$VALIDATION_FAILURES" -gt 0 ]]; then
    say ""
    say "ERROR: $VALIDATION_FAILURES file(s) failed post-write validation." >&2
    exit 1
  fi

  say "All modified files parse as valid YAML."
fi

say ""
say "Done."
