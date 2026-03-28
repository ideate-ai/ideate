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


HELP = """Usage: report-cycle.sh [OPTIONS] [METRICS_FILE]

Generate a cycle-over-cycle markdown report from an ideate metrics.jsonl file.

Arguments:
  METRICS_FILE    Path to metrics.jsonl file. If omitted, auto-discovery is
                  attempted by walking CWD upward looking for .ideate.json and
                  reading its artifactDir key.

Options:
  --help          Print this help message and exit.

Report Sections:
  Cycle-over-Cycle Quality Trends   Per-cycle finding counts by severity with
                                    trend indicator (improving/stable/degrading).
  Convergence Speed                 Number of autopilot/inner cycles per outer cycle.
  First-Pass Acceptance Rate        Percentage of work items accepted on first
                                    review pass per cycle.
"""


def fmt_tokens(n):
    if n >= 10000:
        return f"{n/1000:.1f}k"
    return f"{n:,}"


def fmt_ms(ms):
    if not ms:
        return "-"
    ms = int(ms)
    s = ms // 1000
    m = s // 60
    h = m // 60
    if h > 0:
        return f"{h}h {m%60}m {s%60}s"
    if m > 0:
        return f"{m}m {s%60}s"
    return f"{s}s"


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
        return [], []
    entries = []
    quality_events = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    if e.get('event_type') == 'quality_summary':
                        quality_events.append(e)
                    else:
                        entries.append(e)
                except json.JSONDecodeError:
                    continue
    except OSError as ex:
        print(f"Error: cannot read {path}: {ex}", file=sys.stderr)
        sys.exit(1)
    return entries, quality_events


def section_quality_trends(quality_events):
    lines = ["## Cycle-over-Cycle Quality Trends", ""]

    if not quality_events:
        lines.append("No quality data recorded. Run /ideate:review or /ideate:autopilot to generate quality metrics.")
        return lines

    # Sort by cycle
    sorted_events = sorted(quality_events, key=lambda e: (e.get('cycle') is None, e.get('cycle')))

    lines.append("| Cycle | Critical | Significant | Minor | Trend |")
    lines.append("| --- | --- | --- | --- | --- |")

    prev = None
    for e in sorted_events:
        c = e.get('cycle', '?')
        by_sev = (e.get('findings') or {}).get('by_severity') or {}
        critical = by_sev.get('critical', 0) or 0
        significant = by_sev.get('significant', 0) or 0
        minor = by_sev.get('minor', 0) or 0

        if prev is None:
            trend = '-'
        else:
            prev_score = prev[0] + prev[1]
            curr_score = critical + significant
            if curr_score < prev_score:
                trend = 'improving'
            elif curr_score > prev_score:
                trend = 'degrading'
            else:
                trend = 'stable'

        lines.append(f"| {c} | {critical} | {significant} | {minor} | {trend} |")
        prev = (critical, significant, minor)

    return lines


def section_convergence_speed(entries, quality_events):
    lines = ["## Convergence Speed", ""]

    # First, try to find explicit convergence_cycles field in convergence_summary or cycle_complete events
    convergence_by_cycle = {}
    for e in entries:
        et = e.get('event_type') or ''
        if et in ('convergence_summary', 'cycle_complete'):
            c = e.get('cycle')
            if c is not None:
                cc = e.get('convergence_cycles')
                if cc is not None:
                    convergence_by_cycle[c] = cc

    # Fallback: count distinct quality_summary events per cycle as a proxy for inner autopilot cycles
    if not convergence_by_cycle:
        cycle_counts = collections.Counter()
        for e in quality_events:
            c = e.get('cycle')
            if c is not None:
                cycle_counts[c] += 1
        # Only use proxy data if there are multiple quality events for at least one cycle
        # (single quality events per cycle mean autopilot ran once — not enough to be meaningful as convergence data)
        proxy_available = any(v > 1 for v in cycle_counts.values())
        if proxy_available:
            convergence_by_cycle = {c: v for c, v in cycle_counts.items()}

    if not convergence_by_cycle:
        lines.append("No convergence data recorded. Convergence speed is tracked when autopilot runs multiple review cycles.")
        return lines

    sorted_cycles = sorted(convergence_by_cycle.keys(), key=lambda x: (x is None, x if x is not None else 0))

    lines.append("| Cycle | Convergence Cycles |")
    lines.append("| --- | --- |")
    for c in sorted_cycles:
        lines.append(f"| {c} | {convergence_by_cycle[c]} |")

    return lines


def section_first_pass_acceptance(entries, quality_events):
    lines = ["## First-Pass Acceptance Rate", ""]

    # Look for first_pass_accepted field in any entry or quality event
    all_events = entries + quality_events
    has_field = any('first_pass_accepted' in e for e in all_events)

    if not has_field:
        lines.append("No first-pass data recorded. The `first_pass_accepted` field is not present in any metrics entry.")
        return lines

    # Group by cycle
    by_cycle = collections.defaultdict(lambda: {'total': 0, 'accepted': 0})
    for e in all_events:
        if 'first_pass_accepted' not in e:
            continue
        c = e.get('cycle', '(none)')
        by_cycle[c]['total'] += 1
        if e.get('first_pass_accepted'):
            by_cycle[c]['accepted'] += 1

    if not by_cycle:
        lines.append("No first-pass data recorded.")
        return lines

    sorted_cycles = sorted(
        by_cycle.keys(),
        key=lambda x: (x == '(none)', x if x != '(none)' else 0)
    )

    lines.append("| Cycle | Work Items | First-Pass Accepted | Acceptance Rate |")
    lines.append("| --- | --- | --- | --- |")
    for c in sorted_cycles:
        stats = by_cycle[c]
        total = stats['total']
        accepted = stats['accepted']
        rate = f"{accepted / total * 100:.0f}%" if total > 0 else '-'
        lines.append(f"| {c} | {total} | {accepted} | {rate} |")

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

    if not os.path.exists(metrics_path):
        print(f"No metrics file found at: {metrics_path}")
        print("Run /ideate:execute, /ideate:review, or /ideate:autopilot to generate metrics.")
        sys.exit(0)

    entries, quality_events = load_entries(metrics_path)

    if not entries and not quality_events:
        print(f"Metrics file exists but contains no data: {metrics_path}")
        sys.exit(0)

    sections = []
    sections.append("# Ideate Cycle Report")
    sections.append("")
    sections.extend(section_quality_trends(quality_events))
    sections.append("")
    sections.extend(section_convergence_speed(entries, quality_events))
    sections.append("")
    sections.extend(section_first_pass_acceptance(entries, quality_events))
    sections.append("")

    print('\n'.join(sections))


if __name__ == '__main__':
    main()
PYTHON_SCRIPT
