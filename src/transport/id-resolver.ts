// plugin/src/transport/id-resolver.ts — the ONE module allowed to know
// about both the process record and the delegation board, built so
// id-lint.ts's `lintFreeText` can answer "does this id name a real record OR
// a real work item" without record/store.ts or work-state/store.ts ever
// importing each other.
//
// WHY HERE, NOT INSIDE EITHER STORE (the architectural tension this item's
// spec calls out explicitly): record/store.ts and work-state/store.ts are
// deliberately separate, thin seams — "wider coupling = monolith regrowth"
// is a standing position here (payload-budget.ts's own header makes the same
// argument for the payload budget). A resolver that needs BOTH stores cannot
// live inside either without creating exactly that hard cross-seam import.
// It lives here instead, in transport/ — the established neutral home this
// repo already uses for cross-seam policy (payload-budget.ts, keyset-page.ts)
// — and is INJECTED into each store's constructor as an opaque
// `(id) => IdResolution` callback (id-lint.ts's `IdResolver`). Each store
// stays exactly as ignorant of the other as it was before this item: it never
// imports this module, never imports the sibling store, and never learns
// what a "record" or a "work item" even is — it just calls the function it
// was handed.
//
// REJECTED ALTERNATIVE: wiring the resolver through the MCP `ToolContext`
// only. Considered (the spec's own suggested seam) but not taken as-is,
// because record/tools.ts's and work-state/tools.ts's `ToolContext`s are
// each already lazily built with ONLY their own store — merging them would
// itself be a new cross-seam coupling at the transport layer, and it would
// leave the CLI (a SEPARATE composition root — cli/ideate-record.ts and
// cli/ideate-work.ts are two different binaries) without an obvious place to
// get the same wiring, which is exactly what P-50 requires it to have. This
// module is called identically from FIVE composition roots — record/tools.ts,
// work-state/tools.ts, cli/ideate-record.ts, cli/ideate-work.ts, and
// work-state/completion-record.ts's real writer — each of which already
// resolves a `projectRoot` and is the correct place to decide what
// capabilities that project's write path has.
//
// O(1) BY CONSTRUCTION: resolving a record id is `RecordStore.hasRecord`, a
// single `existsSync` on the shard path computed from the id's own embedded
// timestamp (record/store.ts) — never a directory walk. Resolving a board id
// is `WorkStateStore.getItem`, a single SQLite primary-key lookup that never
// creates the database file if it does not yet exist (work-state/store.ts).
// Both stores are cheap to CONSTRUCT (their own headers document this:
// `RecordStore`'s constructor touches no filesystem; `WorkStateStore` opens
// and closes a connection per call), so building one extra instance of each
// purely for resolution — rather than threading the transport's own
// already-live instance through several layers of call signatures — is the
// same trade completion-record.ts already makes for its own writer.
//
// P-45 (fail loud, never silently downgrade): the board lookup is the one
// half of this resolver that can genuinely fail at runtime (a locked/corrupt
// SQLite file under contention) — `composeIdResolver` catches exactly that
// and reports `'unknown'` PLUS a loud, distinct process warning, rather than
// either silently treating the id as resolved (hides a real dangling
// reference) or silently treating it as unresolved (cries wolf on an outage
// that has nothing to do with the cited id). The record half cannot
// meaningfully fail this way (`existsSync` never throws for an ordinary bad
// path), so it is not wrapped — see composeIdResolver's own comment.

import { join } from 'node:path';

import { loadConfig, workStatePath } from '../config/ideate-config.js';
import type { Clock } from '../record/id.js';
import { RecordStore } from '../record/store.js';
import type { TelemetryCounters } from '../telemetry/counters.js';
import type { IdResolution, IdResolver } from './id-lint.js';
import { WorkStateStore } from '../work-state/store.js';

/** The minimal record-side capability this module needs — real signature is
 *  `RecordStore.hasRecord`, narrowed here so a test fixture can supply a stub
 *  without constructing a real store. */
export type RecordExistenceCheck = Pick<RecordStore, 'hasRecord'>;

/** The minimal board-side capability this module needs — real signature is
 *  `WorkStateStore.getItem`, narrowed for the same reason. */
export type BoardExistenceCheck = Pick<WorkStateStore, 'getItem'>;

/**
 * Compose the cross-store resolver from two already-constructed store
 * handles. Checks the record store FIRST (a cheap `existsSync`, no SQLite
 * connection) before the board (see this file's header for why only the
 * board half is wrapped in a try/catch).
 */
export function composeIdResolver(record: RecordExistenceCheck, board: BoardExistenceCheck): IdResolver {
  return (id: string): IdResolution => {
    if (record.hasRecord(id)) return 'resolved';
    try {
      if (board.getItem(id) !== null) return 'resolved';
    } catch (err) {
      process.emitWarning(
        `ideate id-lint: board lookup failed while resolving ${id} — reporting 'unknown', not 'resolved' or 'unresolved' (${err instanceof Error ? err.message : String(err)})`,
        { code: 'IDEATE_ID_LINT_RESOLVER_UNAVAILABLE' },
      );
      return 'unknown';
    }
    return 'unresolved';
  };
}

/**
 * Build the real cross-store resolver for one project, from a `projectRoot`
 * alone — every composition root (both MCP registrars, both CLIs, the
 * completion-record writer) already has exactly this much. `dbPath`, when
 * supplied, overrides the computed board database path (mirrors
 * work-state/tools.ts's own `dbPath` test override) — absent, it is derived
 * the same way every other production caller derives it
 * (`workStatePath(config, projectRoot)/board.db`).
 */
export function createProjectIdResolver(
  projectRoot: string,
  telemetry: TelemetryCounters,
  clock: Clock,
  dbPath?: string,
): IdResolver {
  const config = loadConfig(projectRoot);
  const record = new RecordStore(config, projectRoot, telemetry, clock);
  const board = new WorkStateStore(dbPath ?? join(workStatePath(config, projectRoot), 'board.db'), clock);
  return composeIdResolver(record, board);
}
