// plugin/src/work-state/migration-signal.ts — makes a board schema
// migration DURABLE, not just loud.
//
// schema.ts's openForWrite announces every migration on stderr at the
// moment the one-way door closes (P-45: a degraded/irreversible branch
// must signal, loudly). Stderr evaporates. This module is the other half:
// the listener the composition roots (the ideate-work CLI, the MCP
// work-state tools) register so the same crossing is appended to the
// PROJECT'S OWN process record — the place a later "why does the older
// plugin refuse this board?" investigation actually looks. The conway
// incident (record 01KYXG8RA5 in this repo's store) is the case: a dev-tree
// write silently migrated a foreign project's board, and the lockout only
// surfaced later, from the older binary, with nothing pointing back at the
// moment it happened.
//
// Scope discipline: one of exactly TWO work-state modules that import the
// record store, and both are the same SHAPE — a small purpose-built bridge
// that appends one kind of board event to the process record
// (completion-record.ts: work completions; this module: schema migrations).
// That pairing is the named pattern, not drift: board events that matter to
// the process record cross via a bridge module like this one, never via the
// stores knowing each other. schema.ts itself stays record-agnostic (it
// fires a typed callback; it has no idea a record store is on the other
// end). The seam stays narrow in both directions (GP-26).

import { RecordStore } from '../record/store.js';
import type { Clock } from '../record/id.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import type { TelemetryCounters } from '../telemetry/counters.js';

import type { MigrationListener } from './schema.js';

/**
 * Build the migration listener for one composition root. Everything the
 * record append needs is captured ONCE at registration; the listener
 * itself is best-effort BY CONSTRUCTION — a record-append failure must
 * never break the write that triggered the migration (schema.ts also
 * wraps the call, so a throw here would only cost the durable copy, but
 * the append path reports its own failure on stderr rather than throwing).
 */
export function createMigrationListener(opts: {
  config: IdeateConfigV3;
  projectRoot: string;
  telemetry: TelemetryCounters;
  clock: Clock;
  /** Who is listening — `cli:ideate-work` or `mcp:work-state`; lands in
   *  the record's source.capture_point so the record says WHICH transport's
   *  write closed the door. */
  capturePoint: string;
  sessionId: string;
}): MigrationListener {
  return (info) => {
    try {
      const records = new RecordStore(opts.config, opts.projectRoot, opts.telemetry, opts.clock);
      const result = records.append({
        kind: 'board-migration',
        claim:
          `board.db migrated from schema v${String(info.fromVersion)} to v${String(info.toVersion)} by a ${opts.capturePoint} write; ` +
          `compatibility floor stamped at v${String(info.floor)} (binaries >= v${String(info.floor)} with the floor check keep working).`,
        verification_anchor: info.dbPath,
        scope: 'board-migration',
        source: { capture_point: opts.capturePoint, session_id: opts.sessionId },
        content:
          `A write through ${opts.capturePoint} found ${info.dbPath} at board schema v${String(info.fromVersion)} and migrated it ` +
          `in place to v${String(info.toVersion)} — the one-way door: there is no downgrade rung.\n\n` +
          `The writer stamped a compatibility floor of v${String(info.floor)} (PRAGMA application_id): any ideate binary at schema ` +
          `v${String(info.floor)} or newer that carries the floor check opens this board DEGRADED (anything the newer schema added ` +
          `is invisible to it) instead of refusing. Binaries older than the floor — or any binary built before the floor mechanism ` +
          `existed — hard-refuse with SCHEMA_VERSION on every work verb. If a project suddenly refuses all work verbs after this ` +
          `record appears, THIS migration is when the door closed: update the ideate plugin to the version that wrote it (or newer).\n\n` +
          `Reconciliation: record_read(scope:"board-migration") lists every migration a project has crossed, with the transport ` +
          `(source.capture_point) and time of each.`,
      });
      if (!result.ok) {
        console.error(`work-state: board-migration record refused for ${info.dbPath}: ${result.reason}`);
      }
    } catch (err) {
      console.error(
        `work-state: failed to append the board-migration record for ${info.dbPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
