#!/usr/bin/env bash
set -euo pipefail

echo 'ERROR: This script is deprecated (see D-155).' >&2
echo 'Use ideate_get_metrics MCP tool or .ideate/metrics/ directory instead.' >&2
exit 1

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 is required but not found on PATH" >&2
    exit 1
fi

python3 - "$@" << 'PYTHON_SCRIPT'
import json
import sys
import os
import collections
from datetime import datetime
from pathlib import Path


HELP = """Usage: report.sh [OPTIONS] [METRICS_FILE]

Generate a markdown metrics report from an ideate metrics.jsonl file.

Arguments:
  METRICS_FILE    Path to metrics.jsonl file. If omitted, auto-discovery is
                  attempted by walking CWD upward looking for .ideate.json and
                  reading its artifactDir key.

Options:
  --help          Print this help message and exit.

Report Sections:
  Executive Summary         Total spawns, tokens, wall-clock time, cycles and
                            work items completed.
  Per-Cycle Breakdown       Token, time, work item, and quality finding counts
                            per cycle.
  Per-Task Breakdown        Token, time, and spawn counts per work item.
  Phase Analysis            Token, time, and spawn counts per phase, sorted by
                            tokens descending.
  Agent Performance         Token, time, and turn stats per agent type, sorted
                            by total tokens descending.
  RAG vs Flat-File Usage    Per-skill MCP tool usage percentages; top MCP tools
                            by call count.
  Quality Trends            Per-cycle finding counts by severity with trend
                            indicator (improving/stable/degrading).
"""


def tokens(e):
    return (e.get('input_tokens') or 0) + (e.get('output_tokens') or 0)


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


def section_executive_summary(entries, quality_events):
    lines = ["## Executive Summary", ""]
    if not entries and not quality_events:
        lines.append("No metrics data found.")
        return lines

    total_spawns = len(entries)
    total_tokens_val = sum(tokens(e) for e in entries)
    total_wall_ms = sum(e.get('wall_clock_ms') or 0 for e in entries)

    # cycles_completed: count distinct quality_summary events cycle numbers
    # plus any distinct cycle values from entries that aren't in quality events
    quality_cycles = set()
    for e in quality_events:
        c = e.get('cycle')
        if c is not None:
            quality_cycles.add(c)
    entry_cycles = set()
    for e in entries:
        c = e.get('cycle')
        if c is not None:
            entry_cycles.add(c)
    cycles_completed = len(quality_cycles | entry_cycles)

    work_items = set()
    for e in entries:
        wi = e.get('work_item')
        if wi is not None:
            work_items.add(wi)

    lines.append(f"| Metric | Value |")
    lines.append(f"| --- | --- |")
    lines.append(f"| Total agent spawns | {total_spawns:,} |")
    lines.append(f"| Total tokens (input + output) | {fmt_tokens(total_tokens_val)} |")
    lines.append(f"| Total wall-clock time | {fmt_ms(total_wall_ms)} |")
    lines.append(f"| Cycles completed | {cycles_completed:,} |")
    lines.append(f"| Work items completed | {len(work_items):,} |")
    return lines


def section_per_cycle_breakdown(entries, quality_events):
    lines = ["## Per-Cycle Breakdown", ""]

    # Build quality index by cycle
    quality_by_cycle = {}
    for e in quality_events:
        c = e.get('cycle')
        if c is not None:
            quality_by_cycle[c] = e

    # Group entries by cycle
    by_cycle = collections.defaultdict(list)
    for e in entries:
        c = e.get('cycle')
        key = c if c is not None else '(none)'
        by_cycle[key].append(e)

    real_cycles = sorted(
        [c for c in set(list(by_cycle.keys()) + list(quality_by_cycle.keys())) if c != '(none)'],
        key=lambda x: (x is None, x if x is not None else 0)
    )
    has_none = '(none)' in by_cycle
    all_cycles = real_cycles + (['(none)'] if has_none else [])

    if not all_cycles:
        lines.append("No data available.")
        return lines

    lines.append("| Cycle | Tokens | Wall Clock | Work Items | Critical | Significant | Minor |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")

    for c in all_cycles:
        cycle_entries = by_cycle.get(c, [])
        tok = sum(tokens(e) for e in cycle_entries)
        wall = sum(e.get('wall_clock_ms') or 0 for e in cycle_entries)
        wi_set = set(e.get('work_item') for e in cycle_entries if e.get('work_item') is not None)
        wi_count = len(wi_set)
        tok_str = fmt_tokens(tok) if cycle_entries else '-'
        wall_str = fmt_ms(wall) if cycle_entries else '-'

        qe = quality_by_cycle.get(c)
        if qe:
            by_sev = (qe.get('findings') or {}).get('by_severity') or {}
            critical = by_sev.get('critical', 0) or 0
            significant = by_sev.get('significant', 0) or 0
            minor = by_sev.get('minor', 0) or 0
            crit_str = str(critical)
            sig_str = str(significant)
            minor_str = str(minor)
        else:
            crit_str = sig_str = minor_str = '-'

        lines.append(f"| {c} | {tok_str} | {wall_str} | {wi_count:,} | {crit_str} | {sig_str} | {minor_str} |")

    return lines


def section_per_task_breakdown(entries):
    lines = ["## Per-Task Breakdown", ""]

    by_task = collections.defaultdict(list)
    for e in entries:
        wi = e.get('work_item')
        if wi is not None:
            by_task[wi].append(e)

    if not by_task:
        lines.append("No data available.")
        return lines

    lines.append("| Work Item | Tokens | Wall Clock | Spawns |")
    lines.append("| --- | --- | --- | --- |")

    for wi in sorted(by_task.keys(), key=str):
        task_entries = by_task[wi]
        tok = sum(tokens(e) for e in task_entries)
        wall = sum(e.get('wall_clock_ms') or 0 for e in task_entries)
        spawns = len(task_entries)
        lines.append(f"| {wi} | {fmt_tokens(tok)} | {fmt_ms(wall)} | {spawns:,} |")

    return lines


def section_phase_analysis(entries):
    lines = ["## Phase Analysis", ""]

    by_phase = collections.defaultdict(list)
    for e in entries:
        phase = e.get('phase') or '(none)'
        by_phase[phase].append(e)

    if not by_phase:
        lines.append("No data available.")
        return lines

    # Sort by total tokens descending
    phase_stats = []
    for phase, evts in by_phase.items():
        tok = sum(tokens(e) for e in evts)
        wall = sum(e.get('wall_clock_ms') or 0 for e in evts)
        spawns = len(evts)
        phase_stats.append((phase, tok, wall, spawns))
    phase_stats.sort(key=lambda x: x[1], reverse=True)

    lines.append("| Phase | Tokens | Wall Clock | Spawns |")
    lines.append("| --- | --- | --- | --- |")
    for phase, tok, wall, spawns in phase_stats:
        lines.append(f"| {phase} | {fmt_tokens(tok)} | {fmt_ms(wall)} | {spawns:,} |")

    return lines


def section_agent_performance(entries):
    lines = ["## Agent Performance", ""]

    by_agent = collections.defaultdict(list)
    for e in entries:
        agent = e.get('agent_type') or '(unknown)'
        by_agent[agent].append(e)

    if not by_agent:
        lines.append("No data available.")
        return lines

    agent_stats = []
    for agent, evts in by_agent.items():
        total_tok = sum(tokens(e) for e in evts)
        avg_tok = total_tok / len(evts) if evts else 0
        total_wall = sum(e.get('wall_clock_ms') or 0 for e in evts)
        avg_wall = total_wall / len(evts) if evts else 0
        turns_vals = [e.get('turns_used') for e in evts if e.get('turns_used') is not None]
        avg_turns = sum(turns_vals) / len(turns_vals) if turns_vals else None
        agent_stats.append((agent, total_tok, avg_tok, total_wall, avg_wall, avg_turns))

    agent_stats.sort(key=lambda x: x[1], reverse=True)

    lines.append("| Agent Type | Total Tokens | Avg Tokens | Total Time | Avg Time | Avg Turns |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    for agent, total_tok, avg_tok, total_wall, avg_wall, avg_turns in agent_stats:
        turns_str = f"{avg_turns:.1f}" if avg_turns is not None else '-'
        lines.append(
            f"| {agent} | {fmt_tokens(total_tok)} | {fmt_tokens(int(avg_tok))} | "
            f"{fmt_ms(int(total_wall))} | {fmt_ms(int(avg_wall))} | {turns_str} |"
        )

    return lines


def section_rag_vs_flatfile(entries):
    lines = ["## RAG vs Flat-File Usage", ""]

    # Check if any entry has mcp_tools_called
    any_mcp = any('mcp_tools_called' in e for e in entries)
    if not any_mcp:
        lines.append("No MCP tool usage recorded. Update skills to WI-092 schema to enable this report.")
        return lines

    # Per skill: count spawns where mcp_tools_called is non-empty vs total
    by_skill = collections.defaultdict(lambda: {'total': 0, 'with_mcp': 0})
    all_tool_calls = collections.Counter()

    for e in entries:
        skill = e.get('skill') or '(unknown)'
        by_skill[skill]['total'] += 1
        mcp = e.get('mcp_tools_called')
        if mcp and isinstance(mcp, list) and len(mcp) > 0:
            by_skill[skill]['with_mcp'] += 1
            for tool in mcp:
                if tool:
                    all_tool_calls[tool] += 1

    lines.append("### Per-Skill MCP Usage")
    lines.append("")
    lines.append("| Skill | Spawns | Spawns with MCP | % MCP |")
    lines.append("| --- | --- | --- | --- |")
    for skill in sorted(by_skill.keys()):
        stats = by_skill[skill]
        total = stats['total']
        with_mcp = stats['with_mcp']
        pct = (with_mcp / total * 100) if total > 0 else 0
        lines.append(f"| {skill} | {total:,} | {with_mcp:,} | {pct:.0f}% |")

    lines.append("")
    lines.append("### Top MCP Tools by Call Count")
    lines.append("")
    if not all_tool_calls:
        lines.append("No MCP tool calls recorded.")
    else:
        lines.append("| Tool | Calls |")
        lines.append("| --- | --- |")
        for tool, count in all_tool_calls.most_common(10):
            lines.append(f"| {tool} | {count:,} |")

    return lines


def section_quality_trends(quality_events):
    lines = ["## Quality Trends", ""]

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


def main():
    args = sys.argv[1:]

    if args and args[0] == '--help':
        print(HELP)
        sys.exit(0)

    if args:
        metrics_path = args[0]
    else:
        metrics_path = discover_metrics()

    entries, quality_events = load_entries(metrics_path)

    if not entries and not quality_events:
        print("No metrics data found.")
        sys.exit(0)

    sections = []
    sections.append("# Ideate Metrics Report")
    sections.append("")
    sections.extend(section_executive_summary(entries, quality_events))
    sections.append("")
    sections.extend(section_per_cycle_breakdown(entries, quality_events))
    sections.append("")
    sections.extend(section_per_task_breakdown(entries))
    sections.append("")
    sections.extend(section_phase_analysis(entries))
    sections.append("")
    sections.extend(section_agent_performance(entries))
    sections.append("")
    sections.extend(section_rag_vs_flatfile(entries))
    sections.append("")
    sections.extend(section_quality_trends(quality_events))
    sections.append("")

    print('\n'.join(sections))


if __name__ == '__main__':
    main()
PYTHON_SCRIPT
