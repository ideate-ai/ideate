import * as path from "path";
import { ToolContext } from "./index.js";
import { createIdeateDir, CONFIG_SCHEMA_VERSION, IdeateConfigJson, IDEATE_SUBDIRS } from "../config.js";

// ---------------------------------------------------------------------------
// handleBootstrapProject — create .ideate/ directory structure
// ---------------------------------------------------------------------------

export async function handleBootstrapProject(
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

  const createdDir = createIdeateDir(projectRoot, config);

  return JSON.stringify(
    {
      created_dir: createdDir,
      subdirectories: [...IDEATE_SUBDIRS],
    },
    null,
    2
  );
}
