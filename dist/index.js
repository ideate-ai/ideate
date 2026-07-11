// @ideate/plugin — v3 public composable surface.
// Scaffold placeholder; see docs/design/v3-composable-surface.md.
export const IDEATE_V3 = true;
// WI-270: .ideate.json v3 config — lazy init, non-destructive v9 detection.
export { CONFIG_FILENAME, DEFAULT_RECORD_PATH, IdeateConfigError, V3_SCHEMA_VERSION, loadConfig, recordPath, } from "./config/ideate-config.js";
// WI-262: native telemetry counters (docs/design/v3-architecture.md §3.5).
export { COUNTER_NAMES, TELEMETRY_FILE, TelemetryCounters, createTelemetry, } from "./telemetry/counters.js";
export { emptyReport, foldReport, parseEventLine, readTelemetryEvents, reportFromDir, } from "./telemetry/report.js";
// WI-272: capture-time secret-scanning gate (v3-boundary-contract.md §2, amendment I).
export { DEFAULT_ENTROPY_THRESHOLD, ENTROPY_MIN_LENGTH, SECRET_PATTERNS, redactionMarker, shannonEntropy, } from "./secret-gate/patterns.js";
export { scanAndMask } from "./secret-gate/scan.js";
// WI-271: the v3 process-record store core (v3-architecture.md §2.1/§2.2,
// v3-boundary-contract.md §4.2/§6.2). Append + read only — no update, no
// delete, no rank, by contract.
export { ULID_LENGTH, createUlidGenerator, isUlid, parseUlidTimestamp } from "./record/id.js";
export { RecordSchemaError, parseRecord, serializeRecord, validateRecord } from "./record/schema.js";
export { RecordStore } from "./record/store.js";
// WI-273: the three record MCP verbs (v3-composable-surface.md §1.1) —
// record_append / record_read / record_decision, closing the Layer-0 record
// core. Append-only surface; registration is side-effect free (first tool
// call lazy-inits config + record dir).
export { RECORD_TOOL_NAMES, createRecordToolsRegistrar } from "./record/tools.js";
// WI-274: the `ideate-record` CLI — the second transport over the same gated
// record core (v3-composable-surface.md §1.1: one implementation, two
// transports; §2.1 Tier B: hook-written records pass the same secret gate).
// Direct paths (append/read) exit 1 on failure; hook paths (session-end/
// prime) always exit 0 — see the exit-code split note in cli/ideate-record.ts.
export { DEFAULT_PRIME_BUDGET, main as ideateRecordCliMain } from "./cli/ideate-record.js";
//# sourceMappingURL=index.js.map