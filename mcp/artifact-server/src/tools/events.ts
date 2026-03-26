import { ToolContext } from "./index.js";
import { loadHooks, dispatchHook } from "../hooks.js";

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
  const artifactDir = args.artifact_dir as string | undefined;
  const event = args.event as string | undefined;
  const rawVariables = args.variables as Record<string, unknown> | undefined;

  if (!artifactDir) {
    throw new Error("Missing required parameter: artifact_dir");
  }
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

  const { hooks } = loadHooks(ctx.ideateDir);
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
