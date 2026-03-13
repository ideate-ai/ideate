#!/usr/bin/env bash
# migrate-to-cycles.sh — Organize completed work items and incremental reviews into cycle directories
#
# Usage: ./scripts/migrate-to-cycles.sh <artifact-dir>
#
# What this does:
#   1. Reads domains/index.md for current_cycle number
#   2. Maps work items to cycles by checking for matching incremental reviews
#   3. Copies completed work items and reviews into archive/cycles/{N}/
#   4. Generates a review-manifest.md per cycle from the archived files
#   5. Prints a summary — does NOT delete originals
#
# Does NOT delete original files — verify the migration looks correct first,
# then delete originals manually if satisfied.

set -euo pipefail

ARTIFACT_DIR="${1:?Usage: $0 <artifact-dir>}"

# Resolve to absolute path
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"

echo "==> migrate-to-cycles: artifact directory: $ARTIFACT_DIR"

# ── Validate ────────────────────────────────────────────────────────────────

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  echo "ERROR: artifact directory does not exist: $ARTIFACT_DIR" >&2
  exit 1
fi

if [[ ! -d "$ARTIFACT_DIR/plan/work-items" ]]; then
  echo "ERROR: no plan/work-items/ directory found in $ARTIFACT_DIR" >&2
  exit 1
fi

if [[ ! -d "$ARTIFACT_DIR/archive/incremental" ]]; then
  echo "ERROR: no archive/incremental/ directory found in $ARTIFACT_DIR" >&2
  exit 1
fi

# ── Step 1: Detect current cycle ────────────────────────────────────────────

echo ""
echo "==> Step 1: Detecting current cycle number"

current_cycle=1
if [[ -f "$ARTIFACT_DIR/domains/index.md" ]]; then
  parsed=$(grep -E '^current_cycle:' "$ARTIFACT_DIR/domains/index.md" | head -1 | sed 's/current_cycle:[[:space:]]*//')
  if [[ -n "$parsed" && "$parsed" =~ ^[0-9]+$ ]]; then
    current_cycle="$parsed"
  fi
fi

echo "    Current cycle: $current_cycle"

# ── Step 2: Map work items to incremental reviews ──────────────────────────

echo ""
echo "==> Step 2: Mapping work items to incremental reviews"

# Extract number prefix from a filename: "042-foo-bar.md" → "042"
num_prefix() {
  basename "$1" | grep -oE '^[0-9]+'
}

# Build a lookup of item_number → review_filename using a temp directory
# (avoids bash 4+ associative arrays for macOS bash 3.2 compatibility)
tmpdir="$(mktemp -d /tmp/ideate-migrate-XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT

for review_file in "$ARTIFACT_DIR/archive/incremental/"*.md; do
  [[ -f "$review_file" ]] || continue
  review_basename="$(basename "$review_file")"
  # Extract all leading number groups (handles "002-009-011-group2.md" → 002 009 011)
  nums=$(echo "$review_basename" | grep -oE '^([0-9]+-)+' | tr '-' '\n' | grep -E '^[0-9]+$')
  if [[ -z "$nums" ]]; then
    # Single number prefix like "001-plugin-manifest.md"
    single=$(echo "$review_basename" | grep -oE '^[0-9]+')
    [[ -n "$single" ]] && echo "$review_basename" > "$tmpdir/$single"
  else
    for n in $nums; do
      echo "$review_basename" > "$tmpdir/$n"
    done
  fi
done

# Helper: look up review filename for a given item number
get_review() { cat "$tmpdir/$1" 2>/dev/null || true; }

# Classify work items: completed (has review) vs active (no review)
completed_items=()
active_items=()

for wi_file in "$ARTIFACT_DIR/plan/work-items/"*.md; do
  [[ -f "$wi_file" ]] || continue
  wi_num=$(num_prefix "$wi_file")
  if [[ -n "$(get_review "$wi_num")" ]]; then
    completed_items+=("$wi_file")
  else
    active_items+=("$wi_file")
  fi
done

echo "    Completed (have reviews): ${#completed_items[@]}"
echo "    Active (no reviews):      ${#active_items[@]}"

# ── Step 3: Assign completed items to cycles ────────────────────────────────

echo ""
echo "==> Step 3: Assigning completed items to cycles"

# All completed items go to cycle 1 unless we can determine otherwise.
# Items beyond the existing cycle-1 archive are assigned to cycle 1 by default,
# since precise cycle mapping requires execution history we don't have.
assign_cycle=1

echo "    Assigning all completed items to cycle $assign_cycle"
echo "    (Precise per-cycle mapping requires execution history; defaulting to cycle 1)"

# ── Step 4: Copy files into cycle directories ───────────────────────────────

echo ""
echo "==> Step 4: Copying completed items into archive/cycles/"

cycle_dir="$ARTIFACT_DIR/archive/cycles/$(printf '%03d' $assign_cycle)"
mkdir -p "$cycle_dir/work-items"
mkdir -p "$cycle_dir/incremental"

wi_copied=0
review_copied=0
# Track already-copied reviews using another tmpdir subdir
mkdir -p "$tmpdir/copied"

for wi_file in "${completed_items[@]+"${completed_items[@]}"}"; do
  wi_basename="$(basename "$wi_file")"
  wi_num=$(num_prefix "$wi_file")

  # Copy work item
  cp "$wi_file" "$cycle_dir/work-items/$wi_basename"
  ((wi_copied++))

  # Copy matching incremental review (if not already copied)
  review_name="$(get_review "$wi_num")"
  if [[ -n "$review_name" && ! -f "$tmpdir/copied/$review_name" ]]; then
    cp "$ARTIFACT_DIR/archive/incremental/$review_name" "$cycle_dir/incremental/$review_name"
    touch "$tmpdir/copied/$review_name"
    ((review_copied++))
  fi
done

echo "    Work items copied:        $wi_copied → archive/cycles/$(printf '%03d' $assign_cycle)/work-items/"
echo "    Incremental reviews copied: $review_copied → archive/cycles/$(printf '%03d' $assign_cycle)/incremental/"

# ── Step 5: Generate review manifest ────────────────────────────────────────

echo ""
echo "==> Step 5: Generating review manifest"

manifest="$cycle_dir/review-manifest.md"

{
  echo "# Review Manifest — Cycle $assign_cycle"
  echo ""
  echo "| # | Title | File Scope | Incremental Verdict | Finding Count | Work Item | Review |"
  echo "|---|---|---|---|---|---|---|"

  for wi_file in "$cycle_dir/work-items/"*.md; do
    [[ -f "$wi_file" ]] || continue
    wi_basename="$(basename "$wi_file")"
    wi_num=$(num_prefix "$wi_file")

    # Extract title from first heading
    title=$(grep -m1 '^# ' "$wi_file" 2>/dev/null | sed 's/^# //' | sed "s/^${wi_num}: //" || true)
    [[ -z "$title" ]] && title="(untitled)"

    # Extract file scope — lines between "## File Scope" and next "##"
    file_scope=$(awk '/^## File Scope/{found=1;next} found && /^## /{exit} found{print}' "$wi_file" \
      | grep -E '^\s*-' | sed 's/^[[:space:]]*- //' | sed 's/ (.*)$//' \
      | head -5 | tr '\n' ', ' | sed 's/, $//' || true)
    [[ -z "$file_scope" ]] && file_scope="—"

    # Find matching review
    review_name="$(get_review "$wi_num")"
    verdict="—"
    count_critical=0
    count_significant=0
    count_minor=0

    if [[ -n "$review_name" && -f "$cycle_dir/incremental/$review_name" ]]; then
      review_path="$cycle_dir/incremental/$review_name"

      # Extract verdict from "## Verdict" line or first line containing Pass/Fail
      verdict=$(grep -m1 -iE '^\s*(pass|fail)' "$review_path" | sed 's/^[[:space:]]*//' || true)
      [[ -z "$verdict" ]] && verdict=$(grep -m1 -iE 'verdict.*:' "$review_path" | sed 's/.*:[[:space:]]*//' || true)
      [[ -z "$verdict" ]] && verdict="—"

      # Count findings by severity (grep -c always outputs a number, never fails)
      count_critical=$(grep -ciE '### C[0-9]+:' "$review_path" 2>/dev/null || true)
      count_significant=$(grep -ciE '### S[0-9]+:' "$review_path" 2>/dev/null || true)
      count_minor=$(grep -ciE '### M[0-9]+:' "$review_path" 2>/dev/null || true)
      count_critical="${count_critical:-0}"
      count_significant="${count_significant:-0}"
      count_minor="${count_minor:-0}"
    fi

    finding_counts="C:${count_critical} S:${count_significant} M:${count_minor}"
    wi_rel="archive/cycles/$(printf '%03d' $assign_cycle)/work-items/$wi_basename"
    review_rel="archive/cycles/$(printf '%03d' $assign_cycle)/incremental/${review_name:-—}"

    echo "| $wi_num | $title | $file_scope | $verdict | $finding_counts | $wi_rel | $review_rel |"
  done
} > "$manifest"

echo "    Manifest written: archive/cycles/$(printf '%03d' $assign_cycle)/review-manifest.md"

# ── Step 6: Summary ─────────────────────────────────────────────────────────

echo ""
echo "==> Migration complete"
echo ""
echo "    Archived to cycle $(printf '%03d' $assign_cycle):"
echo "      Work items:          $wi_copied"
echo "      Incremental reviews: $review_copied"
echo "      Review manifest:     1"
echo ""
echo "    Active items remaining in plan/work-items/:"
for wi_file in "${active_items[@]+"${active_items[@]}"}"; do
  echo "      $(basename "$wi_file")"
done
[[ ${#active_items[@]} -eq 0 ]] && echo "      (none)"
echo ""
echo "    Next steps:"
echo "    1. Review archive/cycles/$(printf '%03d' $assign_cycle)/ to verify the migration looks correct"
echo "    2. Review the generated review-manifest.md"
echo "    3. Respond to the prompt below to delete originals (or skip to do it manually)"
echo "    4. Active work items in plan/work-items/ were NOT touched"
echo ""

# ── Step 7: Offer to delete originals ───────────────────────────────────────

read -r -p "==> Delete original completed items from plan/work-items/ and archive/incremental/? [y/N] " confirm || confirm=""
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  deleted_wi=0
  for wi_file in "${completed_items[@]+"${completed_items[@]}"}"; do
    rm "$wi_file"
    ((deleted_wi++))
  done

  deleted_reviews=0
  for review_file in "$ARTIFACT_DIR/archive/incremental/"*.md; do
    [[ -f "$review_file" ]] || continue
    review_basename="$(basename "$review_file")"
    if [[ -f "$cycle_dir/incremental/$review_basename" ]]; then
      rm "$review_file"
      ((deleted_reviews++))
    fi
  done

  echo ""
  echo "    Deleted $deleted_wi completed work items from plan/work-items/"
  echo "    Deleted $deleted_reviews incremental reviews from archive/incremental/"
  echo "    Active work items in plan/work-items/ were NOT touched."
else
  echo "    Originals not deleted. To delete manually:"
  echo "      # Completed work items:"
  for wi_file in "${completed_items[@]+"${completed_items[@]}"}"; do
    echo "      rm \"$wi_file\""
  done
  echo "      # Incremental reviews (those archived above):"
  for review_file in "$cycle_dir/incremental/"*.md; do
    [[ -f "$review_file" ]] || continue
    echo "      rm \"$ARTIFACT_DIR/archive/incremental/$(basename "$review_file")\""
  done
fi
