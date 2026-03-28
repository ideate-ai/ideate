#!/usr/bin/env bash
# migrate-to-optimized.sh — Apply optimization migrations (work items 076-086)
#
# Usage: ./scripts/migrate-to-optimized.sh [options] <artifact-dir>
#
# Options:
#   --dry-run    Report what would change without modifying anything
#   --verbose    Explain each action taken
#
# Migrations applied:
#   1. autopilot review path normalization (reviews/ → archive/)
#   2. autopilot-state.md schema update (add differential review fields)
#   3. metrics.jsonl initialization
#   4. Autopilot phase document directory check (informational)
#   5. MCP server configuration hint (informational)
#
# Exit codes: 0 = success, 1 = error, 2 = dry-run would change

set -uo pipefail

# ── Argument parsing ─────────────────────────────────────────────────────────

DRY_RUN=false
VERBOSE=false
ARTIFACT_DIR=""

for arg in "$@"; do
  case "$arg" in
    --dry-run)  DRY_RUN=true ;;
    --verbose)  VERBOSE=true ;;
    -*)         echo "ERROR: unknown option: $arg" >&2; exit 1 ;;
    *)          ARTIFACT_DIR="$arg" ;;
  esac
done

if [[ -z "$ARTIFACT_DIR" ]]; then
  echo "Usage: $0 [--dry-run] [--verbose] <artifact-dir>" >&2
  exit 1
fi

ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"

# ── State ────────────────────────────────────────────────────────────────────

CHANGES_NEEDED=0
LOG_FILE="$ARTIFACT_DIR/migration-log.md"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# ── Helpers ──────────────────────────────────────────────────────────────────

log() {
  local msg="$1"
  echo "$msg"
  if [[ "$DRY_RUN" == false ]]; then
    echo "- $TIMESTAMP: $msg" >> "$LOG_FILE"
  fi
}

verbose() {
  if [[ "$VERBOSE" == true ]]; then
    echo "  [verbose] $1"
  fi
}

dry_run_note() {
  if [[ "$DRY_RUN" == true ]]; then
    echo "  [dry-run] would: $1"
    CHANGES_NEEDED=1
  fi
}

backup_file() {
  local file="$1"
  local backup="${file}.pre-migration-backup"
  if [[ -f "$file" && ! -f "$backup" ]]; then
    if [[ "$DRY_RUN" == false ]]; then
      cp "$file" "$backup"
      verbose "backed up: $file → $backup"
    else
      dry_run_note "back up $file → $backup"
    fi
  fi
}

# ── Validation ───────────────────────────────────────────────────────────────

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  echo "ERROR: artifact directory does not exist: $ARTIFACT_DIR" >&2
  exit 1
fi

if [[ ! -f "$ARTIFACT_DIR/steering/guiding-principles.md" ]]; then
  echo "ERROR: does not look like an ideate artifact directory (missing steering/guiding-principles.md)" >&2
  exit 1
fi

echo "==> migrate-to-optimized: artifact directory: $ARTIFACT_DIR"
if [[ "$DRY_RUN" == true ]]; then
  echo "==> DRY-RUN mode — no changes will be made"
fi

# Initialize migration log (append)
if [[ "$DRY_RUN" == false ]]; then
  echo "" >> "$LOG_FILE"
  echo "## Migration run — $TIMESTAMP" >> "$LOG_FILE"
fi

# ── Migration 1: autopilot review path normalization ───────────────────────────

migration_1_autopilot_paths() {
  echo ""
  echo "==> Migration 1: autopilot review path normalization"
  verbose "checking for reviews/incremental/ alongside archive/incremental/"

  local has_old=false
  local has_new=false

  [[ -d "$ARTIFACT_DIR/reviews/incremental" ]] && has_old=true
  [[ -d "$ARTIFACT_DIR/archive/incremental" ]] && has_new=true

  if [[ "$has_old" == false && "$has_new" == false ]]; then
    echo "  neither reviews/incremental/ nor archive/incremental/ exists — nothing to migrate"
    return
  fi

  if [[ "$has_old" == false && "$has_new" == true ]]; then
    echo "  archive/incremental/ exists, reviews/incremental/ absent — already normalized"
    return
  fi

  if [[ "$has_old" == true && "$has_new" == false ]]; then
    echo "  reviews/incremental/ exists, archive/incremental/ absent"
    if [[ "$DRY_RUN" == false ]]; then
      mkdir -p "$ARTIFACT_DIR/archive"
      cp -r "$ARTIFACT_DIR/reviews/incremental" "$ARTIFACT_DIR/archive/incremental"
      log "Migration 1: copied reviews/incremental/ → archive/incremental/"
    else
      dry_run_note "copy reviews/incremental/ → archive/incremental/"
    fi
    echo "  note: reviews/incremental/ is preserved — verify migration, then remove manually"
    return
  fi

  # Both exist
  echo "  WARNING: both reviews/incremental/ and archive/incremental/ exist"
  echo "  Action required: determine which is canonical and remove the other"
  echo "  Skipping automatic migration for this case"
  log "Migration 1: SKIPPED — both reviews/incremental/ and archive/incremental/ exist; manual resolution required"
}

# ── Migration 2: autopilot-state.md schema update ─────────────────────────────

migration_2_autopilot_state() {
  echo ""
  echo "==> Migration 2: autopilot-state.md schema update"

  local state_file="$ARTIFACT_DIR/autopilot-state.md"

  if [[ ! -f "$state_file" ]]; then
    echo "  autopilot-state.md does not exist — will be created fresh on next autopilot run"
    return
  fi

  verbose "checking autopilot-state.md for missing fields"

  local needs_update=false

  if ! grep -q "last_full_review_cycle" "$state_file" 2>/dev/null; then
    needs_update=true
    verbose "field missing: last_full_review_cycle"
  fi

  if [[ "$needs_update" == false ]]; then
    echo "  autopilot-state.md already has required fields"
    return
  fi

  if [[ "$DRY_RUN" == false ]]; then
    backup_file "$state_file"
    echo "last_full_review_cycle: 0" >> "$state_file"
    log "Migration 2: added last_full_review_cycle field to autopilot-state.md"
    echo "  added missing field: last_full_review_cycle"
  else
    dry_run_note "append 'last_full_review_cycle: 0' to autopilot-state.md"
  fi
}

# ── Migration 3: metrics.jsonl initialization ─────────────────────────────────

migration_3_metrics() {
  echo ""
  echo "==> Migration 3: metrics.jsonl initialization"

  local metrics_file="$ARTIFACT_DIR/metrics.jsonl"

  if [[ -f "$metrics_file" ]]; then
    echo "  metrics.jsonl already exists"
  else
    if [[ "$DRY_RUN" == false ]]; then
      touch "$metrics_file"
      log "Migration 3: created empty metrics.jsonl"
      echo "  created empty metrics.jsonl"
    else
      dry_run_note "create empty metrics.jsonl"
    fi
  fi

  # Add to .gitignore if it exists
  local project_root
  project_root="$(dirname "$ARTIFACT_DIR")"

  for gitignore_dir in "$ARTIFACT_DIR" "$project_root"; do
    local gitignore="$gitignore_dir/.gitignore"
    if [[ -f "$gitignore" ]]; then
      local rel_path
      if [[ "$gitignore_dir" == "$ARTIFACT_DIR" ]]; then
        rel_path="metrics.jsonl"
      else
        rel_path="$(basename "$ARTIFACT_DIR")/metrics.jsonl"
      fi

      if grep -qF "$rel_path" "$gitignore" 2>/dev/null; then
        verbose "$rel_path already in $gitignore"
      else
        if [[ "$DRY_RUN" == false ]]; then
          echo "$rel_path" >> "$gitignore"
          log "Migration 3: added $rel_path to $gitignore"
          echo "  added $rel_path to $gitignore"
        else
          dry_run_note "add $rel_path to $gitignore"
        fi
      fi
    fi
  done
}

# ── Migration 4: Phase document directory check ───────────────────────────────

migration_4_phase_docs() {
  echo ""
  echo "==> Migration 4: autopilot phase document directory (informational)"

  # Look for the ideate plugin directory
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local plugin_dir
  plugin_dir="$(dirname "$script_dir")"

  if [[ -d "$plugin_dir/skills/autopilot/phases" ]]; then
    echo "  skills/autopilot/phases/ exists — autopilot phase factoring (081) has been applied"
  else
    echo "  INFO: skills/autopilot/phases/ does not exist — autopilot phase factoring (081) has not been applied yet"
    echo "  This is informational only; autopilot still works without phase documents"
  fi
}

# ── Migration 5: MCP server configuration hint ───────────────────────────────

migration_5_mcp() {
  echo ""
  echo "==> Migration 5: MCP server configuration hint (informational)"

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  local plugin_dir
  plugin_dir="$(dirname "$script_dir")"

  if [[ ! -d "$plugin_dir/mcp/artifact-server" ]]; then
    echo "  MCP artifact server (082) has not been built yet — nothing to configure"
    return
  fi

  echo "  MCP artifact server exists at: $plugin_dir/mcp/artifact-server"

  local configured=false
  local home_settings="$HOME/.claude/settings.json"
  local local_settings="$plugin_dir/.mcp.json"

  for cfg in "$home_settings" "$local_settings"; do
    if [[ -f "$cfg" ]] && grep -q "artifact-server" "$cfg" 2>/dev/null; then
      configured=true
      verbose "found configuration in: $cfg"
      break
    fi
  done

  if [[ "$configured" == true ]]; then
    echo "  MCP artifact server appears to be configured"
  else
    echo "  INFO: MCP artifact server is not configured in Claude Code settings"
    echo "  To configure, add the following to your .mcp.json or ~/.claude/settings.json:"
    echo '    "ideate-artifacts": {'
    echo '      "command": "node",'
    echo "      \"args\": [\"$plugin_dir/mcp/artifact-server/dist/index.js\"]"
    echo '    }'
  fi
}

# ── Migration 6: Convert per-file work items to work-items.yaml ──────────────

migration_6_yaml_format() {
  echo ""
  echo "==> Migration 6: work-items.yaml format migration"

  local yaml_file="$ARTIFACT_DIR/plan/work-items.yaml"
  local witem_dir="$ARTIFACT_DIR/plan/work-items"
  local notes_dir="$ARTIFACT_DIR/plan/notes"
  local legacy_dir="$ARTIFACT_DIR/plan/work-items-legacy"

  if [[ -f "$yaml_file" ]]; then
    echo "  plan/work-items.yaml already exists — skipping"
    return
  fi

  if [[ ! -d "$witem_dir" ]] || [[ -z "$(ls -A "$witem_dir" 2>/dev/null)" ]]; then
    echo "  no work items to migrate"
    return
  fi

  md_files=()
  while IFS= read -r f; do
    md_files+=("$f")
  done < <(ls "$witem_dir"/*.md 2>/dev/null | sort)
  if [[ ${#md_files[@]} -eq 0 ]]; then
    echo "  no .md files in plan/work-items/ — nothing to migrate"
    return
  fi

  echo "  found ${#md_files[@]} work item files to migrate"

  if [[ "$DRY_RUN" == false ]]; then
    mkdir -p "$notes_dir"

    # Use python3 to parse markdown and produce YAML
    python3 - "$ARTIFACT_DIR" "${md_files[@]}" <<'PYEOF'
import sys, re, os, textwrap

artifact_dir = sys.argv[1]
md_files = sys.argv[2:]

yaml_file = os.path.join(artifact_dir, 'plan', 'work-items.yaml')
notes_dir = os.path.join(artifact_dir, 'plan', 'notes')
os.makedirs(notes_dir, exist_ok=True)

def extract_section(content, heading):
    """Extract content of a markdown section by heading text."""
    pattern = rf'^##\s+{re.escape(heading)}\s*$'
    lines = content.split('\n')
    in_section = False
    result = []
    for line in lines:
        if re.match(pattern, line, re.IGNORECASE):
            in_section = True
            continue
        if in_section and re.match(r'^##\s', line):
            break
        if in_section:
            result.append(line)
    return '\n'.join(result).strip()

items = {}

for md_file in sorted(md_files):
    basename = os.path.basename(md_file)
    m = re.match(r'^(\d+)', basename)
    if not m:
        continue
    item_id = m.group(1)

    with open(md_file) as f:
        content = f.read()

    # Extract title
    title_m = re.search(r'^#\s+\d+:\s+(.+)$', content, re.MULTILINE)
    title = title_m.group(1).strip() if title_m else basename

    # Extract complexity
    complexity_section = extract_section(content, 'Complexity')
    complexity = complexity_section.lower().strip() if complexity_section else 'medium'
    complexity = re.sub(r'\s+', ' ', complexity).split()[0] if complexity else 'medium'

    # Extract file scope
    scope_section = extract_section(content, 'File Scope')
    scope_entries = []
    for line in scope_section.split('\n'):
        line = line.strip().lstrip('-').strip()
        if not line:
            continue
        # e.g. "`path/to/file` (create)" or "`path/to/file` — create"
        path_m = re.search(r'`([^`]+)`', line)
        op_m = re.search(r'\b(create|modify|delete)\b', line, re.IGNORECASE)
        if path_m:
            scope_entries.append({
                'path': path_m.group(1),
                'op': op_m.group(1).lower() if op_m else 'modify'
            })

    # Extract dependencies
    deps_section = extract_section(content, 'Dependencies')
    depends = []
    blocks = []
    for line in deps_section.split('\n'):
        if re.search(r'depends\s+on', line, re.IGNORECASE):
            nums = re.findall(r'\b(\d{3})\b', line)
            depends = list(nums)
        if re.search(r'blocks', line, re.IGNORECASE):
            nums = re.findall(r'\b(\d{3})\b', line)
            blocks = list(nums)

    # Extract acceptance criteria
    criteria_section = extract_section(content, 'Acceptance Criteria')
    criteria = []
    for line in criteria_section.split('\n'):
        line = line.strip()
        # Remove checkbox prefix: - [ ] or - [x]
        line = re.sub(r'^-\s*\[[xX ]\]\s*', '', line).strip()
        if line:
            criteria.append(line)

    # Extract implementation notes
    notes_section = extract_section(content, 'Implementation Notes')

    notes_file = os.path.join(notes_dir, f'{item_id}.md')
    if notes_section:
        with open(notes_file, 'w') as f:
            f.write(f'# Implementation Notes: {item_id}\n\n{notes_section}\n')

    # Remove self-references and deduplicate
    depends = list(dict.fromkeys(d for d in depends if d != item_id))
    blocks = list(dict.fromkeys(b for b in blocks if b != item_id))

    items[item_id] = {
        'title': title,
        'complexity': complexity,
        'scope': scope_entries,
        'depends': depends,
        'blocks': blocks,
        'criteria': criteria,
        'notes': f'plan/notes/{item_id}.md' if notes_section else None
    }

# Write YAML manually (avoid pyyaml dep, produce readable output)
with open(yaml_file, 'w') as f:
    f.write('# work-items.yaml — consolidated work item format\n')
    f.write('# Generated by migrate-to-optimized.sh\n\n')
    f.write('items:\n')
    for item_id in sorted(items.keys(), key=lambda x: int(x)):
        item = items[item_id]
        f.write(f'  "{item_id}":\n')
        f.write(f'    title: {item["title"]}\n')
        f.write(f'    complexity: {item["complexity"]}\n')
        f.write('    scope:\n')
        for s in item['scope']:
            f.write(f'      - {{path: {s["path"]}, op: {s["op"]}}}\n')
        dep_strs = ', '.join(f'"{d}"' for d in item['depends'])
        blk_strs = ', '.join(f'"{b}"' for b in item['blocks'])
        f.write(f'    depends: [{dep_strs}]\n')
        f.write(f'    blocks: [{blk_strs}]\n')
        f.write('    criteria:\n')
        for c in item['criteria']:
            # Escape any quotes in the criterion
            c_escaped = c.replace("'", "''")
            f.write(f"      - '{c_escaped}'\n")
        if item['notes']:
            f.write(f'    notes: {item["notes"]}\n')
        f.write('\n')

print(f"Written: {yaml_file}")
print(f"Written: {len(items)} items to plan/notes/")
PYEOF

    # Move originals to legacy dir
    mkdir -p "$legacy_dir"
    for f in "${md_files[@]}"; do
      mv "$f" "$legacy_dir/$(basename "$f")"
    done

    log "Migration 6: converted ${#md_files[@]} work items to work-items.yaml; originals moved to plan/work-items-legacy/"
    echo "  converted ${#md_files[@]} items → work-items.yaml"
    echo "  originals moved to: plan/work-items-legacy/"
  else
    dry_run_note "convert ${#md_files[@]} work item .md files to plan/work-items.yaml and plan/notes/"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

migration_1_autopilot_paths
migration_2_autopilot_state
migration_3_metrics
migration_4_phase_docs
migration_5_mcp
migration_6_yaml_format

echo ""
echo "==> Migration complete"

if [[ "$DRY_RUN" == true ]]; then
  if [[ "$CHANGES_NEEDED" -gt 0 ]]; then
    echo "==> DRY-RUN: changes would be made (see above)"
    exit 2
  else
    echo "==> DRY-RUN: no changes needed"
    exit 0
  fi
fi

echo "==> Log written to: $LOG_FILE"
exit 0
