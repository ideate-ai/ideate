#!/usr/bin/env python3
"""Fix YAML files where scalar values start with backtick characters.

YAML rejects unquoted scalars starting with `. This script reads each file
with a tolerant approach: it parses the raw text, finds lines where a scalar
value starts with `, and wraps the value in a YAML block scalar (|) or
quotes it properly.

The approach: read the file as raw text, identify the problematic field,
and use a block scalar (|-) to safely represent the value.
"""

import os
import sys
import re
import yaml

def fix_file(filepath):
    """Attempt to fix a YAML file with backtick-starting values.
    Returns True if fixed, False if no fix needed, None if unfixable."""
    with open(filepath, 'r') as f:
        content = f.read()

    # First check if it already parses
    try:
        yaml.safe_load(content)
        return False  # Already valid
    except yaml.YAMLError:
        pass  # Needs fixing

    lines = content.split('\n')
    fixed_lines = []
    i = 0
    changed = False

    while i < len(lines):
        line = lines[i]

        # Match a top-level field whose value starts with backtick
        # Pattern: "fieldname: `..." at indent level 0 or 2
        m = re.match(r'^(\s*)([\w_-]+):\s+(`.*)', line)
        if m:
            indent = m.group(1)
            key = m.group(2)
            value = m.group(3)

            # Collect continuation lines (lines at deeper indent that are part of this value)
            continuation = []
            j = i + 1
            while j < len(lines):
                next_line = lines[j]
                # If next line is at same or lesser indent and has a key, it's a new field
                next_m = re.match(r'^(\s*)([\w_-]+):', next_line)
                if next_m and len(next_m.group(1)) <= len(indent):
                    break
                # If it's an empty line followed by a field at same indent, stop
                if next_line.strip() == '' and j + 1 < len(lines):
                    peek = re.match(r'^(\s*)([\w_-]+):', lines[j + 1])
                    if peek and len(peek.group(1)) <= len(indent):
                        break
                continuation.append(next_line)
                j += 1

            if continuation:
                # Multi-line value: use block scalar
                full_value = value + '\n' + '\n'.join(continuation)
                # Use |- (strip trailing newline) block scalar
                block_indent = indent + '  '
                block_lines = full_value.split('\n')
                fixed_lines.append(f'{indent}{key}: |-')
                for bl in block_lines:
                    if bl.strip():
                        fixed_lines.append(f'{block_indent}{bl.strip()}')
                    else:
                        fixed_lines.append('')
                i = j
                changed = True
            else:
                # Single-line value: wrap in double quotes
                escaped = value.replace('\\', '\\\\').replace('"', '\\"')
                fixed_lines.append(f'{indent}{key}: "{escaped}"')
                i += 1
                changed = True
        else:
            fixed_lines.append(line)
            i += 1

    if not changed:
        return False

    fixed_content = '\n'.join(fixed_lines)

    # Validate the fix
    try:
        yaml.safe_load(fixed_content)
    except yaml.YAMLError as e:
        print(f"  WARN: Fix produced invalid YAML: {e}")
        return None

    with open(filepath, 'w') as f:
        f.write(fixed_content)
    return True


def main():
    ideate_dir = sys.argv[1] if len(sys.argv) > 1 else '.ideate'
    fixed = 0
    skipped = 0
    checked = 0

    for root, dirs, files in os.walk(ideate_dir):
        for fname in files:
            if not fname.endswith(('.yaml', '.yml')):
                continue
            filepath = os.path.join(root, fname)
            checked += 1

            result = fix_file(filepath)
            if result is True:
                fixed += 1
                print(f"  Fixed: {filepath}")
            elif result is None:
                skipped += 1
                print(f"  SKIPPED (unfixable): {filepath}")

    print(f"\nChecked: {checked}")
    print(f"Fixed: {fixed}")
    print(f"Skipped: {skipped}")


if __name__ == '__main__':
    main()
