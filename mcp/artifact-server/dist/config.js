import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
export const CONFIG_SCHEMA_VERSION = 2;
/**
 * Default agent_budgets used when the field is absent from config.json.
 */
export const DEFAULT_AGENT_BUDGETS = {
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
 * Subdirectories created inside .ideate/ by createIdeateDir().
 */
const IDEATE_SUBDIRS = [
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
];
/**
 * Read and parse .ideate/config.json from a given directory.
 * Returns null if the directory doesn't contain a valid .ideate/config.json.
 */
export function readIdeateConfig(dir) {
    const configPath = path.join(dir, ".ideate", "config.json");
    if (!existsSync(configPath))
        return null;
    try {
        const raw = JSON.parse(readFileSync(configPath, "utf8"));
        if (typeof raw.schema_version !== "number")
            return null;
        // .ideate/ directory IS the artifact dir
        return { artifactDir: path.join(dir, ".ideate") };
    }
    catch {
        return null;
    }
}
/**
 * Walk up the directory tree from startDir looking for .ideate/config.json.
 * Returns the resolved absolute path to the .ideate/ directory, or null if not found.
 */
export function findIdeateConfig(startDir) {
    let dir = path.resolve(startDir);
    while (true) {
        const config = readIdeateConfig(dir);
        if (config) {
            return config.artifactDir;
        }
        const parent = path.dirname(dir);
        if (parent === dir)
            return null; // filesystem root
        dir = parent;
    }
}
/**
 * Resolve artifact_dir from tool arguments, falling back to .ideate/config.json discovery.
 * Throws if neither is available.
 */
export function resolveArtifactDir(args, cwd = process.cwd()) {
    if (typeof args.artifact_dir === "string" && args.artifact_dir.trim() !== "") {
        return path.resolve(args.artifact_dir.trim());
    }
    const found = findIdeateConfig(cwd);
    if (found)
        return found;
    throw new Error('Required argument "artifact_dir" must be provided, or a .ideate/config.json file must exist in the project directory.');
}
/**
 * Create the .ideate/ directory structure at the given path.
 * Creates all subdirectories but only writes config.json — no other files.
 *
 * @param dirPath - Parent directory where .ideate/ will be created
 * @param config  - Config to write into config.json
 * @returns The absolute path to the created .ideate/ directory
 */
export function createIdeateDir(dirPath, config = { schema_version: CONFIG_SCHEMA_VERSION }) {
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
export function writeConfig(ideateDir, config) {
    const configPath = path.join(ideateDir, "config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}
/**
 * Read config.json from the given .ideate/ directory and deep-merge with
 * defaults for any missing optional fields (agent_budgets, ppr).
 *
 * @param ideateDir - Path to the .ideate/ directory
 * @returns Config object with defaults applied for missing fields
 */
export function getConfigWithDefaults(ideateDir) {
    const configPath = path.join(ideateDir, "config.json");
    let raw = { schema_version: CONFIG_SCHEMA_VERSION };
    if (existsSync(configPath)) {
        try {
            raw = JSON.parse(readFileSync(configPath, "utf8"));
        }
        catch {
            // fallback to defaults if parsing fails
        }
    }
    const agent_budgets = {
        ...DEFAULT_AGENT_BUDGETS,
        ...(raw.agent_budgets ?? {}),
    };
    const rawPpr = raw.ppr ?? {};
    const ppr = {
        alpha: rawPpr.alpha ?? DEFAULT_PPR_CONFIG.alpha,
        max_iterations: rawPpr.max_iterations ?? DEFAULT_PPR_CONFIG.max_iterations,
        convergence_threshold: rawPpr.convergence_threshold ?? DEFAULT_PPR_CONFIG.convergence_threshold,
        edge_type_weights: {
            ...DEFAULT_PPR_CONFIG.edge_type_weights,
            ...(rawPpr.edge_type_weights ?? {}),
        },
        default_token_budget: rawPpr.default_token_budget ?? DEFAULT_PPR_CONFIG.default_token_budget,
    };
    return {
        ...raw,
        agent_budgets,
        ppr,
    };
}
//# sourceMappingURL=config.js.map