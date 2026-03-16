export interface IdeateConfig {
    artifactDir: string;
}
/**
 * Read and parse .ideate.json from a given directory.
 * Returns null if the file doesn't exist or is invalid.
 */
export declare function readIdeateConfig(dir: string): IdeateConfig | null;
/**
 * Walk up the directory tree from startDir looking for .ideate.json.
 * Returns the resolved absolute artifactDir, or null if not found.
 */
export declare function findIdeateConfig(startDir: string): string | null;
/**
 * Resolve artifact_dir from tool arguments, falling back to .ideate.json discovery.
 * Throws if neither is available.
 */
export declare function resolveArtifactDir(args: Record<string, unknown>, cwd?: string): string;
//# sourceMappingURL=config.d.ts.map