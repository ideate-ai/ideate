// plugin/src/work-state/priming-hook.ts — the claim-time priming hook point
// (WI-303), MECHANICALLY GATED OFF (GP-23, Dan's ruling).
//
// Claim-time priming — automatically surfacing related context the moment a
// worker claims a work item — is a FUTURE, intelligence-adjacent capability.
// Per GP-23 (nothing that shapes what a model attends to ships ahead of the
// eval harness that measures it), this file wires the SEAM today — the exact
// point in the claim path where priming will eventually run — without
// shipping any actual priming behavior. `primeOnClaim` is called from the
// `work_claim` tool path (work-state/tools.ts) immediately AFTER a
// successful claim.
//
// The gate has two parts:
//
//   (a) a config flag, `work_state.claim_priming` in `.ideate.json`, default
//       ABSENT -> false. Read DIRECTLY off the raw config JSON here rather
//       than through config/ideate-config.ts's typed `IdeateConfigV3` /
//       `loadConfig`: the typed schema now DECLARES work_state.claim_priming
//       (ideate-config.ts, coordinator rework on F-303-001) — the raw read
//       below stays deliberately, because a hook path must be
//       Reading the raw file directly also keeps this check read-only and
//       side-effect-free (it never triggers `loadConfig`'s lazy-init of
//       `.ideate.json`/the record directory) — a claim that never touches
//       priming should never provoke onboarding writes.
//
//       NO environment variable is consulted anywhere in this file — the
//       flag is config-only, grep-falsifiable: this file must contain zero
//       occurrences of the two-token "process" + "." + "env" access path
//       (priming-hook.test.ts's own grep-falsifiability check greps THIS
//       source file for that exact token pair — note that this sentence
//       itself must not spell it out literally, or the check would trip on
//       its own docs rather than on real env-var usage).
//
//   (b) when disabled (the ONLY state today, since nothing ever sets the
//       flag by default), `primeOnClaim` does NOTHING beyond incrementing
//       the `work_claims` telemetry counter — the future priming eval's
//       denominator. Every claim is one sample, whether or not priming is
//       enabled, so the increment is UNCONDITIONAL.
//
//       When enabled, the hook still emits NOTHING more than a marker: a
//       typed `PrimingHookError('NOT_IMPLEMENTED', ...)` is thrown and
//       immediately caught inside this function, logged to stderr, and
//       swallowed. The actual priming implementation is future work; a claim
//       that already succeeded must never fail because someone flipped this
//       flag on ahead of that work landing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TelemetryCounters } from '../telemetry/counters.js';
import type { ActorRef } from './types.js';
import { WorkStateModuleError } from './types.js';

/** The one failure this module ever raises — thrown and caught INTERNALLY,
 *  by `primeOnClaim` itself (see the file header); it never escapes to a
 *  caller of `primeOnClaim`. Extends `WorkStateModuleError` for consistency
 *  with the rest of work-state/'s typed-error convention even though no
 *  external `instanceof` check on it is expected to ever fire. */
export type PrimingHookErrorCode = 'NOT_IMPLEMENTED';

export class PrimingHookError extends WorkStateModuleError {
  override readonly name = 'PrimingHookError';
  override readonly code: PrimingHookErrorCode;

  constructor(code: PrimingHookErrorCode, message: string) {
    super(code, message);
    this.code = code;
  }
}

/**
 * Read the `work_state.claim_priming` flag directly off
 * `<projectRoot>/.ideate.json`. A missing file, unparseable JSON, a
 * non-object shape, an absent `work_state` block, or any `claim_priming`
 * value other than the literal `true` all resolve to `false` — this is a
 * read-only probe that never throws and never writes.
 */
export function readClaimPrimingFlag(projectRoot: string): boolean {
  const configPath = join(projectRoot, '.ideate.json');
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const workState = (parsed as Record<string, unknown>)['work_state'];
  if (workState === null || typeof workState !== 'object' || Array.isArray(workState)) return false;
  return (workState as Record<string, unknown>)['claim_priming'] === true;
}

/** Input to {@link primeOnClaim}. */
export interface PrimeOnClaimInput {
  /** The project root whose `.ideate.json` is checked for the gate flag. */
  projectRoot: string;
  /** The work item that was just claimed. */
  itemId: string;
  /** The claiming actor (unused while the gate is off; carried for the
   *  future priming implementation's own signature). */
  actor: ActorRef;
  /** The calling session, stamped onto the telemetry event. */
  sessionId: string;
  /** The telemetry sink the `work_claims` counter increments through. */
  telemetry: TelemetryCounters;
}

/**
 * The claim-time priming hook point. Call this from the `work_claim` tool
 * path AFTER a successful claim (work-state/tools.ts). See the file header
 * for the full gating contract.
 */
export function primeOnClaim(input: PrimeOnClaimInput): void {
  // The future eval's denominator: every claim is one sample, gated or not.
  input.telemetry.workClaimed(input.itemId, input.sessionId);

  if (!readClaimPrimingFlag(input.projectRoot)) return; // the only state today

  try {
    throw new PrimingHookError(
      'NOT_IMPLEMENTED',
      `work-state priming-hook: claim-time priming is enabled (work_state.claim_priming=true) for item ${input.itemId}, ` +
        'but the actual priming implementation does not exist yet — it is a future work item, gated behind the eval ' +
        'harness per GP-23. This claim already succeeded and is unaffected.',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`ideate work-state: ${message}\n`);
  }
}
