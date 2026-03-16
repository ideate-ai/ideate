import { artifactIndex, artifactQuery, artifactSemanticSearch, domainPolicies, getContextPackage, getWorkItemContext, sourceIndex, } from "./indexer.js";
import { resolveArtifactDir } from "./config.js";
// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
export const TOOLS = [
    {
        name: "ideate_get_work_item_context",
        description: "Returns pre-assembled context for a specific work item: the work item spec, related module spec (if any), applicable domain policies, and research notes. Use this instead of reading individual artifact files when working on or reviewing a single work item.",
        inputSchema: {
            type: "object",
            properties: {
                artifact_dir: {
                    type: "string",
                    description: "Absolute path to the ideate artifact directory (the directory containing plan/, steering/, domains/, etc.). Optional if a .ideate.json file exists in the project directory.",
                },
                work_item_id: {
                    type: "string",
                    description: "Work item identifier. Can be a numeric prefix (e.g. '082'), a slug (e.g. 'mcp-artifact-server'), or a full filename prefix (e.g. '082-mcp-artifact-server'). If work-items.yaml exists the id field is matched; otherwise the filename prefix is matched.",
                },
            },
            required: ["work_item_id"],
        },
    },
    {
        name: "ideate_get_context_package",
        description: "Returns the shared context package used by review agents: Architecture, Guiding Principles, Constraints, Source Code Index, and Full Document Paths. Assembled once and cached — use this instead of reading architecture.md, guiding-principles.md, and constraints.md individually. Follows the format defined in docs/context-package-spec.md.",
        inputSchema: {
            type: "object",
            properties: {
                artifact_dir: {
                    type: "string",
                    description: "Absolute path to the ideate artifact directory. Optional if a .ideate.json file exists in the project directory.",
                },
                review_scope: {
                    type: "string",
                    enum: ["full", "differential"],
                    description: "Optional. 'full' includes everything; 'differential' focuses on changed files. Defaults to full assembly.",
                },
                changed_files: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional. For differential scope: list of changed file paths to focus the source index on.",
                },
            },
            required: [],
        },
    },
    {
        name: "ideate_artifact_query",
        description: "Keyword search across all artifact files (markdown, yaml). Returns the top 10 matching chunks (each ≤50 lines) with source citations showing file path and line range. Use this to find where specific topics, decisions, or requirements are discussed across the artifact directory.",
        inputSchema: {
            type: "object",
            properties: {
                artifact_dir: {
                    type: "string",
                    description: "Absolute path to the ideate artifact directory. Optional if a .ideate.json file exists in the project directory.",
                },
                query: {
                    type: "string",
                    description: "Search query — space-separated keywords. Ranked by term frequency across artifact chunks.",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "ideate_artifact_index",
        description: "Returns the full artifact directory structure as a JSON object with file metadata: relative path, size in bytes, artifact type classification (work-item, module-spec, domain, steering, incremental-review, cycle-review, etc.), and last modified timestamp. Use this to get a map of what exists before deciding which files to read.",
        inputSchema: {
            type: "object",
            properties: {
                artifact_dir: {
                    type: "string",
                    description: "Absolute path to the ideate artifact directory. Optional if a .ideate.json file exists in the project directory.",
                },
            },
            required: [],
        },
    },
    {
        name: "ideate_domain_policies",
        description: "Returns active domain policies from domains/*/policies.md, optionally filtered to a single domain. Domain policies capture accumulated architectural decisions, coding conventions, and constraints distilled from prior review cycles.",
        inputSchema: {
            type: "object",
            properties: {
                artifact_dir: {
                    type: "string",
                    description: "Absolute path to the ideate artifact directory. Optional if a .ideate.json file exists in the project directory.",
                },
                domain: {
                    type: "string",
                    description: "Optional. Name of a specific domain (e.g. 'workflow', 'artifact-structure'). If omitted, returns policies from all domains.",
                },
            },
            required: [],
        },
    },
    {
        name: "ideate_artifact_semantic_search",
        description: "Semantic search across all artifact content using meaning rather than keywords. Returns relevant chunks with source citations and relevance scores. Useful for finding related policies, decisions, prior findings, or architectural context by concept.",
        inputSchema: {
            type: "object",
            properties: {
                artifact_dir: {
                    type: "string",
                    description: "Absolute path to the ideate artifact directory (the directory containing plan/, steering/, domains/, etc.). Optional if a .ideate.json file exists in the project directory.",
                },
                source_dir: {
                    type: "string",
                    description: "Absolute path to the project source root for indexing source files.",
                },
                query: {
                    type: "string",
                    description: "Natural language query describing what you are looking for.",
                },
                top_k: {
                    type: "integer",
                    description: "Maximum number of results to return (default 10, max 25).",
                },
                filter: {
                    type: "object",
                    description: "Optional filter to restrict results by artifact type or domain.",
                    properties: {
                        type: {
                            type: "string",
                            enum: [
                                "work_item",
                                "module",
                                "architecture",
                                "principle",
                                "constraint",
                                "research",
                                "journal",
                                "domain_policy",
                                "review",
                            ],
                        },
                        domain: {
                            type: "string",
                        },
                    },
                },
            },
            required: ["source_dir", "query"],
        },
    },
    {
        name: "ideate_source_index",
        description: "Returns a markdown table of source code files with language detection and key exports (function/class/type names). Format: | File | Language | Key Exports |. Use this to orient yourself in the project source tree before diving into specific files.",
        inputSchema: {
            type: "object",
            properties: {
                artifact_dir: {
                    type: "string",
                    description: "Absolute path to the ideate artifact directory (used to resolve source dir and for cache keying). Optional if a .ideate.json file exists in the project directory.",
                },
                source_dir: {
                    type: "string",
                    description: "Absolute path to the project source directory to index.",
                },
                path: {
                    type: "string",
                    description: "Optional. Relative path within source_dir to restrict the index to a subtree.",
                },
            },
            required: ["source_dir"],
        },
    },
];
// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------
export async function handleTool(name, args) {
    switch (name) {
        case "ideate_get_work_item_context": {
            const artifactDir = resolveArtifactDir(args);
            const workItemId = requireString(args, "work_item_id");
            return getWorkItemContext(artifactDir, workItemId);
        }
        case "ideate_get_context_package": {
            const artifactDir = resolveArtifactDir(args);
            const reviewScope = optionalEnum(args, "review_scope", [
                "full",
                "differential",
            ]);
            const changedFiles = optionalStringArray(args, "changed_files");
            return getContextPackage(artifactDir, reviewScope, changedFiles);
        }
        case "ideate_artifact_query": {
            const artifactDir = resolveArtifactDir(args);
            const query = requireString(args, "query");
            return artifactQuery(artifactDir, query);
        }
        case "ideate_artifact_index": {
            const artifactDir = resolveArtifactDir(args);
            return artifactIndex(artifactDir);
        }
        case "ideate_domain_policies": {
            const artifactDir = resolveArtifactDir(args);
            const domain = typeof args.domain === "string" ? args.domain : undefined;
            return domainPolicies(artifactDir, domain);
        }
        case "ideate_artifact_semantic_search": {
            const artifactDir = resolveArtifactDir(args);
            const sourceDir = requireString(args, "source_dir");
            const query = requireString(args, "query");
            const topK = typeof args.top_k === "number"
                ? Math.min(Math.max(1, Math.floor(args.top_k)), 25)
                : 10;
            const filter = args.filter && typeof args.filter === "object"
                ? args.filter
                : undefined;
            return artifactSemanticSearch({ artifact_dir: artifactDir, source_dir: sourceDir, query, top_k: topK, filter });
        }
        case "ideate_source_index": {
            const artifactDir = resolveArtifactDir(args);
            const sourceDir = requireString(args, "source_dir");
            const filterPath = typeof args.path === "string" ? args.path : undefined;
            return sourceIndex(artifactDir, sourceDir, filterPath);
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------
function requireString(args, key) {
    const val = args[key];
    if (typeof val !== "string" || val.trim() === "") {
        throw new Error(`Required argument "${key}" must be a non-empty string.`);
    }
    return val;
}
function optionalEnum(args, key, allowed) {
    const val = args[key];
    if (val === undefined || val === null)
        return undefined;
    if (typeof val !== "string" || !allowed.includes(val)) {
        throw new Error(`Argument "${key}" must be one of: ${allowed.join(", ")}.`);
    }
    return val;
}
function optionalStringArray(args, key) {
    const val = args[key];
    if (val === undefined || val === null)
        return undefined;
    if (!Array.isArray(val))
        return undefined;
    return val.filter((v) => typeof v === "string");
}
//# sourceMappingURL=tools.js.map