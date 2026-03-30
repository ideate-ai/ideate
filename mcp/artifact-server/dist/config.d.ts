export declare const CONFIG_SCHEMA_VERSION = 3;
/**
 * Schema for .ideate/config.json
 */
export interface IdeateConfigJson {
    schema_version: number;
    project_name?: string;
    agent_budgets?: Record<string, number>;
    model_overrides?: Record<string, string>;
    circuit_breaker_threshold?: number;
    default_appetite?: number;
    ppr?: {
        alpha?: number;
        max_iterations?: number;
        convergence_threshold?: number;
        edge_type_weights?: Record<string, number>;
        default_token_budget?: number;
    };
}
/**
 * Default circuit_breaker_threshold used when the field is absent from config.json.
 */
export declare const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
/**
 * Default default_appetite used when the field is absent from config.json.
 */
export declare const DEFAULT_APPETITE = 6;
/**
 * Default agent_budgets used when the field is absent from config.json.
 */
export declare const DEFAULT_AGENT_BUDGETS: Record<string, number>;
/**
 * Default PPR configuration used when the field is absent from config.json.
 */
export declare const DEFAULT_PPR_CONFIG: {
    alpha: number;
    max_iterations: number;
    convergence_threshold: number;
    edge_type_weights: {
        depends_on: number;
        governed_by: number;
        informed_by: number;
        references: number;
        blocks: number;
    };
    default_token_budget: number;
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
export declare const IDEATE_SUBDIRS: readonly ["plan", "steering", "work-items", "principles", "constraints", "policies", "decisions", "questions", "modules", "research", "interviews", "cycles", "domains", "metrics", "projects", "phases"];
/**
 * Read and parse .ideate/config.json from a given directory.
 * Returns null if the directory doesn't contain a valid .ideate/config.json.
 */
export declare function readIdeateConfig(dir: string): IdeateConfig | null;
/**
 * Walk up the directory tree from startDir looking for .ideate/config.json.
 * Returns the resolved absolute path to the .ideate/ directory, or null if not found.
 */
export declare function findIdeateConfig(startDir: string): string | null;
/**
 * Resolve artifact_dir from tool arguments, falling back to .ideate/config.json discovery.
 * Throws if neither is available.
 */
export declare function resolveArtifactDir(args: Record<string, unknown>, cwd?: string): string;
/**
 * Create the .ideate/ directory structure at the given path.
 * Creates all subdirectories but only writes config.json — no other files.
 *
 * @param dirPath - Parent directory where .ideate/ will be created
 * @param config  - Config to write into config.json
 * @returns The absolute path to the created .ideate/ directory
 */
export declare function createIdeateDir(dirPath: string, config?: IdeateConfigJson): string;
/**
 * Write config.json into the given .ideate/ directory.
 *
 * @param ideateDir - Path to the .ideate/ directory
 * @param config    - Config object to write
 */
export declare function writeConfig(ideateDir: string, config: IdeateConfigJson): void;
/**
 * Read config.json from the given .ideate/ directory as-is, without applying
 * any defaults. Returns only the fields actually stored in the file.
 *
 * @param ideateDir - Path to the .ideate/ directory
 * @returns Raw stored config, or minimal default if file is missing/invalid
 */
export declare function readRawConfig(ideateDir: string): IdeateConfigJson;
/**
 * Read config.json from the given .ideate/ directory and deep-merge with
 * defaults for any missing optional fields (agent_budgets, ppr).
 *
 * @param ideateDir - Path to the .ideate/ directory
 * @returns Config object with defaults applied for missing fields
 */
export declare function getConfigWithDefaults(ideateDir: string): Required<Pick<IdeateConfigJson, "schema_version" | "agent_budgets" | "model_overrides" | "ppr" | "circuit_breaker_threshold" | "default_appetite">> & Omit<IdeateConfigJson, "agent_budgets" | "model_overrides" | "ppr" | "circuit_breaker_threshold" | "default_appetite">;
//# sourceMappingURL=config.d.ts.map