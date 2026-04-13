import { existsSync, readFileSync } from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { log } from "./logger.js";

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
// Command allowlist
// ---------------------------------------------------------------------------

/** Commands permitted for hook execution. Any command not in this set is rejected. */
const ALLOWLISTED_COMMANDS = new Set([
  "git",
  "node",
  "npm",
  "npx",
  "echo",
  "cat",
  "ls",
]);

/**
 * Validate that a command is in the allowlist.
 * Returns the command if allowed, null otherwise.
 */
function validateCommand(command: string): string | null {
  // Strip path prefix if present (e.g., /usr/bin/git -> git)
  const baseCommand = command.replace(/^.*[/\\]/, "");
  return ALLOWLISTED_COMMANDS.has(baseCommand) ? baseCommand : null;
}

// ---------------------------------------------------------------------------
// Command parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse a command string into command and arguments array.
 * Handles quoted strings (both single and double quotes).
 * This parsing avoids shell interpretation entirely.
 */
function parseCommand(commandStr: string): { command: string; args: string[] } | null {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let i = 0;

  while (i < commandStr.length) {
    const char = commandStr[i];

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        current += char;
      }
    } else if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
      } else if (char === "\\" && i + 1 < commandStr.length) {
        // Handle escape sequences in double quotes
        i++;
        current += commandStr[i];
      } else {
        current += char;
      }
    } else if (char === "'") {
      inSingleQuote = true;
    } else if (char === '"') {
      inDoubleQuote = true;
    } else if (char === "\\" && i + 1 < commandStr.length) {
      // Handle escape outside quotes
      i++;
      current += commandStr[i];
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
    i++;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  if (tokens.length === 0) {
    return null;
  }

  return {
    command: tokens[0],
    args: tokens.slice(1),
  };
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

  if (hook.type === "prompt") {
    // For prompt type, variable substitution is safe (no shell execution)
    return substituteVariables(hook.value, variables);
  }

  // type === "command"
  // Parse the command into command + args BEFORE substitution to prevent injection
  const parsed = parseCommand(hook.value);
  if (!parsed) {
    return "";
  }

  // Validate command against allowlist
  const allowedCommand = validateCommand(parsed.command);
  if (!allowedCommand) {
    log.warn(
      "hooks",
      `Hook rejected: command "${parsed.command}" is not in allowlist. ` +
      `Allowed commands: ${Array.from(ALLOWLISTED_COMMANDS).join(", ")}`
    );
    throw new Error(
      `Command "${parsed.command}" is not allowlisted for hook execution`
    );
  }

  // Apply variable substitution to each argument separately
  // This ensures variables cannot inject shell metacharacters
  const substitutedArgs = parsed.args.map(arg => substituteVariables(arg, variables));

  // Use spawnSync with explicit argument array - no shell interpretation
  // Use the validated command name (without path) for security
  const result = spawnSync(allowedCommand, substitutedArgs, {
    timeout: 30_000,
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const errMsg = result.stderr?.trim() || `Command exited with status ${result.status}`;
    throw new Error(errMsg);
  }

  return result.stdout ?? "";
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
      log.error("hooks", `Error firing hook for event "${eventName}"`, err);
    }
  }
}
