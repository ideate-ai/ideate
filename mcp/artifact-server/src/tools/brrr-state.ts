import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ToolContext } from "./index.js";

// ---------------------------------------------------------------------------
// Default brrr state
// ---------------------------------------------------------------------------

interface BrrrState {
  cycles_completed: number;
  convergence_achieved: boolean;
  started_at: string | null;
  last_phase: string | null;
  last_cycle: number | null;
  deferred: boolean;
  deferred_reason: string | null;
  [key: string]: unknown;
}

function defaultBrrrState(): BrrrState {
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

function brrrStatePath(ideateDir: string): string {
  return path.join(ideateDir, "brrr-state.yaml");
}

function readBrrrState(ideateDir: string): BrrrState {
  const filePath = brrrStatePath(ideateDir);
  if (!fs.existsSync(filePath)) {
    return defaultBrrrState();
  }
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = parseYaml(raw) as Record<string, unknown>;
    return { ...defaultBrrrState(), ...parsed };
  } catch {
    return defaultBrrrState();
  }
}

function writeBrrrState(ideateDir: string, state: BrrrState): void {
  const filePath = brrrStatePath(ideateDir);
  fs.writeFileSync(filePath, stringifyYaml(state), "utf8");
}

// ---------------------------------------------------------------------------
// handleGetBrrrState — read brrr session state
// ---------------------------------------------------------------------------

export async function handleGetBrrrState(
  ctx: ToolContext,
  _args: Record<string, unknown>
): Promise<string> {
  const state = readBrrrState(ctx.ideateDir);
  return JSON.stringify(state, null, 2);
}

// ---------------------------------------------------------------------------
// handleUpdateBrrrState — update brrr session state (deep merge)
// ---------------------------------------------------------------------------

export async function handleUpdateBrrrState(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const update = args.state as Record<string, unknown> | undefined;

  if (!update || typeof update !== "object") {
    throw new Error("Missing required parameter: state (must be an object)");
  }

  const current = readBrrrState(ctx.ideateDir);

  // Shallow merge update onto current state
  const merged: BrrrState = { ...current };
  for (const [key, value] of Object.entries(update)) {
    merged[key] = value;
  }

  writeBrrrState(ctx.ideateDir, merged);

  return JSON.stringify(merged, null, 2);
}
