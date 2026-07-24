// @ideate/plugin — public composable surface.

export const IDEATE_V3 = true;

// .ideate.json config — lazy init, non-destructive detection of a legacy config.
export {
  CONFIG_FILENAME,
  DEFAULT_RECORD_PATH,
  IdeateConfigError,
  V3_SCHEMA_VERSION,
  loadConfig,
  recordPath,
} from "./config/ideate-config.js";
export type { IdeateConfigErrorCode, IdeateConfigV3 } from "./config/ideate-config.js";

// Native telemetry counters.
export {
  COUNTER_NAMES,
  TELEMETRY_FILE,
  TelemetryCounters,
  createTelemetry,
} from "./telemetry/counters.js";
export type { Clock, CounterName, TelemetryEvent } from "./telemetry/counters.js";
export {
  emptyReport,
  foldReport,
  parseEventLine,
  readTelemetryEvents,
  reportFromDir,
} from "./telemetry/report.js";
export type {
  FrontierStats,
  PrimingUsefulnessRecord,
  TelemetryReport,
} from "./telemetry/report.js";

// Capture-time secret-scanning gate.
export {
  DEFAULT_ENTROPY_THRESHOLD,
  ENTROPY_MIN_LENGTH,
  SECRET_PATTERNS,
  redactionMarker,
  shannonEntropy,
} from "./secret-gate/patterns.js";
export type { SecretPattern } from "./secret-gate/patterns.js";
export { scanAndMask } from "./secret-gate/scan.js";
export type { OnRedaction, Redaction, ScanOptions, ScanResult } from "./secret-gate/scan.js";

// The process-record store core. Append + read only — no update, no
// delete, no rank, by contract.
export { ULID_LENGTH, createUlidGenerator, isUlid, parseUlidTimestamp } from "./record/id.js";
export type { UlidGenerator } from "./record/id.js";
export { RecordSchemaError, parseRecord, serializeRecord, validateRecord } from "./record/schema.js";
export type { ProcessRecord, RecordSource } from "./record/schema.js";
export { RecordStore } from "./record/store.js";
export type { AppendErrorCode, AppendResult, ReadOptions, RecordInput } from "./record/store.js";

// The three record MCP verbs — record_append / record_read / record_decision,
// closing the record core. Append-only surface; registration is side-effect
// free (first tool call lazy-inits config + record dir).
export { RECORD_TOOL_NAMES, createRecordToolsRegistrar } from "./record/tools.js";
export type { RecordToolsOptions } from "./record/tools.js";

// The `ideate-record` CLI — the second transport over the same gated
// record core (one implementation, two transports; hook-written records pass
// the same secret gate). Direct paths (append/read) exit 1 on failure; hook
// paths (session-end/prime) always exit 0 — see the exit-code split note in
// cli/ideate-record.ts.
export { DEFAULT_PRIME_BUDGET, main as ideateRecordCliMain } from "./cli/ideate-record.js";
export type { CliIo as IdeateRecordCliIo } from "./cli/ideate-record.js";
