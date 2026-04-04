import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

export const CONFIG_SCHEMA_VERSION = 4;

/**
 * Schema for .ideate/config.json
 */
export type SpawnMode = "subagent" | "teammate";

export type BackendType = "local" | "remote";

export interface IdeateConfigJson {
  schema_version: number;
  project_name?: string;
  agent_budgets?: Record<string, number>;
  model_overrides?: Record<string, string>;
  circuit_breaker_threshold?: number;
  default_appetite?: number;
  spawn_mode?: SpawnMode;
  ppr?: {
    alpha?: number;
    max_iterations?: number;
    convergence_threshold?: number;
    edge_type_weights?: Record<string, number>;
    default_token_budget?: number;
  };
  /** Storage backend selection. Default: "local". */
  backend?: BackendType;
  /** Remote backend configuration. Required when backend is "remote". */
  remote?: {
    /** GraphQL endpoint URL for the ideate-server. */
    endpoint: string;
    /** Organization ID for multi-tenant isolation. */
    org_id: string;
    /** Codebase ID within the organization. */
    codebase_id: string;
    /** Auth fields reserved for future use. */
    auth_token?: string | null;
  };
}

/**
 * Default circuit_breaker_threshold used when the field is absent from config.json.
 */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;

/**
 * Default default_appetite used when the field is absent from config.json.
 */
export const DEFAULT_APPETITE = 6;

/**
 * Default spawn_mode used when the field is absent from config.json.
 * "subagent" = standard Agent tool spawning; "teammate" = agent teams mode.
 */
export const DEFAULT_SPAWN_MODE: SpawnMode = "subagent";

/**
 * Default backend used when the field is absent from config.json.
 */
export const DEFAULT_BACKEND: BackendType = "local";

/**
 * Default agent_budgets used when the field is absent from config.json.
 */
export const DEFAULT_AGENT_BUDGETS: Record<string, number> = {
  "code-reviewer": 80,
  "spec-reviewer": 100,
  "gap-analyst": 100,
  "journal-keeper": 60,
  "domain-curator": 100,
  decomposer: 100,
  architect: 160,
  researcher: 80,
  "proxy-human": 160,
};

/**
 * Default PPR configuration used when the field is absent from config.json.
 */
export const DEFAULT_PPR_CONFIG = {
  alpha: 0.15,
  max_iterations: 50,
  convergence_threshold: 1e-6,
  edge_type_weights: {
    depends_on: 1.0,
    governed_by: 0.8,
    informed_by: 0.6,
    references: 0.4,
    blocks: 0.3,
  },
  default_token_budget: 50000,
};

/**
 * Resolved config used internally.
 */
export interface IdeateConfig {
  artifactDir: string;
}

/**
 * Subdirectories created inside .ideate/ by createIdeateDir().
 */
export const IDEATE_SUBDIRS = [
  "plan",
  "steering",
  "work-items",
  "principles",
  "constraints",
  "policies",
  "decisions",
  "questions",
  "modules",
  "research",
  "interviews",
  "cycles",
  "domains",
  "metrics",
  "projects",
  "phases",
] as const;

/**
 * Read and parse .ideate/config.json from a given directory.
 * Returns null if the directory doesn't contain a valid .ideate/config.json.
 */
export function readIdeateConfig(dir: string): IdeateConfig | null {
  const configPath = path.join(dir, ".ideate", "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    if (typeof raw.schema_version !== "number") return null;
    // .ideate/ directory IS the artifact dir
    return { artifactDir: path.join(dir, ".ideate") };
  } catch (err) {
    const ts = new Date().toISOString();
    console.warn(`[${ts}] Warning: config.json exists at ${configPath} but failed to parse: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Walk up the directory tree from startDir looking for .ideate/config.json.
 * Returns the resolved absolute path to the .ideate/ directory, or null if not found.
 */
export function findIdeateConfig(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    const config = readIdeateConfig(dir);
    if (config) {
      return config.artifactDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

/**
 * Resolve artifact_dir from tool arguments, falling back to .ideate/config.json discovery.
 * Throws if neither is available.
 */
export function resolveArtifactDir(
  args: Record<string, unknown>,
  cwd: string = process.cwd()
): string {
  if (typeof args.artifact_dir === "string" && args.artifact_dir.trim() !== "") {
    return path.resolve(args.artifact_dir.trim());
  }
  const found = findIdeateConfig(cwd);
  if (found) return found;
  throw new Error(
    'Required argument "artifact_dir" must be provided, or a .ideate/config.json file must exist in the project directory.'
  );
}

/**
 * Create the .ideate/ directory structure at the given path.
 * Creates all subdirectories but only writes config.json — no other files.
 *
 * @param dirPath - Parent directory where .ideate/ will be created
 * @param config  - Config to write into config.json
 * @returns The absolute path to the created .ideate/ directory
 */
export function createIdeateDir(
  dirPath: string,
  config: IdeateConfigJson = { schema_version: CONFIG_SCHEMA_VERSION }
): string {
  const ideateDir = path.resolve(dirPath, ".ideate");
  mkdirSync(ideateDir, { recursive: true });

  for (const sub of IDEATE_SUBDIRS) {
    mkdirSync(path.join(ideateDir, sub), { recursive: true });
  }

  writeConfig(ideateDir, config);
  return ideateDir;
}

/**
 * Write config.json into the given .ideate/ directory.
 *
 * @param ideateDir - Path to the .ideate/ directory
 * @param config    - Config object to write
 */
export function writeConfig(
  ideateDir: string,
  config: IdeateConfigJson
): void {
  const configPath = path.join(ideateDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

/**
 * Read config.json from the given .ideate/ directory as-is, without applying
 * any defaults. Returns only the fields actually stored in the file.
 *
 * @param ideateDir - Path to the .ideate/ directory
 * @returns Raw stored config, or minimal default if file is missing/invalid
 */
export function readRawConfig(ideateDir: string): IdeateConfigJson {
  const configPath = path.join(ideateDir, "config.json");
  if (!existsSync(configPath)) {
    return { schema_version: CONFIG_SCHEMA_VERSION };
  }
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as IdeateConfigJson;
  } catch (err) {
    const ts = new Date().toISOString();
    console.warn(`[${ts}] Warning: config.json exists at ${configPath} but failed to parse: ${(err as Error).message}`);
    return { schema_version: CONFIG_SCHEMA_VERSION };
  }
}

/**
 * Read config.json from the given .ideate/ directory and deep-merge with
 * defaults for any missing optional fields (agent_budgets, ppr, backend).
 *
 * @param ideateDir - Path to the .ideate/ directory
 * @returns Config object with defaults applied for missing fields
 */
export function getConfigWithDefaults(ideateDir: string): Required<
  Pick<IdeateConfigJson, "schema_version" | "agent_budgets" | "model_overrides" | "ppr" | "circuit_breaker_threshold" | "default_appetite" | "spawn_mode" | "backend">
> &
  Omit<IdeateConfigJson, "agent_budgets" | "model_overrides" | "ppr" | "circuit_breaker_threshold" | "default_appetite" | "spawn_mode" | "backend"> {
  const configPath = path.join(ideateDir, "config.json");
  let raw: IdeateConfigJson = { schema_version: CONFIG_SCHEMA_VERSION };

  if (existsSync(configPath)) {
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8")) as IdeateConfigJson;
    } catch {
      // fallback to defaults if parsing fails
    }
  }

  const agent_budgets: Record<string, number> = {
    ...DEFAULT_AGENT_BUDGETS,
    ...(raw.agent_budgets ?? {}),
  };

  const rawPpr = raw.ppr ?? {};
  const ppr = {
    alpha: rawPpr.alpha ?? DEFAULT_PPR_CONFIG.alpha,
    max_iterations: rawPpr.max_iterations ?? DEFAULT_PPR_CONFIG.max_iterations,
    convergence_threshold:
      rawPpr.convergence_threshold ?? DEFAULT_PPR_CONFIG.convergence_threshold,
    edge_type_weights: {
      ...DEFAULT_PPR_CONFIG.edge_type_weights,
      ...(rawPpr.edge_type_weights ?? {}),
    },
    default_token_budget:
      rawPpr.default_token_budget ?? DEFAULT_PPR_CONFIG.default_token_budget,
  };

  const model_overrides: Record<string, string> = {
    ...(raw.model_overrides ?? {}),
  };

  const circuit_breaker_threshold =
    raw.circuit_breaker_threshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;

  const default_appetite = raw.default_appetite ?? DEFAULT_APPETITE;
  const spawn_mode = raw.spawn_mode ?? DEFAULT_SPAWN_MODE;
  const backend = raw.backend ?? DEFAULT_BACKEND;

  return {
    ...raw,
    agent_budgets,
    model_overrides,
    ppr,
    circuit_breaker_threshold,
    default_appetite,
    spawn_mode,
    backend,
  };
}
