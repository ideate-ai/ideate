#!/usr/bin/env bash
# validate-specs.sh — Non-LLM validation of work-items.yaml
# NOTE (2026-03-26): This script is NOT functional for the v3 per-file
# WI-{NNN}.yaml format. It expects a consolidated plan/work-items.yaml
# file that no longer exists. Needs rewriting to glob individual YAML
# files from work-items/ directory.
#
#
# Usage: ./scripts/validate-specs.sh <subcommand> [artifact-dir]
#
# Subcommands:
#   dag       — Detect cycles in the dependency graph
#   overlap   — Find file scope conflicts between concurrent work items
#   coverage  — Verify all items have criteria and scope defined
#   groups    — Topological sort: print execution groups (items with same depth)
#   lint      — Flag vague criteria terms
#   all       — Run all subcommands
#
# Exit codes: 0 = all checks pass, 1 = errors found, 2 = usage error

set -uo pipefail

# ── Argument parsing ──────────────────────────────────────────────────────────

SUBCOMMAND="${1:-}"
ARTIFACT_DIR="${2:-.}"

if [[ -z "$SUBCOMMAND" ]]; then
  echo "Usage: $0 <subcommand> [artifact-dir]" >&2
  echo "Subcommands: dag, overlap, coverage, groups, lint, all" >&2
  exit 2
fi

ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"
YAML_FILE="$ARTIFACT_DIR/plan/work-items.yaml"

if [[ ! -f "$YAML_FILE" ]]; then
  echo "ERROR: work-items.yaml not found at $YAML_FILE" >&2
  echo "This validator requires the consolidated YAML format." >&2
  exit 2
fi

# ── Detect parser: prefer yq, fall back to python ────────────────────────────

PARSE_CMD=""
if command -v yq &>/dev/null; then
  PARSE_CMD="yq"
elif command -v python3 &>/dev/null && python3 -c "import yaml" 2>/dev/null; then
  PARSE_CMD="python3"
else
  echo "ERROR: requires 'yq' or 'python3' with pyyaml installed" >&2
  exit 2
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

# Extract all item IDs
get_ids() {
  if [[ "$PARSE_CMD" == "yq" ]]; then
    yq '.items | keys | .[]' "$YAML_FILE"
  else
    python3 - "$YAML_FILE" <<'EOF'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]))
for k in (data.get('items') or {}).keys():
    print(k)
EOF
  fi
}

# Get dependencies for an item
get_deps() {
  local id="$1"
  if [[ "$PARSE_CMD" == "yq" ]]; then
    yq ".items.\"$id\".depends // [] | .[]" "$YAML_FILE" 2>/dev/null || true
  else
    python3 - "$YAML_FILE" "$id" <<'EOF'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]))
item = (data.get('items') or {}).get(sys.argv[2], {})
for d in (item.get('depends') or []):
    print(d)
EOF
  fi
}

# Get scope paths for an item
get_scope_paths() {
  local id="$1"
  if [[ "$PARSE_CMD" == "yq" ]]; then
    yq ".items.\"$id\".scope // [] | .[].path" "$YAML_FILE" 2>/dev/null || true
  else
    python3 - "$YAML_FILE" "$id" <<'EOF'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]))
item = (data.get('items') or {}).get(sys.argv[2], {})
for s in (item.get('scope') or []):
    print(s.get('path', ''))
EOF
  fi
}

# Get criteria count for an item
get_criteria_count() {
  local id="$1"
  if [[ "$PARSE_CMD" == "yq" ]]; then
    yq ".items.\"$id\".criteria // [] | length" "$YAML_FILE" 2>/dev/null || echo 0
  else
    python3 - "$YAML_FILE" "$id" <<'EOF'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]))
item = (data.get('items') or {}).get(sys.argv[2], {})
print(len(item.get('criteria') or []))
EOF
  fi
}

# Get all criteria strings for an item
get_criteria() {
  local id="$1"
  if [[ "$PARSE_CMD" == "yq" ]]; then
    yq ".items.\"$id\".criteria // [] | .[]" "$YAML_FILE" 2>/dev/null || true
  else
    python3 - "$YAML_FILE" "$id" <<'EOF'
import sys, yaml
data = yaml.safe_load(open(sys.argv[1]))
item = (data.get('items') or {}).get(sys.argv[2], {})
for c in (item.get('criteria') or []):
    print(c)
EOF
  fi
}

ERRORS=0

# ── Subcommand: dag ───────────────────────────────────────────────────────────

cmd_dag() {
  echo "==> DAG: cycle detection"

  python3 - "$YAML_FILE" <<'EOF'
import sys, yaml

data = yaml.safe_load(open(sys.argv[1]))
items = data.get('items') or {}
deps = {k: set(str(d) for d in (v.get('depends') or [])) for k, v in items.items()}

# DFS cycle detection
WHITE, GRAY, BLACK = 0, 1, 2
color = {k: WHITE for k in items}
errors = 0

def dfs(node, path):
    global errors
    color[node] = GRAY
    for dep in deps.get(node, []):
        if dep not in color:
            continue
        if color[dep] == GRAY:
            cycle = path[path.index(dep):] + [dep]
            print(f"  CYCLE DETECTED: {' -> '.join(cycle)}")
            errors += 1
            return
        if color[dep] == WHITE:
            dfs(dep, path + [dep])
    color[node] = BLACK

for node in sorted(items.keys()):
    if color[node] == WHITE:
        dfs(node, [node])

if errors == 0:
    print(f"  OK: no cycles detected ({len(items)} items)")
sys.exit(1 if errors > 0 else 0)
EOF
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    ERRORS=$((ERRORS + 1))
  fi
}

# ── Subcommand: overlap ───────────────────────────────────────────────────────

cmd_overlap() {
  echo "==> OVERLAP: file scope conflict detection"
  IDS=()
  while IFS= read -r _id; do IDS+=("$_id"); done < <(get_ids)

  # Compute reachable set for each item (items reachable via depends edges)
  # If A is reachable from B (or B from A), they are NOT concurrent — skip
  # We use a simple transitive closure for small graphs

  # Build deps map using python for cleanliness
  if [[ "$PARSE_CMD" == "yq" ]]; then
    echo "  (overlap check uses python3 — yq not sufficient for graph traversal)"
  fi

  python3 - "$YAML_FILE" <<'EOF'
import sys, yaml

data = yaml.safe_load(open(sys.argv[1]))
items = data.get('items') or {}

# Build adjacency (id -> set of direct deps)
deps = {k: set(str(d) for d in (v.get('depends') or [])) for k, v in items.items()}

# Transitive closure: reachable[a] = all items a transitively depends on
def transitive_deps(start, deps):
    visited = set()
    queue = list(deps.get(start, []))
    while queue:
        n = queue.pop()
        if n in visited:
            continue
        visited.add(n)
        queue.extend(deps.get(n, []))
    return visited

reachable = {k: transitive_deps(k, deps) for k in items}

# Build scope maps
scopes = {}
for k, v in items.items():
    scopes[k] = set(s.get('path', '') for s in (v.get('scope') or []) if s.get('path'))

# Check all pairs
errors = 0
ids = sorted(items.keys())
for i, a in enumerate(ids):
    for b in ids[i+1:]:
        # Are they concurrent? They're concurrent if neither depends on the other (transitively)
        if b in reachable[a] or a in reachable[b]:
            continue  # sequenced — overlap is OK
        overlap = scopes[a] & scopes[b]
        if overlap:
            print(f"  OVERLAP: items {a} and {b} both claim: {', '.join(sorted(overlap))}")
            errors += 1

if errors == 0:
    print(f"  OK: no scope overlaps between concurrent items ({len(ids)} items)")
sys.exit(1 if errors > 0 else 0)
EOF
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    ERRORS=$((ERRORS + 1))
  fi
}

# ── Subcommand: coverage ──────────────────────────────────────────────────────

cmd_coverage() {
  echo "==> COVERAGE: criteria and scope completeness"
  IDS=()
  while IFS= read -r _id; do IDS+=("$_id"); done < <(get_ids)

  for id in "${IDS[@]}"; do
    local ccount
    ccount="$(get_criteria_count "$id")"
    if [[ "$ccount" -eq 0 ]]; then
      echo "  ERROR: item $id has no criteria"
      ERRORS=$((ERRORS + 1))
    fi

    local has_scope=false
    while IFS= read -r path; do
      [[ -n "$path" ]] && has_scope=true && break
    done < <(get_scope_paths "$id")

    if [[ "$has_scope" == false ]]; then
      echo "  WARNING: item $id has no file scope entries"
    fi
  done

  if [[ $ERRORS -eq 0 ]]; then
    echo "  OK: all ${#IDS[@]} items have criteria and scope"
  fi
}

# ── Subcommand: groups ────────────────────────────────────────────────────────

cmd_groups() {
  echo "==> GROUPS: topological sort (execution groups)"

  python3 - "$YAML_FILE" <<'EOF'
import sys, yaml

data = yaml.safe_load(open(sys.argv[1]))
items = data.get('items') or {}
deps = {k: set(str(d) for d in (v.get('depends') or [])) for k, v in items.items()}

# Kahn's algorithm
in_degree = {k: 0 for k in items}
for k, d_set in deps.items():
    for d in d_set:
        if d in in_degree:
            in_degree[k] = in_degree.get(k, 0)  # already set
        # not counting in-degree here — let's recompute properly

# Recompute: in_degree[k] = number of items k depends on that exist
in_degree = {k: len(deps[k] & set(items.keys())) for k in items}

groups = []
remaining = dict(in_degree)
while remaining:
    group = sorted(k for k, d in remaining.items() if d == 0)
    if not group:
        print("  CYCLE: cannot compute topological sort — cycles exist")
        sys.exit(1)
    groups.append(group)
    for k in group:
        del remaining[k]
    for k in list(remaining.keys()):
        remaining[k] = len(deps[k] & set(remaining.keys()))

for i, group in enumerate(groups, 1):
    print(f"  Group {i}: {', '.join(group)}")
print(f"  Total: {len(groups)} groups")
EOF
}

# ── Subcommand: lint ──────────────────────────────────────────────────────────

VAGUE_TERMS=(
  "appropriate" "appropriately" "as needed" "when necessary"
  "clean" "good" "best practices" "standard" "simple" "intuitive"
  "robust" "flexible" "extensible" "modern" "user-friendly" "readable"
)

cmd_lint() {
  echo "==> LINT: vague criteria detection"
  IDS=()
  while IFS= read -r _id; do IDS+=("$_id"); done < <(get_ids)
  local lint_errors=0

  for id in "${IDS[@]}"; do
    while IFS= read -r criterion; do
      [[ -z "$criterion" ]] && continue
      for term in "${VAGUE_TERMS[@]}"; do
        if echo "$criterion" | grep -qi "\b${term}\b" 2>/dev/null; then
          echo "  LINT: item $id criterion contains vague term '$term': $criterion"
          lint_errors=$((lint_errors + 1))
        fi
      done
    done < <(get_criteria "$id")
  done

  if [[ $lint_errors -eq 0 ]]; then
    echo "  OK: no vague criteria terms found"
  else
    ERRORS=$((ERRORS + lint_errors))
  fi
}

# ── Subcommand: all ───────────────────────────────────────────────────────────

cmd_all() {
  cmd_dag
  echo ""
  cmd_overlap
  echo ""
  cmd_coverage
  echo ""
  cmd_groups
  echo ""
  cmd_lint
}

# ── Dispatch ──────────────────────────────────────────────────────────────────

case "$SUBCOMMAND" in
  dag)      cmd_dag ;;
  overlap)  cmd_overlap ;;
  coverage) cmd_coverage ;;
  groups)   cmd_groups ;;
  lint)     cmd_lint ;;
  all)      cmd_all ;;
  *)
    echo "ERROR: unknown subcommand: $SUBCOMMAND" >&2
    echo "Subcommands: dag, overlap, coverage, groups, lint, all" >&2
    exit 2
    ;;
esac

if [[ $ERRORS -gt 0 ]]; then
  echo ""
  echo "==> FAILED: $ERRORS error(s) found"
  exit 1
else
  echo ""
  echo "==> PASSED"
  exit 0
fi
