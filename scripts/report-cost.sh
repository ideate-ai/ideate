#!/usr/bin/env bash
set -euo pipefail

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 is required but not found on PATH" >&2
    exit 1
fi

python3 - "$@" << 'PYTHON_SCRIPT'
import json
import sys
import os
import collections
from pathlib import Path


HELP = """Usage: report-cost.sh [OPTIONS] [METRICS_FILE]

Generate a markdown cost report from an ideate metrics.jsonl file.

Arguments:
  METRICS_FILE    Path to metrics.jsonl file. If omitted, auto-discovery is
                  attempted by walking CWD upward looking for .ideate.json and
                  reading its artifactDir key.

Options:
  --help          Print this help message and exit.

Report Sections:
  Per-Work-Item Token Cost    Total tokens per work item, sorted by cost
                              descending. Columns: Work Item, Total Tokens,
                              Input, Output, Cache Read, Spawns.
  Per-Cycle Token Cost        Total tokens per cycle with phase breakdown.
                              Columns: Cycle, Total Tokens, Plan, Execute,
                              Review, Refine.
  Cost Trends                 Cycle-over-cycle token usage with trend
                              indicator. Dollar estimates included if
                              cycle_total_cost_estimate is present in entries.
"""


def tokens(e):
    return (e.get('input_tokens') or 0) + (e.get('output_tokens') or 0)


def fmt_tokens(n):
    if n >= 10000:
        return f"{n/1000:.1f}k"
    return f"{n:,}"


def fmt_cost(v):
    if v is None:
        return '-'
    return f"${v:.4f}"


def discover_metrics():
    """Walk CWD upward (max 10 levels) looking for .ideate.json."""
    current = Path(os.getcwd()).resolve()
    for _ in range(10):
        candidate = current / '.ideate.json'
        if candidate.exists():
            try:
                with open(candidate) as f:
                    config = json.load(f)
            except (json.JSONDecodeError, OSError) as ex:
                print(f"Error: failed to parse {candidate}: {ex}", file=sys.stderr)
                sys.exit(1)
            artifact_dir = config.get('artifactDir') or config.get('artifact_dir')
            if not artifact_dir:
                print(f"Error: .ideate.json at {candidate} has no artifactDir key", file=sys.stderr)
                sys.exit(1)
            artifact_path = Path(artifact_dir)
            if not artifact_path.is_absolute():
                artifact_path = current / artifact_path
            metrics_path = artifact_path / 'metrics.jsonl'
            return str(metrics_path)
        parent = current.parent
        if parent == current:
            break
        current = parent
    print("Error: no .ideate.json found in CWD or any parent directory (searched 10 levels)", file=sys.stderr)
    sys.exit(1)


def load_entries(path):
    if not os.path.exists(path):
        return []
    entries = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    entries.append(e)
                except json.JSONDecodeError:
                    continue
    except OSError as ex:
        print(f"Error: cannot read {path}: {ex}", file=sys.stderr)
        sys.exit(1)
    return entries


def section_per_work_item(entries):
    lines = ["## Per-Work-Item Token Cost", ""]

    by_item = collections.defaultdict(list)
    for e in entries:
        wi = e.get('work_item')
        if wi is not None:
            by_item[wi].append(e)

    if not by_item:
        lines.append("No work-item data available.")
        return lines

    # Build stats per work item
    item_stats = []
    for wi, evts in by_item.items():
        total_input = sum(e.get('input_tokens') or 0 for e in evts)
        total_output = sum(e.get('output_tokens') or 0 for e in evts)
        total_cache = sum(e.get('cache_read_tokens') or 0 for e in evts)
        total_tok = total_input + total_output
        spawns = len(evts)
        item_stats.append((wi, total_tok, total_input, total_output, total_cache, spawns))

    # Sort by total tokens descending
    item_stats.sort(key=lambda x: x[1], reverse=True)

    lines.append("| Work Item | Total Tokens | Input | Output | Cache Read | Spawns |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for wi, total_tok, total_input, total_output, total_cache, spawns in item_stats:
        lines.append(
            f"| {wi} | {fmt_tokens(total_tok)} | {fmt_tokens(total_input)} | "
            f"{fmt_tokens(total_output)} | {fmt_tokens(total_cache)} | {spawns:,} |"
        )

    return lines


def section_per_cycle(entries):
    lines = ["## Per-Cycle Token Cost", ""]

    by_cycle = collections.defaultdict(list)
    for e in entries:
        c = e.get('cycle')
        key = c if c is not None else '(none)'
        by_cycle[key].append(e)

    real_cycles = sorted(
        [c for c in by_cycle.keys() if c != '(none)'],
        key=lambda x: (x is None, x if x is not None else 0)
    )
    has_none = '(none)' in by_cycle
    all_cycles = real_cycles + (['(none)'] if has_none else [])

    if not all_cycles:
        lines.append("No data available.")
        return lines

    known_phases = ['plan', 'execute', 'review', 'refine']

    lines.append("| Cycle | Total Tokens | Plan | Execute | Review | Refine |")
    lines.append("| --- | --- | --- | --- | --- | --- |")

    for c in all_cycles:
        cycle_entries = by_cycle.get(c, [])
        total_tok = sum(tokens(e) for e in cycle_entries)

        by_phase = collections.defaultdict(int)
        for e in cycle_entries:
            phase = (e.get('phase') or '').lower()
            tok = tokens(e)
            by_phase[phase] += tok

        phase_cols = []
        for phase in known_phases:
            t = by_phase.get(phase, 0)
            phase_cols.append(fmt_tokens(t) if t else '-')

        lines.append(
            f"| {c} | {fmt_tokens(total_tok)} | "
            + " | ".join(phase_cols) + " |"
        )

    return lines


def section_cost_trends(entries):
    lines = ["## Cost Trends", ""]

    # Group by cycle
    by_cycle = collections.defaultdict(list)
    for e in entries:
        c = e.get('cycle')
        if c is not None:
            by_cycle[c].append(e)

    if not by_cycle:
        lines.append("No cycle data available.")
        return lines

    sorted_cycles = sorted(by_cycle.keys(), key=lambda x: (x is None, x if x is not None else 0))

    # Check if any entry has cycle_total_cost_estimate
    has_cost = any(
        e.get('cycle_total_cost_estimate') is not None
        for evts in by_cycle.values()
        for e in evts
    )

    if has_cost:
        lines.append("| Cycle | Total Tokens | Cost Estimate | vs Previous | Trend |")
        lines.append("| --- | --- | --- | --- | --- |")
    else:
        lines.append("| Cycle | Total Tokens | vs Previous | Trend |")
        lines.append("| --- | --- | --- | --- |")

    prev_tokens = None
    for c in sorted_cycles:
        cycle_entries = by_cycle[c]
        total_tok = sum(tokens(e) for e in cycle_entries)

        if prev_tokens is None:
            vs_prev = '-'
            trend = '-'
        else:
            delta = total_tok - prev_tokens
            if delta < 0:
                vs_prev = f"-{fmt_tokens(abs(delta))}"
                trend = 'down'
            elif delta > 0:
                vs_prev = f"+{fmt_tokens(delta)}"
                trend = 'up'
            else:
                vs_prev = '0'
                trend = 'stable'

        if has_cost:
            # Use cycle_total_cost_estimate from last entry that has it for this cycle
            cost_val = None
            for e in reversed(cycle_entries):
                if e.get('cycle_total_cost_estimate') is not None:
                    cost_val = e.get('cycle_total_cost_estimate')
                    break
            lines.append(
                f"| {c} | {fmt_tokens(total_tok)} | {fmt_cost(cost_val)} | {vs_prev} | {trend} |"
            )
        else:
            lines.append(f"| {c} | {fmt_tokens(total_tok)} | {vs_prev} | {trend} |")

        prev_tokens = total_tok

    if not has_cost:
        lines.append("")
        lines.append("_No dollar estimates available. Add `cycle_total_cost_estimate` to metrics entries to enable cost reporting._")

    return lines


def main():
    args = sys.argv[1:]

    if args and args[0] == '--help':
        print(HELP)
        sys.exit(0)

    if args:
        metrics_path = args[0]
    else:
        metrics_path = discover_metrics()

    entries = load_entries(metrics_path)

    if not entries:
        if not os.path.exists(metrics_path):
            print(f"No metrics file found at: {metrics_path}", file=sys.stderr)
        else:
            print("Metrics file is empty — no data to report.")
        sys.exit(0)

    sections = []
    sections.append("# Ideate Cost Report")
    sections.append("")
    sections.extend(section_per_work_item(entries))
    sections.append("")
    sections.extend(section_per_cycle(entries))
    sections.append("")
    sections.extend(section_cost_trends(entries))
    sections.append("")

    print('\n'.join(sections))


if __name__ == '__main__':
    main()
PYTHON_SCRIPT
