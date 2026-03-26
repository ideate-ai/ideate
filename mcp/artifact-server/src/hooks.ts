import { existsSync, readFileSync } from "fs";
import path from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

export const EVENT_PLAN_COMPLETE = "plan.complete";
export const EVENT_WORK_ITEM_STARTED = "work_item.started";
export const EVENT_WORK_ITEM_COMPLETED = "work_item.completed";
export const EVENT_REVIEW_FINDING = "review.finding";
export const EVENT_REVIEW_COMPLETE = "review.complete";
export const EVENT_CYCLE_CONVERGED = "cycle.converged";
export const EVENT_ANDON_TRIGGERED = "andon.triggered";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface HookConfig {
  event: string;
  type: "command" | "prompt";
  value: string;
  enabled: boolean;
}

export interface HooksConfig {
  hooks: HookConfig[];
}

// ---------------------------------------------------------------------------
// loadHooks
// ---------------------------------------------------------------------------

/**
 * Read and parse .ideate/hooks.json from a given ideate directory.
 * Returns {hooks:[]} if the file does not exist or cannot be parsed.
 */
export function loadHooks(ideateDir: string): HooksConfig {
  const hooksPath = path.join(ideateDir, "hooks.json");
  if (!existsSync(hooksPath)) {
    return { hooks: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(hooksPath, "utf8")) as Record<
      string,
      unknown
    >;
    const hooks = Array.isArray(raw.hooks) ? raw.hooks : [];
    // Normalize each hook — apply default for enabled
    const normalized: HookConfig[] = hooks.map((h: unknown) => {
      const hook = h as Record<string, unknown>;
      return {
        event: String(hook.event ?? ""),
        type: (hook.type === "command" || hook.type === "prompt")
          ? hook.type
          : "command",
        value: String(hook.value ?? ""),
        enabled: typeof hook.enabled === "boolean" ? hook.enabled : true,
      };
    });
    return { hooks: normalized };
  } catch {
    return { hooks: [] };
  }
}

// ---------------------------------------------------------------------------
// Variable substitution helper
// ---------------------------------------------------------------------------

function substituteVariables(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(/\$\{([^}]+)\}/g, (match, varName: string) => {
    return Object.prototype.hasOwnProperty.call(variables, varName)
      ? variables[varName]
      : match;
  });
}

// ---------------------------------------------------------------------------
// dispatchHook
// ---------------------------------------------------------------------------

/**
 * Dispatch a single hook. Returns the result (stdout for command, substituted
 * string for prompt). Returns empty string if the hook is disabled.
 */
export function dispatchHook(
  hook: HookConfig,
  variables: Record<string, string>
): string {
  if (!hook.enabled) {
    return "";
  }

  const substituted = substituteVariables(hook.value, variables);

  if (hook.type === "command") {
    const stdout = execSync(substituted, {
      timeout: 30_000,
      encoding: "utf8",
    });
    return stdout;
  }

  // type === "prompt"
  return substituted;
}

// ---------------------------------------------------------------------------
// fireEvent
// ---------------------------------------------------------------------------

/**
 * Load hooks from ideateDir, filter by eventName, and dispatch each matching
 * hook. Errors from individual hooks are caught and logged without stopping
 * the remaining hooks.
 */
export function fireEvent(
  ideateDir: string,
  eventName: string,
  variables: Record<string, string>
): void {
  const { hooks } = loadHooks(ideateDir);
  const matching = hooks.filter((h) => h.event === eventName);

  for (const hook of matching) {
    try {
      dispatchHook(hook, variables);
    } catch (err) {
      console.error(
        `[ideate:hooks] Error firing hook for event "${eventName}":`,
        err
      );
    }
  }
}
