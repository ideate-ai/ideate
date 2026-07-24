// plugin/src/usage/schema.ts — the context-usage (citation) signal shape
// and its one-line NDJSON serialization.
//
// WHY THIS EXISTS (the effectiveness denominator):
//   The context-delivery mechanism is gated OFF until an eval MEASURES its
//   quality. That eval's context-quality metric (recall@budget +
//   signal-density) needs a GROUND-TRUTH "used" set — of the items an
//   assembler DELIVERED, which ones did the worker actually USE. That signal
//   does not otherwise exist: no edge type is written when an agent cites or
//   uses an artifact. Without it, recall has no denominator and effectiveness
//   is guessed, not measured. This module writes that signal.
//
// WHAT A SIGNAL IS (and is NOT):
//   A usage signal is a lightweight, append-only PROVENANCE record: "delivered
//   item `item_id` was used, for seed `seed_id`, from manifest `manifest_id`,
//   by session/task X, at time T." It is deliberately NOT a general edge store
//   (there is none by design — the record is append-only prose, the board is a
//   DAG). It is a flat citation log: the minimal shape that lets the metric
//   form `{ used items } / task` as its recall denominator.
//
// MECHANICAL, NOT INFERRED:
//   The `item_id`s written here are produced by pure string matching of
//   delivered ids against captured text (usage/detect.ts), never by an LLM
//   judging relevance. Same input text + same delivered set always yields the
//   same signals.
//
// Serialization: one JSON object per line (NDJSON), mirroring telemetry's
// append-only NDJSON (counters.ts) rather than the record store's one-file-
// per-entry Markdown — a usage signal is structured measurement data, not
// recall-shaped prose, and NDJSON gives atomic O_APPEND writes with a trivial
// fold-on-read. `parseUsageSignal(serializeUsageSignal(s))` is identity for
// every valid signal.

/** The 'used' vocabulary — an OPEN set, mirroring `ProcessRecord.kind`. The
 *  two named values are the design's `used_context` (the default: a delivered
 *  item appeared in the worker's captured output) and `cites` (an explicit
 *  reference). New capture points may introduce further kinds without a schema
 *  change. */
export const USAGE_KIND_USED_CONTEXT = 'used_context';
export const USAGE_KIND_CITES = 'cites';

/** Provenance — WHERE/WHEN a usage signal came from. Mirrors the record
 *  store's `RecordSource` so a usage signal is traceable to the same capture
 *  vocabulary. */
export interface UsageSource {
  /** The originating capture point (e.g. 'mcp:usage_capture', 'record_append',
   *  'work_complete', 'eval-replay'). */
  capture_point: string;
  /** Session that produced the signal. */
  session_id: string;
  /** Task / work-item ID, when one is in scope. */
  task_id?: string;
  /** ISO-8601 capture timestamp (from the injected clock). */
  timestamp: string;
}

/**
 * One context-usage (citation) signal: delivered item `item_id` was USED.
 *
 * `seed_id` and `manifest_id` tie the signal back to a specific assembly so
 * the metric can group ground-truth "used" items per task and per manifest;
 * both are optional because a citation can be captured even where no manifest
 * is in scope (e.g. a plain record_read priming).
 */
export interface UsageSignal {
  /** ULID — sortable-by-construction, so the NDJSON append order is
   *  chronological (see record/id.ts). */
  id: string;
  /** The 'used' relation kind — open vocabulary (see the KIND constants). */
  kind: string;
  /** The delivered / primed artifact id that was used (a work-item id, a
   *  record ULID, a policy id). Always present and non-empty — an empty
   *  citation is meaningless. */
  item_id: string;
  /** The seed the assembly was for (usually the claimed work item). The
   *  recall denominator groups used items by this. */
  seed_id?: string;
  /** The assembly manifest the item was delivered in — links a usage back to
   *  exactly what was offered (the metric scores delivered-vs-used per manifest). */
  manifest_id?: string;
  /** Provenance. */
  source: UsageSource;
}

/** Typed schema failure: a required field is absent or malformed. */
export class UsageSchemaError extends Error {
  override readonly name = 'UsageSchemaError';
  /** Dotted path of the offending field, e.g. `source.session_id`. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

function requireString(value: unknown, field: string, allowEmpty = true): string {
  if (typeof value !== 'string') {
    throw new UsageSchemaError(
      field,
      `usage schema: field "${field}" must be present as a string; got ${value === undefined ? 'absent' : typeof value}`,
    );
  }
  if (!allowEmpty && value.length === 0) {
    throw new UsageSchemaError(field, `usage schema: field "${field}" must be a NON-EMPTY string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field, false);
}

/**
 * Validate a signal-shaped object: `item_id` present and non-empty, `kind`
 * present, `source` present with its required members. Optional ids, when
 * present, must be non-empty strings. Returns the normalized signal; throws
 * {@link UsageSchemaError} on any violation.
 */
export function validateUsageSignal(input: unknown): UsageSignal {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new UsageSchemaError('(signal)', 'usage schema: a signal must be an object');
  }
  const raw = input as Record<string, unknown>;

  const sourceRaw = raw['source'];
  if (sourceRaw === null || typeof sourceRaw !== 'object' || Array.isArray(sourceRaw)) {
    throw new UsageSchemaError('source', 'usage schema: field "source" must be present as an object');
  }
  const src = sourceRaw as Record<string, unknown>;

  const taskId = optionalString(src['task_id'], 'source.task_id');
  const source: UsageSource = {
    capture_point: requireString(src['capture_point'], 'source.capture_point', false),
    session_id: requireString(src['session_id'], 'source.session_id', false),
    timestamp: requireString(src['timestamp'], 'source.timestamp', false),
    ...(taskId === undefined ? {} : { task_id: taskId }),
  };

  const seedId = optionalString(raw['seed_id'], 'seed_id');
  const manifestId = optionalString(raw['manifest_id'], 'manifest_id');

  return {
    id: requireString(raw['id'], 'id', false),
    kind: requireString(raw['kind'], 'kind', false),
    item_id: requireString(raw['item_id'], 'item_id', false),
    ...(seedId === undefined ? {} : { seed_id: seedId }),
    ...(manifestId === undefined ? {} : { manifest_id: manifestId }),
    source,
  };
}

/** Serialize a signal to its on-disk NDJSON form: exactly one JSON object,
 *  no trailing newline (the store adds the line terminator). Keys are emitted
 *  in a stable order so the on-disk form is deterministic. */
export function serializeUsageSignal(signal: UsageSignal): string {
  const validated = validateUsageSignal(signal);
  const source: Record<string, string> = {
    capture_point: validated.source.capture_point,
    session_id: validated.source.session_id,
    ...(validated.source.task_id === undefined ? {} : { task_id: validated.source.task_id }),
    timestamp: validated.source.timestamp,
  };
  const ordered: Record<string, unknown> = {
    id: validated.id,
    kind: validated.kind,
    item_id: validated.item_id,
    ...(validated.seed_id === undefined ? {} : { seed_id: validated.seed_id }),
    ...(validated.manifest_id === undefined ? {} : { manifest_id: validated.manifest_id }),
    source,
  };
  return JSON.stringify(ordered);
}

/** Parse one NDJSON line back to a validated signal. Inverse of
 *  {@link serializeUsageSignal}; throws {@link UsageSchemaError} on a
 *  non-object / malformed line. */
export function parseUsageSignal(line: string): UsageSignal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    throw new UsageSchemaError('(line)', `usage schema: line is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateUsageSignal(parsed);
}
