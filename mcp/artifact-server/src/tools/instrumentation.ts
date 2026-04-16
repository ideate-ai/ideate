/**
 * instrumentation.ts — Token counting and fail-soft tool dispatch telemetry.
 *
 * Provides:
 *   countTokens(text)           — cl100k_base token count; returns 0 on encoder failure
 *   instrumentToolDispatch(...) — wraps a tool handler, records a tool_usage row;
 *                                  telemetry errors are caught and logged (fail-soft);
 *                                  handler errors propagate normally.
 */

import { getEncoding } from "js-tiktoken";
import type { ToolContext } from "../types.js";
import { insertToolUsage } from "../db-helpers.js";
import { log } from "../logger.js";

// ---------------------------------------------------------------------------
// Encoder — loaded once at module scope
// ---------------------------------------------------------------------------

let encoder: ReturnType<typeof getEncoding> | null = null;

try {
  encoder = getEncoding("cl100k_base");
} catch {
  // Encoder unavailable — countTokens will return 0
}

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------

/**
 * Count the number of cl100k_base tokens in a text string.
 * Returns 0 if the encoder is unavailable or throws.
 */
export function countTokens(text: string): number {
  if (encoder === null) return 0;
  try {
    return encoder.encode(text).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// instrumentToolDispatch
// ---------------------------------------------------------------------------

/**
 * Wrap a tool handler with fail-soft telemetry.
 *
 * - Runs the handler and captures its result (or error).
 * - If ctx.drizzleDb is present, inserts a tool_usage row with token/byte counts.
 * - Telemetry errors are caught, logged via log.warn, and never propagated.
 * - Handler errors are always re-thrown after telemetry is attempted.
 *
 * If ctx.drizzleDb is undefined (dormant/bootstrap mode), the handler still
 * runs and its result is returned; only the telemetry insert is skipped.
 */
export async function instrumentToolDispatch<T>(
  ctx: ToolContext,
  toolName: string,
  args: unknown,
  handler: () => Promise<T>
): Promise<T> {
  const requestJson = JSON.stringify(args ?? {});
  const startedAt = new Date().toISOString();
  let responseJson = "";
  let handlerError: unknown;
  let threw = false;
  let result: T | undefined;

  try {
    result = await handler();
    responseJson = JSON.stringify(result ?? {});
  } catch (e) {
    threw = true;
    handlerError = e;
    // Preserve original-error semantics even for non-Error throws (e.g. `throw null`,
    // `throw undefined`, `throw "string"`). `e instanceof Error` is the only safe
    // property access; everything else goes through String() which handles all
    // JavaScript values without producing a secondary TypeError.
    const errMsg = e instanceof Error ? e.message : String(e);
    responseJson = JSON.stringify({ error: errMsg });
  }

  if (ctx.drizzleDb) {
    try {
      insertToolUsage(ctx.drizzleDb, {
        tool_name: toolName,
        request_tokens: countTokens(requestJson),
        response_tokens: countTokens(responseJson),
        request_bytes: Buffer.byteLength(requestJson, "utf8"),
        response_bytes: Buffer.byteLength(responseJson, "utf8"),
        session_id: ctx.session_id ?? null,
        cycle: ctx.cycle ?? null,
        phase: ctx.phase ?? null,
        timestamp: startedAt,
      });
    } catch (telemetryErr) {
      log.warn("instrumentation", "tool_usage insert failed", {
        toolName,
        err: String(telemetryErr),
      });
    }
  }

  if (threw) throw handlerError;
  // `threw === false` guarantees the handler resolved, so `result` is assigned.
  return result as T;
}
