// plugin/src/record/schema.ts — the v3 process record shape and its
// Markdown-with-YAML-frontmatter serialization (WI-271).
//
// Spec: docs/design/v3-architecture.md §2.1 property 3 ("Markdown body
// carries the recall-shaped prose; frontmatter carries the structured
// fields") and docs/spikes/v3-boundary-contract.md §6.2 (the four contract
// fields — Claim, Verification anchor, Scope/applicability, Source — are
// ALWAYS PRESENT at the schema level; they may be empty when a capture point
// produced no qualifying content, but their ABSENCE is a schema error).
//
// Serialization posture:
// - Frontmatter carries: id, kind, the four contract fields (claim,
//   verification_anchor, scope, source). The prose body is `content` — the
//   recall-shaped words a future question might use (§6.2).
// - Every scalar frontmatter value is written as a JSON string, which is a
//   valid YAML double-quoted scalar. JSON escaping makes the round trip
//   exact for any content — embedded newlines, quotes, colons, even `---`
//   lines — without a YAML dependency (zero-runtime-deps repo posture).
// - `parseRecord(serializeRecord(r))` is identity for every valid record;
//   round-trip safety is pinned by store.test.ts.

/** Provenance — the fourth contract field (boundary contract §6.2 "Source"). */
export interface RecordSource {
  /** The originating capture point (boundary contract §2, rows 1–6). */
  capture_point: string;
  /** Session that produced the record. */
  session_id: string;
  /** Task / work-item ID, when one is in scope. */
  task_id?: string;
  /** ISO-8601 capture timestamp (from the injected clock). */
  timestamp: string;
}

/**
 * One process record. `kind` is an OPEN vocabulary — decision | finding |
 * session-outcome | subagent-outcome | commit-boundary | task-completion |
 * … — deliberately not a closed union: new capture points must not require
 * a schema change.
 */
export interface ProcessRecord {
  /** ULID — filename stem and the KG sourceUri's record ID (§2.1). */
  id: string;
  kind: string;
  /** Contract field 1 — the candidate discovery statement. May be empty. */
  claim: string;
  /** Contract field 2 — how the claim can be checked. May be empty. */
  verification_anchor: string;
  /** Contract field 3 — what future work the claim is load-bearing for. May be empty. */
  scope: string;
  /** Contract field 4 — provenance. */
  source: RecordSource;
  /** Recall-shaped prose body (boundary contract §6.2). May be empty. */
  content: string;
}

/** Typed schema failure: a required field is ABSENT (emptiness is valid). */
export class RecordSchemaError extends Error {
  override readonly name = 'RecordSchemaError';
  /** Dotted path of the offending field, e.g. `source.session_id`. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

const FRONTMATTER_FENCE = '---';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new RecordSchemaError(
      field,
      `record schema: field "${field}" must be present as a string (empty allowed, absence is a schema error); got ${
        value === undefined ? 'absent' : typeof value
      }`,
    );
  }
  return value;
}

/**
 * Validate a record-shaped object: every contract field present as a string
 * (empty allowed), `source` present with its required members. Returns the
 * normalized record; throws RecordSchemaError on any absence.
 */
export function validateRecord(input: unknown): ProcessRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RecordSchemaError('(record)', 'record schema: a record must be an object');
  }
  const raw = input as Record<string, unknown>;

  const sourceRaw = raw['source'];
  if (sourceRaw === null || typeof sourceRaw !== 'object' || Array.isArray(sourceRaw)) {
    throw new RecordSchemaError(
      'source',
      'record schema: field "source" must be present as an object (boundary contract §6.2: fields always present)',
    );
  }
  const src = sourceRaw as Record<string, unknown>;

  const taskId = src['task_id'];
  if (taskId !== undefined && typeof taskId !== 'string') {
    throw new RecordSchemaError('source.task_id', 'record schema: source.task_id must be a string when present');
  }

  const source: RecordSource = {
    capture_point: requireString(src['capture_point'], 'source.capture_point'),
    session_id: requireString(src['session_id'], 'source.session_id'),
    timestamp: requireString(src['timestamp'], 'source.timestamp'),
    ...(taskId === undefined ? {} : { task_id: taskId }),
  };

  return {
    id: requireString(raw['id'], 'id'),
    kind: requireString(raw['kind'], 'kind'),
    claim: requireString(raw['claim'], 'claim'),
    verification_anchor: requireString(raw['verification_anchor'], 'verification_anchor'),
    scope: requireString(raw['scope'], 'scope'),
    source,
    content: requireString(raw['content'], 'content'),
  };
}

/** One frontmatter scalar line: `key: <JSON string>` (valid YAML). */
function scalarLine(key: string, value: string, indent = ''): string {
  return `${indent}${key}: ${JSON.stringify(value)}`;
}

/**
 * Serialize a record to its on-disk Markdown form: YAML frontmatter carrying
 * id + kind + the four contract fields, then the prose body.
 */
export function serializeRecord(record: ProcessRecord): string {
  const validated = validateRecord(record);
  const lines: string[] = [
    FRONTMATTER_FENCE,
    scalarLine('id', validated.id),
    scalarLine('kind', validated.kind),
    scalarLine('claim', validated.claim),
    scalarLine('verification_anchor', validated.verification_anchor),
    scalarLine('scope', validated.scope),
    'source:',
    scalarLine('capture_point', validated.source.capture_point, '  '),
    scalarLine('session_id', validated.source.session_id, '  '),
  ];
  if (validated.source.task_id !== undefined) {
    lines.push(scalarLine('task_id', validated.source.task_id, '  '));
  }
  lines.push(scalarLine('timestamp', validated.source.timestamp, '  '), FRONTMATTER_FENCE);
  // Exactly one blank line after the fence, exactly one trailing newline —
  // parseRecord strips exactly these, so the round trip is identity even for
  // content that itself starts or ends with newlines.
  return `${lines.join('\n')}\n\n${validated.content}\n`;
}

function parseScalarValue(rawValue: string, field: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new RecordSchemaError(field, `record schema: field "${field}" is not a valid JSON-string scalar`);
  }
  return requireString(parsed, field);
}

/**
 * Parse the on-disk Markdown form back to a record. Inverse of
 * {@link serializeRecord}; throws RecordSchemaError when a required field is
 * absent or the document is not a frontmatter-bearing record.
 */
export function parseRecord(markdown: string): ProcessRecord {
  if (!markdown.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    throw new RecordSchemaError('(document)', 'record schema: document must open with a YAML frontmatter fence');
  }
  const fenceEnd = markdown.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
  if (fenceEnd === -1) {
    throw new RecordSchemaError('(document)', 'record schema: unterminated YAML frontmatter fence');
  }

  const frontmatter = markdown.slice(FRONTMATTER_FENCE.length + 1, fenceEnd);
  let body = markdown.slice(fenceEnd + FRONTMATTER_FENCE.length + 2);
  // Strip the exact framing serializeRecord adds: one leading blank line,
  // one trailing newline.
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.slice(0, -1);

  const top: Record<string, unknown> = {};
  const source: Record<string, unknown> = {};
  let inSource = false;
  for (const line of frontmatter.split('\n')) {
    if (line.trim().length === 0) continue;
    if (line === 'source:') {
      inSource = true;
      top['source'] = source;
      continue;
    }
    const indented = line.startsWith('  ');
    const target = indented && inSource ? source : top;
    if (!indented) inSource = false;
    const text = indented ? line.slice(2) : line;
    const sep = text.indexOf(': ');
    if (sep === -1) {
      throw new RecordSchemaError('(frontmatter)', `record schema: unparseable frontmatter line: ${JSON.stringify(line)}`);
    }
    const key = text.slice(0, sep);
    const fieldPath = indented && target === source ? `source.${key}` : key;
    target[key] = parseScalarValue(text.slice(sep + 2), fieldPath);
  }

  top['content'] = body;
  return validateRecord(top);
}
