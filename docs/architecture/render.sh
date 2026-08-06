#!/usr/bin/env bash
#
# Render this directory's markdown into the combined PDF.
#
#   ./render.sh
#
# Pipeline: each `00-`..`05-` doc goes through mermaid-cli, which extracts its
# ```mermaid blocks, renders them to SVG, and rewrites the fences as image
# references. The rewritten copies are concatenated and handed to pandoc, and
# Chrome prints the resulting HTML to PDF.
#
# Everything under build/ is generated and safe to delete; the sources are the
# markdown files and pdf-style.html beside this script.
#
# Requires: pandoc, and a Chrome. mermaid-cli is fetched via npx if absent.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

OUT_PDF="ideate-v3-architecture.pdf"
TITLE="Ideate v3 — Architecture Inventory & Usage Audit"

# --- toolchain ---------------------------------------------------------------

command -v pandoc >/dev/null || { echo "render: pandoc not found (brew install pandoc)" >&2; exit 1; }

# mermaid-cli: a cached npx copy if there is one, otherwise let npx fetch it.
# (The npx cache directory name is a content hash, so it is discovered, not
# hardcoded — a hardcoded one goes stale the next time the cache is cleared.)
mmdc() {
  local cached
  cached=$(find "${HOME}/.npm/_npx" -maxdepth 4 -name mmdc -type f -perm -u+x 2>/dev/null | head -1 || true)
  if [ -n "$cached" ]; then
    "$cached" "$@"
  else
    npx -y @mermaid-js/mermaid-cli "$@"
  fi
}

# Chrome for the HTML-to-PDF step: prefer puppeteer's headless shell (already
# on disk if mermaid-cli has ever run), fall back to a system install.
find_chrome() {
  local c
  c=$(ls -d "${HOME}"/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-mac-arm64/chrome-headless-shell 2>/dev/null | tail -1 || true)
  [ -n "$c" ] && { echo "$c"; return; }
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
    [ -x "$c" ] && { echo "$c"; return; }
  done
  echo "render: no Chrome found for PDF printing" >&2
  exit 1
}
CHROME=$(find_chrome)

# --- render ------------------------------------------------------------------

mkdir -p build

for f in [0-9][0-9]-*.md; do
  echo "mermaid: $f"
  mmdc -i "$f" -o "build/$f" --quiet 2>&1 | grep -viE "warn|deprecat" || true
done

cat build/[0-9][0-9]-*.md > build/combined.md

# mermaid-cli emits `![diagram](x.svg)`; pandoc renders that alt text as a
# visible figure caption. Blank it so the diagrams stand on their own.
perl -pi -e 's/^!\[diagram\]\(/![](/' build/combined.md

pandoc build/combined.md -o build/combined.html --standalone \
  --metadata title="$TITLE" \
  --include-in-header=pdf-style.html

# The SVG references in combined.html are relative, so print from build/.
"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/$OUT_PDF" "file://$PWD/build/combined.html" 2>&1 \
  | grep -viE "^\[|devtools" || true

echo "wrote $OUT_PDF"
