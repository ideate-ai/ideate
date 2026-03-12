#!/usr/bin/env bash
# migrate-to-domains.sh — One-time migration from flat reviews/ to archive/ + domains/
#
# Usage: ./scripts/migrate-to-domains.sh <artifact-dir>
#
# What this does:
#   1. Creates archive/incremental/ and copies reviews/incremental/*.md there
#   2. Creates archive/cycles/001/ and copies reviews/final/*.md there
#   3. Runs claude -p to bootstrap domains/ from the existing archive content
#   4. Prints a summary of what was created
#
# Does NOT delete reviews/ — verify the migration looks correct first,
# then delete it manually if satisfied.

set -euo pipefail

ARTIFACT_DIR="${1:?Usage: $0 <artifact-dir>}"

# Resolve to absolute path
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR" && pwd)"

echo "==> migrate-to-domains: artifact directory: $ARTIFACT_DIR"

# ── Validate ────────────────────────────────────────────────────────────────

if [[ ! -d "$ARTIFACT_DIR" ]]; then
  echo "ERROR: artifact directory does not exist: $ARTIFACT_DIR" >&2
  exit 1
fi

for required in steering/guiding-principles.md plan/architecture.md; do
  if [[ ! -f "$ARTIFACT_DIR/$required" ]]; then
    echo "ERROR: required artifact missing: $ARTIFACT_DIR/$required" >&2
    exit 1
  fi
done

if [[ -d "$ARTIFACT_DIR/archive" ]]; then
  echo "WARNING: archive/ already exists in $ARTIFACT_DIR"
  read -r -p "Continue and overwrite? [y/N] " confirm
  [[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }
fi

# ── Step 1: Create archive/incremental/ ─────────────────────────────────────

echo ""
echo "==> Step 1: Copying incremental reviews to archive/incremental/"

mkdir -p "$ARTIFACT_DIR/archive/incremental"

incremental_count=0
if [[ -d "$ARTIFACT_DIR/reviews/incremental" ]]; then
  for f in "$ARTIFACT_DIR/reviews/incremental/"*.md; do
    [[ -f "$f" ]] || continue
    cp "$f" "$ARTIFACT_DIR/archive/incremental/"
    ((incremental_count++))
  done
fi

echo "    Copied $incremental_count incremental review(s)"

# ── Step 2: Create archive/cycles/001/ ──────────────────────────────────────

echo ""
echo "==> Step 2: Copying final reviews to archive/cycles/001/"

mkdir -p "$ARTIFACT_DIR/archive/cycles/001"
mkdir -p "$ARTIFACT_DIR/archive/adhoc"

final_count=0
if [[ -d "$ARTIFACT_DIR/reviews/final" ]]; then
  for f in "$ARTIFACT_DIR/reviews/final/"*.md; do
    [[ -f "$f" ]] || continue
    # Normalize legacy filenames to the expected cycle file names
    basename_f="$(basename "$f")"
    case "$basename_f" in
      decision-log.md) dest="summary.md" ;;  # decision-log maps to summary for curator input
      *) dest="$basename_f" ;;
    esac
    cp "$f" "$ARTIFACT_DIR/archive/cycles/001/$dest"
    # Keep decision-log.md as its own file too
    if [[ "$basename_f" == "decision-log.md" ]]; then
      cp "$f" "$ARTIFACT_DIR/archive/cycles/001/decision-log.md"
    fi
    ((final_count++))
  done
fi

echo "    Copied $final_count final review file(s)"

# ── Step 3: Bootstrap domains/ via claude -p ────────────────────────────────

echo ""
echo "==> Step 3: Bootstrapping domains/ layer via claude -p"
echo "    (This may take a minute — the curator reads existing artifacts and classifies decisions)"

if ! command -v claude &>/dev/null; then
  echo "WARNING: 'claude' CLI not found on PATH. Skipping automated domain bootstrap."
  echo "    Run the domain-curator agent manually after installing claude CLI."
  echo "    Pass: artifact directory = $ARTIFACT_DIR, review source = archive/cycles/001/"
else
  # Write a bootstrap prompt to a temp file
  PROMPT_FILE="$(mktemp /tmp/ideate-curator-XXXXXX.txt)"
  trap 'rm -f "$PROMPT_FILE"' EXIT

  cat > "$PROMPT_FILE" <<CURATOR_PROMPT
You are the domain curator for the ideate artifact system.

This is a migration bootstrap run. The archive has been populated from a pre-migration artifact directory. Your job is to identify the knowledge domains present in this project and create the initial domains/ layer.

Artifact directory: $ARTIFACT_DIR

## What to read

1. $ARTIFACT_DIR/steering/guiding-principles.md
2. $ARTIFACT_DIR/steering/constraints.md
3. $ARTIFACT_DIR/plan/architecture.md
4. $ARTIFACT_DIR/plan/overview.md (if it exists)
5. $ARTIFACT_DIR/journal.md (if it exists)
6. $ARTIFACT_DIR/archive/cycles/001/*.md (all cycle 001 review files)
7. $ARTIFACT_DIR/steering/interview.md (if it exists)

## What to produce

**Step A: Identify domains**

Read all the above. Identify 2-4 distinct knowledge domains in this project. Look for:
- Areas with different conceptual language (the vocabulary shifts when discussing them)
- Areas with different decision authorities (different stakeholders care about them)
- Areas with different change cadences (some parts settle fast, some stay in flux)

Aim for coarse domains — err toward fewer. A domain can always be split later.

**Step B: Create domain files**

For each domain, create:

$ARTIFACT_DIR/domains/{name}/policies.md
$ARTIFACT_DIR/domains/{name}/decisions.md
$ARTIFACT_DIR/domains/{name}/questions.md

**policies.md format**:
\`\`\`
# Policies: {Domain Name}

## P-{N}: {Short title}
{One-sentence rule statement. Actionable and unambiguous.}
- **Derived from**: {GP-N (Principle Name)}
- **Established**: planning phase
- **Status**: active
\`\`\`

Start by projecting the guiding principles into domain-specific actionable rules. A GP becomes a domain policy when its application in this domain is substantively different from its application in other domains — more specific, more constrained, or with domain-specific nuance. If the GP applies identically everywhere, it stays a GP and does not generate a domain policy.

**decisions.md format**:
\`\`\`
# Decisions: {Domain Name}

## D-{N}: {Short title}
- **Decision**: {What was decided — one sentence}
- **Rationale**: {Why — extract from artifacts, do not invent}
- **Assumes**: {Key assumptions — omit if none}
- **Source**: {archive/cycles/001/filename.md or plan/architecture.md or steering/interview.md}
- **Status**: settled
\`\`\`

Extract key decisions from the cycle 001 review files and from plan/architecture.md. These are choices that affected the system and that future workers should know about.

**questions.md format**:
\`\`\`
# Questions: {Domain Name}

## Q-{N}: {Short title}
- **Question**: {Specific question}
- **Source**: {archive/cycles/001/filename.md or gap-analysis.md}
- **Impact**: {What is affected if this remains unanswered}
- **Status**: open
- **Reexamination trigger**: {Condition that would make this urgent}
\`\`\`

Extract open questions from the gap analysis and any unresolved findings in cycle 001.

**Step C: Create domains/index.md**

\`\`\`
# Domain Registry

current_cycle: 1

## Domains

### {domain-name}
{One-sentence description of what this domain covers.}
Files: domains/{domain-name}/policies.md, decisions.md, questions.md

...

## Cross-Cutting Concerns
{Any concerns that span multiple domains.}
\`\`\`

**Step D: Output summary**

After writing all files, print:
\`\`\`
Bootstrap complete.
Domains created: {list}
Policies written: {N}
Decisions recorded: {N}
Questions captured: {N}
\`\`\`

## Rules

- Do not duplicate content from the archive. Summarize and cite.
- Every decision rationale must come from the artifacts you read, not from inference.
- If rationale is not recorded anywhere, write "Rationale not recorded."
- Aim for 6-10 lines per decision entry, not more.
- Use sequential IDs: D-1, D-2, ... P-1, P-2, ... Q-1, Q-2, ...
CURATOR_PROMPT

  # Run claude -p with the bootstrap prompt
  claude -p "$(cat "$PROMPT_FILE")" \
    --allowedTools "Read,Write,Glob" \
    --max-turns 30 \
    2>&1 | tee /tmp/ideate-curator-output.txt

  echo ""
  echo "    Domain bootstrap complete. Output saved to /tmp/ideate-curator-output.txt"
fi

# ── Step 4: Verify and summarize ─────────────────────────────────────────────

echo ""
echo "==> Step 4: Verification"

domain_count=0
if [[ -d "$ARTIFACT_DIR/domains" ]]; then
  for d in "$ARTIFACT_DIR/domains/"/*/; do
    [[ -d "$d" ]] || continue
    ((domain_count++))
  done
fi

echo ""
echo "==> Migration complete"
echo ""
echo "    archive/incremental/  : $incremental_count file(s)"
echo "    archive/cycles/001/   : $final_count file(s)"
echo "    domains/              : $domain_count domain(s)"
echo ""
echo "    Next steps:"
echo "    1. Review domains/ to verify the bootstrap looks correct"
echo "    2. If satisfied, you may delete reviews/ manually (it is no longer needed)"
echo "    3. Move steering/interview.md to steering/interviews/legacy.md"
echo "       (future refine cycles use per-cycle per-domain interview files)"
echo "    4. All future ideate skills read from archive/ and domains/ — not reviews/"
echo ""
echo "    The original reviews/ directory has NOT been deleted."
