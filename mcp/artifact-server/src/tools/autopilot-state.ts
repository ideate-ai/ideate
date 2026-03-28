import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// Default autopilot state
// ---------------------------------------------------------------------------

interface AutopilotState {
  cycles_completed: number;
  convergence_achieved: boolean;
  started_at: string | null;
  last_phase: string | null;
  last_cycle: number | null;
  deferred: boolean;
  deferred_reason: string | null;
  [key: string]: unknown;
}

function defaultAutopilotState(): AutopilotState {
  return {
    cycles_completed: 0,
    convergence_achieved: false,
    started_at: null,
    last_phase: null,
    last_cycle: null,
    deferred: false,
    deferred_reason: null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function autopilotStatePath(ideateDir: string): string {
  return path.join(ideateDir, "autopilot-state.yaml");
}

function readAutopilotState(ideateDir: string): AutopilotState {
  const filePath = autopilotStatePath(ideateDir);
  if (!fs.existsSync(filePath)) {
    return defaultAutopilotState();
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    return { ...defaultAutopilotState(), ...parsed };
  } catch {
    return defaultAutopilotState();
  }
}

function writeAutopilotState(ideateDir: string, state: AutopilotState): void {
  const filePath = autopilotStatePath(ideateDir);
  fs.writeFileSync(filePath, stringifyYaml(state), "utf8");
}

// ---------------------------------------------------------------------------
// handleGetAutopilotState — read autopilot session state
// ---------------------------------------------------------------------------

export async function handleGetAutopilotState(
  ctx: ToolContext,
  _args: Record<string, unknown>
): Promise<string> {
  const state = readAutopilotState(ctx.ideateDir);
  return JSON.stringify(state, null, 2);
}

// ---------------------------------------------------------------------------
// handleUpdateAutopilotState — update autopilot session state (deep merge)
// ---------------------------------------------------------------------------

export async function handleUpdateAutopilotState(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const update = args.state as Record<string, unknown> | undefined;

  if (!update || typeof update !== "object") {
    throw new Error("Missing required parameter: state (must be an object)");
  }

  const current = readAutopilotState(ctx.ideateDir);

  // Shallow merge update onto current state
  const merged: AutopilotState = { ...current };
  for (const [key, value] of Object.entries(update)) {
    merged[key] = value;
  }

  writeAutopilotState(ctx.ideateDir, merged);

  return JSON.stringify(merged, null, 2);
}
