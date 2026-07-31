// plugin/src/steering/schema.ts — the LIGHT steering item shape and its
// Markdown-with-YAML-frontmatter serialization.
//
// Design goal: a lean, MUTABLE steering surface — domain policies, decisions,
// and guiding principles carried forward because guiding principles, domains,
// and policies are FUNDAMENTAL to ideate. It holds guiding
// principles and policies (the two canonical kinds this store ships), each
// scoped by an organizing `domain` tag, each carrying a lifecycle `status`
// (active | deprecated | superseded), an `amendment_history` trail, and typed
// FORWARD `references` edges to other items (`supersedes` primary — a
// cross-item replacement naming the item it replaces; the reverse
// `superseded_by` backlink is derived on read, never stored). It
// deliberately does NOT carry the parked v2 KG ontology (curation, decay,
// promotion, importance scoring, the 16-edge graph, PPR) — that is KG scope
// under GP-21. This is "ideas as steering text", not a knowledge graph.
//
// Serialization posture (mirrors record/schema.ts, the test-pinned form):
// - Frontmatter carries the structured fields as one JSON-encoded value per
//   line (`key: <JSON>`), a valid YAML scalar/flow value. JSON encoding makes
//   the round trip exact for any content — embedded newlines, quotes, colons,
//   even `---` lines — with ZERO YAML dependency (zero-runtime-deps posture).
//   `amendment_history` rides one line as a JSON array, parsed the same way.
// - The prose body is the current `statement` — the steering text itself.
// - `parseSteeringItem(serializeSteeringItem(x))` is identity for every valid
//   item; round-trip safety is pinned by store.test.ts.
//
// The KEY structural difference from record/schema.ts: the record is
// append-only (its store's `wx` exclusive-create enforces that at the medium),
// whereas steering is MUTABLE like the board — policies amend, GPs re-scope,
// items deprecate. So this shape carries `status` + `history`, and the store
// overwrites in place, appending prior state to `history` (never a hard
// delete — deprecate via status). The append-only guard does NOT apply here.

/** Lifecycle of a steering item. There is no hard delete — deprecate instead. */
export type SteeringStatus = 'active' | 'deprecated' | 'superseded';

export const STEERING_STATUSES: readonly SteeringStatus[] = ['active', 'deprecated', 'superseded'];

/**
 * A typed edge from this steering item to another item it references. `rel` is
 * an OPEN vocabulary — `supersedes` (the primary case: a replacement naming
 * the item it replaces), and freely `refutes` | `clarifies` | `relates-to` | …
 * `id` is the caller-chosen steering id (the filename stem) of the referenced
 * item. Backlinks — the reverse edge, e.g. `superseded_by` — are DERIVED on
 * read (store.ts's readViews), never stored: only the forward edge is
 * persisted, so the two directions can never drift. Defined locally rather
 * than reusing record/schema.ts's `RecordReference`: the shapes coincide, but
 * this store's ids are caller-chosen stems, not ULIDs — three stores, three
 * local types, one mental model.
 */
export interface SteeringReference {
  rel: string;
  id: string;
}

/**
 * One superseded prior version of a steering item, recorded on amend. The
 * `at` timestamp is the item's `updated_at` at the moment it was superseded;
 * `status` and `statement` are the prior version's, so no state is ever
 * silently lost.
 */
export interface SteeringAmendment {
  /** ISO-8601 timestamp this version was superseded (the prior `updated_at`). */
  at: string;
  /** The prior version's lifecycle status. */
  status: SteeringStatus;
  /** The prior version's steering text. */
  statement: string;
}

/**
 * One steering item — a guiding principle or a policy. `kind` is an
 * open-vocabulary string (the two canonical values this probe uses are
 * `guiding-principle` and `policy`), deliberately not a closed union so a new
 * steering shape needs no schema change.
 */
export interface SteeringItem {
  /** Stable, caller-chosen id and filename stem (e.g. `GP-23`, `POL-auth-1`). */
  id: string;
  /** Steering kind — open vocabulary: guiding-principle | policy | … */
  kind: string;
  /** Organizing scope tag policies/work-items hang off. May be empty. */
  domain: string;
  /** Lifecycle status. */
  status: SteeringStatus;
  /** ISO-8601 timestamp of the last write (from the injected clock). */
  updated_at: string;
  /**
   * The current steering text (the prose body). This schema layer PARSES
   * empty statements (a pre-existing on-disk item written before the write
   * chokepoint's empty-statement guard must still be readable — see
   * store.ts's `put`, P-41 2026-07-30), but no NEW empty statement can be
   * written: that guard lives at `put()`, not here.
   */
  statement: string;
  /** Prior versions, newest-first; empty for a freshly created item. */
  history: SteeringAmendment[];
  /**
   * Typed FORWARD edges to other steering items (open `rel` vocabulary,
   * `supersedes` primary — CROSS-item supersession, distinct from the
   * WITHIN-item lifecycle carried by `status`/`history`). Always present on a
   * read (mirrors `history`), `[]` when the item names no other item; absence
   * on disk (a file written before this field existed) parses to `[]` — the
   * legacy-file posture: a pre-references file reads as no-edges, never a raw
   * throw. The reverse edge (`superseded_by`) is DERIVED on read by the store,
   * never stored.
   */
  references: SteeringReference[];
}

/** Typed schema failure: a required field is absent or malformed. */
export class SteeringSchemaError extends Error {
  override readonly name = 'SteeringSchemaError';
  /** Dotted path of the offending field, e.g. `history[0].status`. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/**
 * Valid id / filename stem: begins alphanumeric, then alphanumerics plus
 * `._-`. This keeps the id usable directly as a filename stem — no path
 * separators, no traversal, no collision-inducing sanitization.
 */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const FRONTMATTER_FENCE = '---';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SteeringSchemaError(
      field,
      `steering schema: field "${field}" must be present as a string (empty allowed, absence is a schema error); got ${
        value === undefined ? 'absent' : typeof value
      }`,
    );
  }
  return value;
}

function requireStatus(value: unknown, field: string): SteeringStatus {
  if (typeof value !== 'string' || !STEERING_STATUSES.includes(value as SteeringStatus)) {
    throw new SteeringSchemaError(
      field,
      `steering schema: field "${field}" must be one of ${STEERING_STATUSES.join(' | ')}; got ${JSON.stringify(value)}`,
    );
  }
  return value as SteeringStatus;
}

/** True iff `value` is a well-formed steering id / filename stem. */
export function isSteeringId(value: string): boolean {
  return value.length > 0 && ID_PATTERN.test(value);
}

function requireHistory(value: unknown, field: string): SteeringAmendment[] {
  if (!Array.isArray(value)) {
    throw new SteeringSchemaError(field, `steering schema: field "${field}" must be an array`);
  }
  return value.map((entry, i): SteeringAmendment => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new SteeringSchemaError(`${field}[${String(i)}]`, `steering schema: ${field}[${String(i)}] must be an object`);
    }
    const raw = entry as Record<string, unknown>;
    return {
      at: requireString(raw['at'], `${field}[${String(i)}].at`),
      status: requireStatus(raw['status'], `${field}[${String(i)}].status`),
      statement: requireString(raw['statement'], `${field}[${String(i)}].statement`),
    };
  });
}

/**
 * Normalize the optional `references` edge list. Absent → `[]` (the common
 * case, and what an older on-disk item without the field parses to — the
 * legacy-file posture). When present it must be an array of `{rel, id}`
 * objects with NON-EMPTY strings — unlike the text fields, an empty `rel` or
 * `id` is a malformed edge, not a valid empty value. Id WELL-FORMEDNESS (a
 * filename-safe stem) and target EXISTENCE are the store's write-chokepoint
 * guards, not this layer's — mirrors record/schema.ts's validateReferences
 * split.
 */
function validateReferences(value: unknown): SteeringReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SteeringSchemaError('references', 'steering schema: field "references" must be an array of {rel, id} when present');
  }
  return value.map((item, i): SteeringReference => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new SteeringSchemaError(`references[${String(i)}]`, `steering schema: references[${String(i)}] must be an object {rel, id}`);
    }
    const ref = item as Record<string, unknown>;
    const rel = requireString(ref['rel'], `references[${String(i)}].rel`);
    const id = requireString(ref['id'], `references[${String(i)}].id`);
    if (rel.length === 0) throw new SteeringSchemaError(`references[${String(i)}].rel`, 'steering schema: references[].rel must be non-empty');
    if (id.length === 0) throw new SteeringSchemaError(`references[${String(i)}].id`, 'steering schema: references[].id must be non-empty');
    return { rel, id };
  });
}

/**
 * Validate a steering-item-shaped object: every field present and well-typed,
 * `status` a known lifecycle value, `id` a valid filename stem, `history` an
 * array of well-formed amendments. Returns the normalized item; throws
 * SteeringSchemaError on any violation.
 */
export function validateSteeringItem(input: unknown): SteeringItem {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new SteeringSchemaError('(item)', 'steering schema: a steering item must be an object');
  }
  const raw = input as Record<string, unknown>;

  const id = requireString(raw['id'], 'id');
  if (!isSteeringId(id)) {
    throw new SteeringSchemaError('id', `steering schema: id must be a filename-safe stem [A-Za-z0-9][A-Za-z0-9._-]*; got ${JSON.stringify(id)}`);
  }

  return {
    id,
    kind: requireString(raw['kind'], 'kind'),
    domain: requireString(raw['domain'], 'domain'),
    status: requireStatus(raw['status'], 'status'),
    updated_at: requireString(raw['updated_at'], 'updated_at'),
    statement: requireString(raw['statement'], 'statement'),
    history: requireHistory(raw['history'] ?? [], 'history'),
    references: validateReferences(raw['references']),
  };
}

/** One frontmatter line: `key: <JSON value>` (a valid YAML scalar/flow value). */
function jsonLine(key: string, value: unknown): string {
  return `${key}: ${JSON.stringify(value)}`;
}

/**
 * Serialize a steering item to its on-disk Markdown form: YAML frontmatter
 * carrying the structured fields (each a JSON value), then the prose body =
 * the current statement.
 */
export function serializeSteeringItem(item: SteeringItem): string {
  const v = validateSteeringItem(item);
  const lines: string[] = [
    FRONTMATTER_FENCE,
    jsonLine('id', v.id),
    jsonLine('kind', v.kind),
    jsonLine('domain', v.domain),
    jsonLine('status', v.status),
    jsonLine('updated_at', v.updated_at),
    jsonLine('history', v.history),
    jsonLine('references', v.references),
    FRONTMATTER_FENCE,
  ];
  // Exactly one blank line after the fence, exactly one trailing newline —
  // parseSteeringItem strips exactly these, so the round trip is identity even
  // for statements that themselves start or end with newlines.
  return `${lines.join('\n')}\n\n${v.statement}\n`;
}

function parseJsonValue(rawValue: string, field: string): unknown {
  try {
    return JSON.parse(rawValue);
  } catch {
    throw new SteeringSchemaError(field, `steering schema: field "${field}" is not a valid JSON value`);
  }
}

/**
 * Parse the on-disk Markdown form back to a steering item. Inverse of
 * {@link serializeSteeringItem}; throws SteeringSchemaError when a required
 * field is absent or the document is not a frontmatter-bearing item.
 */
export function parseSteeringItem(markdown: string): SteeringItem {
  if (!markdown.startsWith(`${FRONTMATTER_FENCE}\n`)) {
    throw new SteeringSchemaError('(document)', 'steering schema: document must open with a YAML frontmatter fence');
  }
  const fenceEnd = markdown.indexOf(`\n${FRONTMATTER_FENCE}\n`, FRONTMATTER_FENCE.length);
  if (fenceEnd === -1) {
    throw new SteeringSchemaError('(document)', 'steering schema: unterminated YAML frontmatter fence');
  }

  const frontmatter = markdown.slice(FRONTMATTER_FENCE.length + 1, fenceEnd);
  let body = markdown.slice(fenceEnd + FRONTMATTER_FENCE.length + 2);
  // Strip the exact framing serializeSteeringItem adds: one leading blank
  // line, one trailing newline.
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.slice(0, -1);

  const top: Record<string, unknown> = {};
  for (const line of frontmatter.split('\n')) {
    if (line.trim().length === 0) continue;
    const sep = line.indexOf(': ');
    if (sep === -1) {
      throw new SteeringSchemaError('(frontmatter)', `steering schema: unparseable frontmatter line: ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, sep);
    top[key] = parseJsonValue(line.slice(sep + 2), key);
  }

  top['statement'] = body;
  return validateSteeringItem(top);
}
