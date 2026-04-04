#!/usr/bin/env bash
# fix-finding-yaml.sh — Fix bad indentation in early finding YAML files
#
# Finding YAML files from early cycles (F-*.yaml, FI-*.yaml) have a YAML parse
# error at line 6. After the `severity:` field, the title or suggestion value
# starts with an unquoted backtick character, which YAML treats as a block scalar
# indicator, causing the parser to reject the file with an indentation error.
#
# This script:
#   1. Finds all F-*.yaml and FI-*.yaml files in the .ideate/ directory tree
#   2. For each file, checks if line 6 has an unquoted backtick value (starts with
#      `title: `` or `suggestion: ``)
#   3. If so, wraps the value in double quotes (escaping any inner double quotes)
#   4. Verifies the fixed file parses as valid YAML
#   5. Reports count of files fixed
#
# Usage:
#   scripts/fix-finding-yaml.sh [--dry-run] [<artifact-dir>]
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

say() { echo "$1"; }

# ── Write Python helper to a temp file ───────────────────────────────────────
#
# We use a temp file for the Python logic to avoid nested heredoc issues
# and to be compatible with bash 3.2 (macOS default).

TMPDIR_SCRIPT="${TMPDIR:-/tmp}"
PY_FIXER="$TMPDIR_SCRIPT/fix-finding-yaml-fixer-$$.py"
PY_LISTER="$TMPDIR_SCRIPT/fix-finding-yaml-lister-$$.py"
PY_VALIDATE="$TMPDIR_SCRIPT/fix-finding-yaml-validate-$$.py"

# Clean up temp files on exit
trap 'rm -f "$PY_FIXER" "$PY_LISTER" "$PY_VALIDATE"' EXIT

# ── Python fixer script ───────────────────────────────────────────────────────
#
# Invoked once per file. Checks line 6 for the bad backtick pattern and, if
# found, quotes the value. Prints one of:
#   SKIP:<reason>     — file does not need fixing
#   CHANGED           — file was fixed (or would be, in dry-run mode)
#   ERROR:<message>   — something went wrong (written to stderr too)
#
# The fix: wrap the unquoted backtick value in double quotes, escaping any
# existing backslashes and double quotes in the value. This is the minimal
# change that makes the file parse as valid YAML without altering content.

cat > "$PY_FIXER" << 'PYEOF'
import sys
import yaml

path = sys.argv[1]
dry_run = sys.argv[2] == "true"

with open(path, "r") as f:
    lines = f.readlines()

# Check line 6 (index 5) for the bad pattern.
# The expected bad form is a top-level key whose value starts with a backtick:
#   title: `some backtick text`
#   suggestion: `some backtick text`
# These are valid key names but the backtick is illegal as an unquoted YAML value.
if len(lines) < 6:
    print("SKIP:too_short")
    sys.exit(0)

line6 = lines[5]

# Identify whether line 6 has the pattern: starts with a known key, then `: ``,
# i.e. the value (after ": ") begins with a backtick.
BAD_KEYS = ("title", "suggestion")
matched_key = None
for key in BAD_KEYS:
    prefix = key + ": `"
    if line6.startswith(prefix):
        matched_key = key
        break

if matched_key is None:
    print("SKIP:no_backtick_on_line6")
    sys.exit(0)

# Extract the value (everything after "key: ")
key_prefix = matched_key + ": "
value = line6[len(key_prefix):].rstrip("\n")

# Quote the value: wrap in double quotes, escape backslashes and double quotes.
quoted_value = '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
new_line6 = key_prefix + quoted_value + "\n"

new_lines = lines[:]
new_lines[5] = new_line6

new_content = "".join(new_lines)

# Verify the fixed content parses as valid YAML.
try:
    yaml.safe_load(new_content)
except yaml.YAMLError as e:
    print(f"ERROR: {path}: fixed YAML still fails to parse: {e}", file=sys.stderr)
    sys.exit(1)

print("CHANGED")

if not dry_run:
    with open(path, "w") as f:
        f.write(new_content)
PYEOF

# ── Python file lister ────────────────────────────────────────────────────────

cat > "$PY_LISTER" << 'PYEOF'
import sys, glob, os
base = sys.argv[1]
files = glob.glob(os.path.join(base, "**", "*.yaml"), recursive=True)
finding = sorted(
    f for f in files
    if os.path.basename(f).startswith("F-") or os.path.basename(f).startswith("FI-")
)
for f in finding:
    print(f)
PYEOF

# ── Python YAML validator ─────────────────────────────────────────────────────

cat > "$PY_VALIDATE" << 'PYEOF'
import sys, yaml
path = sys.argv[1]
try:
    yaml.safe_load(open(path))
    print("ok")
except Exception as e:
    print(f"FAIL: {e}")
PYEOF

# ── Collect finding files ─────────────────────────────────────────────────────

say ""
say "=== Fix-Finding-YAML: quoting unquoted backtick values ==="

FILE_LIST="$TMPDIR_SCRIPT/fix-finding-yaml-files-$$.txt"
trap 'rm -f "$PY_FIXER" "$PY_LISTER" "$PY_VALIDATE" "$FILE_LIST"' EXIT

python3 "$PY_LISTER" "$ARTIFACT_DIR" > "$FILE_LIST"
TOTAL_FILES=$(wc -l < "$FILE_LIST" | tr -d ' ')

say "Scanning $TOTAL_FILES finding files in: $ARTIFACT_DIR"
say ""

FIXED_COUNT=0
SKIPPED_COUNT=0
ERRORS_COUNT=0
FIXED_LIST="$TMPDIR_SCRIPT/fix-finding-yaml-fixed-$$.txt"
touch "$FIXED_LIST"

while IFS= read -r file; do
  result="$(python3 "$PY_FIXER" "$file" "$DRY_RUN" 2>&1)" || true

  if [[ "$result" == SKIP:* ]]; then
    SKIPPED_COUNT=$(( SKIPPED_COUNT + 1 ))
  elif [[ "$result" == "CHANGED" ]]; then
    FIXED_COUNT=$(( FIXED_COUNT + 1 ))
    echo "$file" >> "$FIXED_LIST"
    if [[ "$DRY_RUN" == true ]]; then
      say "  [dry-run] would fix: $file"
    else
      say "  fixed: $file"
    fi
  elif [[ "$result" == ERROR:* || "$result" == *ERROR:* ]]; then
    ERRORS_COUNT=$(( ERRORS_COUNT + 1 ))
    say "  ERROR: $file: $result" >&2
  else
    say "  WARNING: unexpected output for $file: $result" >&2
  fi
done < "$FILE_LIST"

# ── Summary ───────────────────────────────────────────────────────────────────

say ""
say "════════════════════════════════════════════"
say "Summary"
say "════════════════════════════════════════════"

if [[ "$DRY_RUN" == true ]]; then
  say "  Mode: DRY RUN — no files were written"
  say "  Would fix: $FIXED_COUNT file(s)"
  say "  Skipped (already valid): $SKIPPED_COUNT file(s)"
  say ""
  say "  Re-run without --dry-run to apply changes."
  exit 0
fi

say "  Fixed: $FIXED_COUNT file(s)"
say "  Skipped (already valid): $SKIPPED_COUNT file(s)"

if [[ "$ERRORS_COUNT" -gt 0 ]]; then
  say "  Errors: $ERRORS_COUNT file(s)"
  echo ""
  echo "ERROR: $ERRORS_COUNT file(s) failed to fix." >&2
  exit 1
fi

# ── Post-write validation ─────────────────────────────────────────────────────
#
# Re-parse every fixed file to confirm it is now valid YAML.

if [[ "$FIXED_COUNT" -gt 0 ]]; then
  say ""
  say "--- Post-write YAML validation ---"

  VALIDATION_FAILURES=0

  while IFS= read -r file; do
    vresult="$(python3 "$PY_VALIDATE" "$file")"
    basename_file="$(basename "$file")"
    if [[ "$vresult" == "ok" ]]; then
      say "  PASS: $basename_file"
    else
      say "  FAIL: $basename_file — $vresult"
      VALIDATION_FAILURES=$(( VALIDATION_FAILURES + 1 ))
    fi
  done < "$FIXED_LIST"

  if [[ "$VALIDATION_FAILURES" -gt 0 ]]; then
    say ""
    echo "ERROR: $VALIDATION_FAILURES file(s) failed post-write validation." >&2
    exit 1
  fi

  say "All fixed files parse as valid YAML."
fi

say ""
say "Done."
