import type { TelemetryReport } from './report.js';
/** Render the report as the dashboard table. Exported for tests. */
export declare function renderReport(report: TelemetryReport, stateDir: string): string;
/** CLI entry. Returns the process exit code (0 on success). */
export declare function main(argv?: string[], stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream): number;
//# sourceMappingURL=cli.d.ts.map