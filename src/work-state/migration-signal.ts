// plugin/src/work-state/migration-signal.ts — makes a board schema
// CROSSING durable, not just loud. Two crossings, both bridged from here:
//
// - A WRITE-MIGRATION (createMigrationListener): a newer binary migrates an
//   older board forward, in place, on a write. One-way door, fires once per
//   crossing.
// - A DEGRADED OPEN (createDegradedOpenListener): the mirror image — an
//   OLDER binary opens a NEWER, floor-accepted board and runs with a
//   partial view (anything the newer schema added is invisible to it).
//   Recurs on every open this binary makes against that board, for as long
//   as it keeps running against it — but the durable record fires once per
//   distinct CONDITION (board path + board version + floor), not once per
//   open (P-45's DURABILITY IS PER CONDITION amendment; a degraded open is
//   the steady state, not a rare crossing, so per-call durability grows the
//   process record unboundedly for no new information). The per-call
//   occurrence count is carried by the `board_degraded_opens` telemetry
//   counter instead.
//
// schema.ts's openForWrite/openForRead announce BOTH crossings on stderr at
// the moment they happen (P-45: a degraded/irreversible branch must signal,
// loudly). Stderr evaporates. This module is the other half for both: the
// listeners the composition roots (the ideate-work CLI, the MCP work-state
// tools) register so the same crossing is appended to the PROJECT'S OWN
// process record — the place a later "why does the older plugin refuse
// this board?" (or "why did the older plugin never see X?") investigation
// actually looks. The conway incident (record 01KYXG8RA5 in this repo's
// store) is the write-migration case: a dev-tree write silently migrated a
// foreign project's board, and the lockout only surfaced later, from the
// older binary, with nothing pointing back at the moment it happened. An
// older binary silently operating against a newer board IS the same gap —
// "nothing points back at the moment it happened" — so it gets the same
// treatment, through this same bridge, not a second one.
//
// Scope discipline: one of exactly TWO work-state modules that import the
// record store, and both are the same SHAPE — a small purpose-built bridge
// that appends board events to the process record (completion-record.ts:
// work completions; this module: schema migrations AND degraded opens —
// still one bridge, two listener factories, because both are board-schema
// crossings schema.ts already reports through the same callback
// mechanism). That pairing is the named pattern, not drift: board events
// that matter to the process record cross via a bridge module like this
// one, never via the stores knowing each other. schema.ts itself stays
// record-agnostic (it fires typed callbacks; it has no idea a record store
// is on the other end). The seam stays narrow in both directions (GP-26).

import { RecordStore } from '../record/store.js';
import type { Clock } from '../record/id.js';
import type { IdeateConfigV3 } from '../config/ideate-config.js';
import type { TelemetryCounters } from '../telemetry/counters.js';

import type { DegradedOpenListener, MigrationListener } from './schema.js';

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

/**
 * Build the degraded-open listener for one composition root — the mirror
 * image of {@link createMigrationListener}, registered the same way
 * (composition root captures its own config/telemetry/clock/capturePoint
 * ONCE, at startup) but firing on a different schema.ts callback
 * ({@link setDegradedOpenListener} instead of {@link setMigrationListener}).
 *
 * schema.ts still calls this listener on EVERY degraded-accepting open —
 * that plumbing is unchanged, and it has to stay that way, because two
 * different things depend on seeing every occurrence:
 *
 * - The telemetry counter (`TelemetryCounters.boardDegradedOpen`) increments
 *   unconditionally, on every call — it is the occurrence tally.
 * - The durable `board-degraded-open` process record, per the AMENDED P-45
 *   (governing decision 01KZCPXJK1WX9BK51W8BQX4DFK): durability is per
 *   CONDITION, not per call. The record appends on the FIRST observation of
 *   a distinct (dbPath, boardVersion, floor) tuple in this process, and
 *   re-fires only when that tuple changes — a long-lived server could later
 *   observe a different board, or the same board again after it is migrated
 *   further, and either must produce a fresh record. `recordedConditions`
 *   below is that cache: closure-scoped to THIS listener instance (one per
 *   composition root, registered once at startup), so it lives exactly as
 *   long as the process the listener is registered in.
 *
 * (Previously this record fired on every call, unconditionally — see the
 * P-45 history entries in `.ideate/steering/P-45.md` for why that was wrong:
 * a degraded open is not rare, it is the steady state, and it fans out
 * per-open rather than per-verb, so the old rule appended unbounded,
 * near-identical records on ordinary read paths.)
 *
 * Best-effort by construction — same posture as {@link createMigrationListener}:
 * a record-append failure must never turn a successful (if degraded) open
 * into a failed one. A failed append still marks the condition as observed
 * (it does not retry on every subsequent identical call) — the same
 * "first observation, not first SUCCESSFUL observation" rule the durable
 * record follows everywhere else in this module.
 */
export function createDegradedOpenListener(opts: {
  config: IdeateConfigV3;
  projectRoot: string;
  telemetry: TelemetryCounters;
  clock: Clock;
  /** Who is listening — `cli:ideate-work` or `mcp:work-state`; lands in
   *  the record's source.capture_point so the record says WHICH transport's
   *  open ran degraded. */
  capturePoint: string;
  sessionId: string;
}): DegradedOpenListener {
  const recordedConditions = new Set<string>();

  return (info) => {
    // Counter 8 — every occurrence, including the ones the durable record
    // below suppresses as a repeat of an already-recorded condition.
    opts.telemetry.boardDegradedOpen(info.dbPath, info.boardVersion, info.floor, opts.sessionId);

    const conditionKey = `${info.dbPath} ${String(info.boardVersion)} ${String(info.floor)}`;
    if (recordedConditions.has(conditionKey)) return;
    recordedConditions.add(conditionKey);

    try {
      const records = new RecordStore(opts.config, opts.projectRoot, opts.telemetry, opts.clock);
      const result = records.append({
        kind: 'board-degraded-open',
        claim:
          `board.db opened DEGRADED by a ${opts.capturePoint} read/write: this binary understands schema v${String(info.binaryVersion)} ` +
          `but the board is stamped v${String(info.boardVersion)} (compatibility floor v${String(info.floor)}); ` +
          'anything the newer schema added is invisible to this open.',
        verification_anchor: info.dbPath,
        scope: 'board-degraded-open',
        source: { capture_point: opts.capturePoint, session_id: opts.sessionId },
        content:
          `A ${opts.capturePoint} open of ${info.dbPath} found the board stamped at schema v${String(info.boardVersion)}, newer than ` +
          `this binary's own v${String(info.binaryVersion)}. The board's writer stamped a compatibility floor of ` +
          `v${String(info.floor)} (PRAGMA application_id) — this binary is at or above that floor, so it opened anyway instead of ` +
          `refusing with SCHEMA_VERSION, but it ran DEGRADED: whatever the newer schema added between v${String(info.binaryVersion)} ` +
          `and v${String(info.boardVersion)} is invisible to this open (e.g. v3's "references" forward edges are invisible to a v2 ` +
          `binary — a superseded item and its replacement both look live to it).\n\n` +
          `This record appends once per distinct condition (this board path at this board version and floor) per process, not once ` +
          `per open — the versions and the floor are fixed for the life of the process, so a later identical occurrence carries no ` +
          `new information. A changed board version or floor (or a different board entirely) appends a fresh record. The console ` +
          `warning schema.ts emits is deduplicated the same way (once per process); the occurrence COUNT beyond the first is carried ` +
          `by the \`board_degraded_opens\` telemetry counter, not by additional records here.\n\n` +
          `Fix: update the ideate plugin at this capture point to v${String(info.boardVersion)} or newer to see the full board.\n\n` +
          `Reconciliation: record_read(scope:"board-degraded-open") lists every distinct degraded-open condition a project has ` +
          `crossed, with the transport (source.capture_point) and time of each; ideate-telemetry reports the occurrence counts.`,
      });
      if (!result.ok) {
        console.error(`work-state: board-degraded-open record refused for ${info.dbPath}: ${result.reason}`);
      }
    } catch (err) {
      console.error(
        `work-state: failed to append the board-degraded-open record for ${info.dbPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
}
