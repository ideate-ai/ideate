import * as fs from "fs";
import * as path from "path";
import type { ToolContext } from "../types.js";
import { loadHooks, dispatchHook, type HooksConfig } from "../hooks.js";

// ---------------------------------------------------------------------------
// Hooks cache — avoids re-reading and re-parsing hooks file on every event
// ---------------------------------------------------------------------------

let cachedHooks: HooksConfig | null = null;
let cachedHooksMtimeMs: number | null = null;
let cachedHooksDir: string | null = null;

function getCachedHooks(ideateDir: string): HooksConfig {
  const hooksFile = path.join(ideateDir, "hooks.json");
  try {
    const stat = fs.statSync(hooksFile);
    if (cachedHooksDir === ideateDir && cachedHooksMtimeMs === stat.mtimeMs && cachedHooks) {
      return cachedHooks;
    }
    cachedHooks = loadHooks(ideateDir);
    cachedHooksMtimeMs = stat.mtimeMs;
    cachedHooksDir = ideateDir;
    return cachedHooks;
  } catch {
    // File doesn't exist or can't be read — load fresh (returns empty hooks)
    if (cachedHooksDir !== ideateDir) {
      cachedHooks = loadHooks(ideateDir);
      cachedHooksDir = ideateDir;
      cachedHooksMtimeMs = null;
    }
    return cachedHooks!;
  }
}

// ---------------------------------------------------------------------------
// handleEmitEvent
// ---------------------------------------------------------------------------

/**
 * Fires all hooks matching the given event name and returns a JSON summary
 * with the event name, number of hooks matched, number successfully executed,
 * and any per-hook errors.
 */
export async function handleEmitEvent(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  // artifact_dir is now always ctx.ideateDir — resolved at server startup
  const event = args.event as string | undefined;
  const rawVariables = args.variables as Record<string, unknown> | undefined;

  if (!event) {
    throw new Error("Missing required parameter: event");
  }

  // Coerce variables values to strings
  const variables: Record<string, string> = {};
  if (rawVariables && typeof rawVariables === "object") {
    for (const [key, value] of Object.entries(rawVariables)) {
      variables[key] = String(value);
    }
  }

  const { hooks } = getCachedHooks(ctx.ideateDir);
  const matching = hooks.filter((h) => h.event === event && h.enabled);

  let executed = 0;
  const errors: string[] = [];

  for (const hook of matching) {
    try {
      dispatchHook(hook, variables);
      executed++;
    } catch (err) {
      errors.push(
        `Hook "${hook.value}" (${hook.type}) failed: ${(err as Error).message}`
      );
    }
  }

  const summary = {
    event,
    hooks_matched: matching.length,
    hooks_executed: executed,
    errors,
  };

  return JSON.stringify(summary, null, 2);
}
