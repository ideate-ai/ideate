#!/bin/bash
# Fix YAML files where description/answer/rationale fields start with backtick characters.
# YAML rejects unquoted scalars starting with ` — this script wraps them in double quotes.

IDEATE_DIR="${1:-.ideate}"
FIXED=0
CHECKED=0

# Find all YAML files in the .ideate directory
while IFS= read -r file; do
  CHECKED=$((CHECKED + 1))
  changed=false
  tmpfile=$(mktemp)
  
  while IFS= read -r line; do
    # Match lines like "description: `something..." or "answer: `something..." or "rationale: `something..."
    if echo "$line" | grep -qE '^(  )*[a-z_]+: `'; then
      # Extract the key and value
      key=$(echo "$line" | sed 's/^\(  *[a-z_]*\): .*/\1/')
      value=$(echo "$line" | sed 's/^  *[a-z_]*: //')
      # Escape existing double quotes in the value
      escaped=$(echo "$value" | sed 's/"/\\"/g')
      echo "${key}: \"${escaped}\"" >> "$tmpfile"
      changed=true
    else
      echo "$line" >> "$tmpfile"
    fi
  done < "$file"
  
  if [ "$changed" = true ]; then
    # Validate the fixed file
    if python3 -c "import yaml; yaml.safe_load(open('$tmpfile'))" 2>/dev/null; then
      mv "$tmpfile" "$file"
      FIXED=$((FIXED + 1))
      echo "Fixed: $file"
    else
      echo "WARN: Fix produced invalid YAML, skipping: $file"
      rm "$tmpfile"
    fi
  else
    rm "$tmpfile"
  fi
done < <(find "$IDEATE_DIR" -name "*.yaml" -type f)

echo ""
echo "Checked: $CHECKED files"
echo "Fixed: $FIXED files"
