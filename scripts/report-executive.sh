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


HELP = """Usage: report-executive.sh [OPTIONS] [METRICS_FILE]

Generate a high-level executive summary from an ideate metrics.jsonl file.

Arguments:
  METRICS_FILE    Path to metrics.jsonl file. If omitted, auto-discovery is
                  attempted by walking CWD upward looking for .ideate.json and
                  reading its artifactDir key.

Options:
  --help          Print this help message and exit.

Report Sections:
  Project Summary     Total work items completed, total cycles, total agent
                      spawns, and total wall-clock time.
  Quality Metrics     Latest cycle finding counts by severity, trend direction,
                      first-pass acceptance rate, and overall rework rate.
  Cost Summary        Total tokens consumed, estimated cost (if available),
                      average tokens per work item, and per cycle.
  ROI Indicators      Rework rate trend, convergence speed trend,
                      tokens-per-finding ratio, and first-pass rate trend.
"""


# Cost estimate constants (approximate Claude pricing as of 2026-03)
# These are rough estimates; actual cost depends on model and pricing tier.
COST_PER_1K_INPUT_TOKENS = 0.003    # $0.003 per 1k input tokens (Sonnet)
COST_PER_1K_OUTPUT_TOKENS = 0.015   # $0.015 per 1k output tokens (Sonnet)


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


def get_cycle_set(entries, quality_events):
    quality_cycles = {e.get('cycle') for e in quality_events if e.get('cycle') is not None}
    entry_cycles = {e.get('cycle') for e in entries if e.get('cycle') is not None}
    return quality_cycles | entry_cycles


def get_work_items(entries):
    return {e.get('work_item') for e in entries if e.get('work_item') is not None}


def section_project_summary(entries, quality_events):
    lines = ["## Project Summary", ""]
    if not entries and not quality_events:
        lines.append("No metrics data found.")
        return lines

    total_spawns = len(entries)
    total_tokens_val = sum(tokens(e) for e in entries)
    total_wall_ms = sum(e.get('wall_clock_ms') or 0 for e in entries)
    cycles_completed = len(get_cycle_set(entries, quality_events))
    work_items = get_work_items(entries)

    lines.append("| Metric | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| Work items completed | {len(work_items):,} |")
    lines.append(f"| Cycles completed | {cycles_completed:,} |")
    lines.append(f"| Total agent spawns | {total_spawns:,} |")
    lines.append(f"| Total wall-clock time | {fmt_ms(total_wall_ms)} |")
    return lines


def section_quality_metrics(entries, quality_events):
    lines = ["## Quality Metrics", ""]

    if not quality_events:
        lines.append("No quality data recorded. Run /ideate:review or /ideate:autopilot to generate quality metrics.")
        return lines

    # Sort quality events by cycle
    sorted_qe = sorted(quality_events, key=lambda e: (e.get('cycle') is None, e.get('cycle')))

    latest = sorted_qe[-1]
    latest_cycle = latest.get('cycle', '?')
    by_sev = (latest.get('findings') or {}).get('by_severity') or {}
    critical = by_sev.get('critical', 0) or 0
    significant = by_sev.get('significant', 0) or 0
    minor = by_sev.get('minor', 0) or 0
    total_findings = critical + significant + minor

    # Trend vs previous cycle
    if len(sorted_qe) >= 2:
        prev = sorted_qe[-2]
        prev_sev = (prev.get('findings') or {}).get('by_severity') or {}
        prev_score = (prev_sev.get('critical', 0) or 0) + (prev_sev.get('significant', 0) or 0)
        curr_score = critical + significant
        if curr_score < prev_score:
            trend = "improving"
        elif curr_score > prev_score:
            trend = "degrading"
        else:
            trend = "stable"
    else:
        trend = "-"

    lines.append(f"**Latest cycle: {latest_cycle}**")
    lines.append("")
    lines.append("| Metric | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| Critical findings | {critical} |")
    lines.append(f"| Significant findings | {significant} |")
    lines.append(f"| Minor findings | {minor} |")
    lines.append(f"| Total findings | {total_findings} |")
    lines.append(f"| Trend (vs previous cycle) | {trend} |")

    # First-pass acceptance rate: work items accepted without rework in latest cycle
    # Look at entries in the latest cycle for rework_count
    cycle_entries = [e for e in entries if e.get('cycle') == latest_cycle]
    rework_counts = [e.get('rework_count') or 0 for e in cycle_entries if 'rework_count' in e]
    if rework_counts:
        first_pass = sum(1 for r in rework_counts if r == 0)
        first_pass_rate = first_pass / len(rework_counts) * 100
        lines.append(f"| First-pass acceptance rate | {first_pass_rate:.0f}% ({first_pass}/{len(rework_counts)}) |")
    else:
        lines.append("| First-pass acceptance rate | - |")

    # Overall rework rate across all cycles
    all_rework = [e.get('rework_count') or 0 for e in entries if 'rework_count' in e]
    if all_rework:
        reworked = sum(1 for r in all_rework if r > 0)
        overall_rework_rate = reworked / len(all_rework) * 100
        lines.append(f"| Overall rework rate | {overall_rework_rate:.0f}% ({reworked}/{len(all_rework)}) |")
    else:
        lines.append("| Overall rework rate | - |")

    return lines


def section_cost_summary(entries, quality_events):
    lines = ["## Cost Summary", ""]

    if not entries:
        lines.append("No metrics data found.")
        return lines

    total_input = sum(e.get('input_tokens') or 0 for e in entries)
    total_output = sum(e.get('output_tokens') or 0 for e in entries)
    total_tok = total_input + total_output

    work_items = get_work_items(entries)
    cycles = get_cycle_set(entries, quality_events)
    num_wi = len(work_items)
    num_cycles = len(cycles)

    avg_per_wi = total_tok / num_wi if num_wi > 0 else 0
    avg_per_cycle = total_tok / num_cycles if num_cycles > 0 else 0

    # Estimated cost
    # Check if any entry has explicit cost data
    has_cost = any('cost_usd' in e for e in entries)
    if has_cost:
        total_cost = sum(e.get('cost_usd') or 0 for e in entries)
        cost_str = f"${total_cost:.4f}"
    elif total_input > 0 or total_output > 0:
        # Estimate from token counts
        est_cost = (total_input / 1000 * COST_PER_1K_INPUT_TOKENS) + (total_output / 1000 * COST_PER_1K_OUTPUT_TOKENS)
        cost_str = f"~${est_cost:.4f} (estimated)"
    else:
        cost_str = "-"

    lines.append("| Metric | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| Total tokens (input + output) | {fmt_tokens(total_tok)} |")
    lines.append(f"| Input tokens | {fmt_tokens(total_input)} |")
    lines.append(f"| Output tokens | {fmt_tokens(total_output)} |")
    lines.append(f"| Estimated cost | {cost_str} |")
    lines.append(f"| Avg tokens per work item | {fmt_tokens(int(avg_per_wi))} |")
    lines.append(f"| Avg tokens per cycle | {fmt_tokens(int(avg_per_cycle))} |")

    return lines


def section_roi_indicators(entries, quality_events):
    lines = ["## ROI Indicators", ""]

    if not entries and not quality_events:
        lines.append("No metrics data found.")
        return lines

    # Sort quality events by cycle for trend analysis
    sorted_qe = sorted(quality_events, key=lambda e: (e.get('cycle') is None, e.get('cycle')))

    # --- Rework rate trend ---
    # Group entries by cycle, compute rework rate per cycle, check direction
    by_cycle = collections.defaultdict(list)
    for e in entries:
        c = e.get('cycle')
        if c is not None and 'rework_count' in e:
            by_cycle[c].append(e.get('rework_count') or 0)

    sorted_cycles = sorted(by_cycle.keys(), key=lambda x: (x is None, x))
    rework_rates = []
    for c in sorted_cycles:
        rc_list = by_cycle[c]
        if rc_list:
            rate = sum(1 for r in rc_list if r > 0) / len(rc_list)
            rework_rates.append(rate)

    if len(rework_rates) >= 2:
        if rework_rates[-1] < rework_rates[0]:
            rework_trend = "improving (rework decreasing)"
        elif rework_rates[-1] > rework_rates[0]:
            rework_trend = "degrading (rework increasing)"
        else:
            rework_trend = "stable"
    elif rework_rates:
        rework_trend = f"{rework_rates[0]*100:.0f}% (single cycle)"
    else:
        rework_trend = "-"

    # --- Convergence speed trend ---
    # autopilot_cycles_used per cycle — decreasing means faster convergence
    autopilot_by_cycle = collections.defaultdict(list)
    for e in entries:
        c = e.get('cycle')
        bcu = e.get('autopilot_cycles_used')
        if c is not None and bcu is not None:
            autopilot_by_cycle[c].append(bcu)

    autopilot_avgs = []
    for c in sorted_cycles:
        bcu_list = autopilot_by_cycle.get(c, [])
        if bcu_list:
            autopilot_avgs.append(sum(bcu_list) / len(bcu_list))

    if len(autopilot_avgs) >= 2:
        if autopilot_avgs[-1] < autopilot_avgs[0]:
            conv_trend = "improving (fewer autopilot cycles needed)"
        elif autopilot_avgs[-1] > autopilot_avgs[0]:
            conv_trend = "degrading (more autopilot cycles needed)"
        else:
            conv_trend = "stable"
    else:
        conv_trend = "-"

    # --- Tokens-per-finding ratio ---
    total_tok = sum(tokens(e) for e in entries)
    total_findings = 0
    for qe in quality_events:
        by_sev = (qe.get('findings') or {}).get('by_severity') or {}
        total_findings += sum(by_sev.get(s, 0) or 0 for s in ('critical', 'significant', 'minor'))

    if total_findings > 0 and total_tok > 0:
        tpf = total_tok / total_findings
        tpf_str = fmt_tokens(int(tpf))
    elif total_tok > 0 and total_findings == 0:
        tpf_str = "N/A (no findings)"
    else:
        tpf_str = "-"

    # --- First-pass rate trend ---
    # Per cycle first-pass rate — improving if rate is rising
    fp_rates = []
    for c in sorted_cycles:
        c_entries = [e for e in entries if e.get('cycle') == c and 'rework_count' in e]
        if c_entries:
            fp = sum(1 for e in c_entries if (e.get('rework_count') or 0) == 0)
            fp_rates.append(fp / len(c_entries))

    if len(fp_rates) >= 2:
        if fp_rates[-1] > fp_rates[0]:
            fp_trend = "improving (first-pass rate increasing)"
        elif fp_rates[-1] < fp_rates[0]:
            fp_trend = "degrading (first-pass rate decreasing)"
        else:
            fp_trend = "stable"
    elif fp_rates:
        fp_trend = f"{fp_rates[0]*100:.0f}% (single cycle)"
    else:
        fp_trend = "-"

    lines.append("| Indicator | Value |")
    lines.append("| --- | --- |")
    lines.append(f"| Rework rate trend | {rework_trend} |")
    lines.append(f"| Convergence speed trend | {conv_trend} |")
    lines.append(f"| Tokens per finding | {tpf_str} |")
    lines.append(f"| First-pass rate trend | {fp_trend} |")

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
        print(f"No metrics file found at: {metrics_path}", file=sys.stderr)
        print("Run /ideate:execute or /ideate:autopilot to generate metrics data.", file=sys.stderr)
        sys.exit(0)

    entries, quality_events = load_entries(metrics_path)

    if not entries and not quality_events:
        print(f"Metrics file exists but contains no data: {metrics_path}")
        print("Run /ideate:execute or /ideate:autopilot to generate metrics data.")
        sys.exit(0)

    sections = []
    sections.append("# Ideate Executive Report")
    sections.append("")
    sections.extend(section_project_summary(entries, quality_events))
    sections.append("")
    sections.extend(section_quality_metrics(entries, quality_events))
    sections.append("")
    sections.extend(section_cost_summary(entries, quality_events))
    sections.append("")
    sections.extend(section_roi_indicators(entries, quality_events))
    sections.append("")

    print('\n'.join(sections))


if __name__ == '__main__':
    main()
PYTHON_SCRIPT
