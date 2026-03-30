import * as path from "path";
import type { ToolContext } from "../types.js";
import { createIdeateDir, CONFIG_SCHEMA_VERSION, IdeateConfigJson, IDEATE_SUBDIRS } from "../config.js";

// ---------------------------------------------------------------------------
// handleBootstrapWorkspace — create .ideate/ directory structure
// ---------------------------------------------------------------------------

export async function handleBootstrapWorkspace(
  ctx: ToolContext,
  args: Record<string, unknown>
): Promise<string> {
  const projectName = args.project_name as string | undefined;

  // Derive the project root from the ideateDir (strip trailing .ideate)
  const projectRoot = path.dirname(ctx.ideateDir);

  const config: IdeateConfigJson = {
    schema_version: CONFIG_SCHEMA_VERSION,
  };
  if (projectName) {
    config.project_name = projectName;
  }

  createIdeateDir(projectRoot, config);

  return JSON.stringify(
    {
      status: "initialized",
      subdirectories: [...IDEATE_SUBDIRS],
    },
    null,
    2
  );
}
