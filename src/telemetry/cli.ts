// plugin/src/telemetry/cli.ts — the `ideate-telemetry` CLI edge (WI-262).
//
// Prints the folded six-counter report as a readable table and exits 0.
// This is the outermost edge, so wall-clock defaults live here and nowhere
// deeper (repo convention) — though the report path is read-only and needs
// no clock at all.
//
// State-dir resolution (until the integrator, WI-271, wires the config-owned
// data dir as the default):
//   1. --dir <path>
//   2. $IDEATE_TELEMETRY_DIR
//   3. <cwd>/.ideate-telemetry   (placeholder default; never `.ideate/`)

import { join, resolve } from 'node:path';
import { reportFromDir } from './report.js';
import type { FrontierStats, TelemetryReport } from './report.js';

const USAGE = `Usage: ideate-telemetry [--dir <state-dir>]

Prints the ideate native telemetry report (the six counters of
docs/design/v3-architecture.md §3.5) folded from the append-only NDJSON
state under <state-dir>.

State dir resolution: --dir, then $IDEATE_TELEMETRY_DIR, then
<cwd>/.ideate-telemetry.
`;

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function breakdown(lines: string[], title: string, rec: Record<string, number>): void {
  const keys = Object.keys(rec).sort();
  if (keys.length === 0) return;
  lines.push('', `  ${title}`);
  const width = Math.max(...keys.map((k) => k.length)) + 2;
  for (const key of keys) {
    lines.push(`    ${pad(key, width)}${num(rec[key] ?? 0)}`);
  }
}

function frontierLine(stats: FrontierStats): string {
  if (stats.samples === 0) return 'no samples';
  return `samples ${stats.samples}  min ${num(stats.min ?? 0)}  max ${num(stats.max ?? 0)}  mean ${num(stats.mean ?? 0)}  last ${num(stats.last ?? 0)}`;
}

/** Render the report as the dashboard table. Exported for tests. */
export function renderReport(report: TelemetryReport, stateDir: string): string {
  const lines: string[] = [];
  lines.push('ideate telemetry report');
  lines.push(`  state dir: ${stateDir}`);
  lines.push('');

  const rows: Array<[string, string]> = [
    ['capture_fired', num(report.captureFired.total)],
    ['priming.requested', num(report.priming.requested.total)],
    ['priming.usefulness', num(report.priming.usefulness.recorded)],
    ['kg_unreachable', num(report.kgUnreachable.total)],
    ['frontier_size (samples)', num(report.frontierSize.overall.samples)],
    ['capture_write_failed', num(report.captureWriteFailed.total)],
    ['redactions', num(report.redactions.total)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  lines.push(`  ${pad('counter', width)}total`);
  lines.push(`  ${pad('-'.repeat(width - 2), width)}-----`);
  for (const [label, value] of rows) {
    lines.push(`  ${pad(label, width)}${value}`);
  }

  breakdown(lines, 'capture_fired by point', report.captureFired.byPoint);
  breakdown(lines, 'capture_fired by session', report.captureFired.bySession);
  breakdown(lines, 'priming.requested by source', report.priming.requested.bySource);
  breakdown(lines, 'priming.requested by session', report.priming.requested.bySession);
  breakdown(lines, 'kg_unreachable by session', report.kgUnreachable.bySession);

  lines.push('', `  frontier_size: ${frontierLine(report.frontierSize.overall)}`);
  const frontierSessions = Object.keys(report.frontierSize.bySession).sort();
  for (const sessionId of frontierSessions) {
    const stats = report.frontierSize.bySession[sessionId];
    if (stats !== undefined) {
      lines.push(`    ${sessionId}: ${frontierLine(stats)}`);
    }
  }

  breakdown(lines, 'capture_write_failed by point', report.captureWriteFailed.byPoint);
  breakdown(lines, 'capture_write_failed by reason', report.captureWriteFailed.byReason);
  breakdown(lines, 'capture_write_failed by session', report.captureWriteFailed.bySession);

  breakdown(lines, 'redactions by pattern', report.redactions.byPattern);
  breakdown(lines, 'redactions by session', report.redactions.bySession);

  lines.push('');
  return lines.join('\n');
}

/** CLI entry. Returns the process exit code (0 on success). */
export function main(
  argv: string[] = process.argv.slice(2),
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): number {
  let dirArg: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      stdout.write(USAGE);
      return 0;
    }
    if (arg === '--dir') {
      const value = argv[i + 1];
      if (value === undefined) {
        stderr.write('ideate-telemetry: --dir requires a path\n');
        return 2;
      }
      dirArg = value;
      i += 1;
      continue;
    }
    stderr.write(`ideate-telemetry: unknown argument ${String(arg)}\n${USAGE}`);
    return 2;
  }

  const stateDir = resolve(
    dirArg ?? process.env.IDEATE_TELEMETRY_DIR ?? join(process.cwd(), '.ideate-telemetry'),
  );
  const { report, skippedLines } = reportFromDir(stateDir);
  if (skippedLines > 0) {
    stderr.write(
      `ideate-telemetry: skipped ${skippedLines} unparseable line(s) in the state file (torn write?)\n`,
    );
  }
  stdout.write(renderReport(report, stateDir));
  return 0;
}
