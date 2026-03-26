import Database from "better-sqlite3";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { handleGetWorkItemContext, handleGetContextPackage } from "./context.js";
import { handleArtifactQuery } from "./query.js";
import { handleGetExecutionStatus, handleGetReviewManifest } from "./execution.js";
import { handleGetConvergenceStatus, handleGetDomainState, handleGetProjectStatus } from "./analysis.js";
import { handleAppendJournal, handleArchiveCycle, handleWriteWorkItems, handleUpdateWorkItems, handleWriteArtifact } from "./write.js";
import { handleEmitEvent } from "./events.js";
import { handleGetMetrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// ToolContext
// ---------------------------------------------------------------------------

export interface ToolContext {
  db: Database.Database;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  drizzleDb: BetterSQLite3Database<any>;
  ideateDir: string;
}

// ---------------------------------------------------------------------------
// TOOLS — all 11 tool definitions with inputSchema
// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
  {
    name: "ideate_get_work_item_context",
    description:
      "Returns full context for a single work item: its definition, acceptance criteria, scope, dependencies, and any related findings or review history. Use this before starting or reviewing a work item.",
    inputSchema: {
      type: "object",
      properties: {
        work_item_id: {
          type: "string",
          description: "Work item identifier (e.g. 'WI-184' or '184').",
        },
      },
      required: ["work_item_id"],
    },
  },
  {
    name: "ideate_get_context_package",
    description:
      "Returns the full project context package: guiding principles, constraints, architecture overview, domain policies, and current execution strategy. Use at the start of a session to orient yourself.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "ideate_artifact_query",
    description:
      "Query the artifact index. Filter by type, domain, status, cycle, severity, phase, or work item. Optionally follow graph edges to retrieve related artifacts. Returns a JSON array of matching artifact objects.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Artifact type to filter by (e.g. 'work_item', 'finding', 'domain_policy', 'domain_decision', 'domain_question', 'guiding_principle', 'constraint', 'module_spec', 'journal_entry').",
        },
        filters: {
          type: "object",
          description: "Additional field-level filters.",
          properties: {
            domain: { type: "string" },
            status: { type: "string" },
            cycle: { type: "integer" },
            severity: { type: "string" },
            phase: { type: "string" },
            work_item: { type: "string" },
          },
          additionalProperties: false,
        },
        related_to: {
          type: "string",
          description:
            "Artifact ID to traverse edges from. Combined with edge_types and direction.",
        },
        edge_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Edge types to follow when related_to is specified (e.g. ['depends_on', 'blocks']).",
        },
        direction: {
          type: "string",
          enum: ["outgoing", "incoming", "both"],
          description: "Edge traversal direction when related_to is specified.",
        },
        depth: {
          type: "integer",
          description: "Graph traversal depth (default 1, max 10).",
          default: 1,
          maximum: 10,
        },
        limit: {
          type: "integer",
          description: "Maximum number of results (default 50, max 200).",
          default: 50,
          maximum: 200,
        },
        offset: {
          type: "integer",
          description: "Result offset for pagination (default 0).",
          default: 0,
        },
      },
      required: [],
    },
  },
  {
    name: "ideate_get_execution_status",
    description:
      "Returns execution status for the current cycle: total work items, counts by status (pending/in-progress/done/blocked), and which items are ready to start based on dependency resolution.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "ideate_get_review_manifest",
    description:
      "Returns the review manifest for a given cycle: the list of work items reviewed, reviewer assignments, and overall pass/fail verdict. Defaults to the most recent cycle.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_number: {
          type: "integer",
          description: "Cycle number to retrieve. Defaults to the most recent cycle.",
        },
      },
      required: [],
    },
  },
  {
    name: "ideate_get_convergence_status",
    description:
      "Returns convergence status for a given review cycle: open findings by severity, addressed vs. unaddressed counts, and whether the cycle has converged (no critical or significant open findings).",
    inputSchema: {
      type: "object",
      properties: {
        cycle_number: {
          type: "integer",
          description: "The cycle number to assess for convergence.",
        },
      },
      required: ["cycle_number"],
    },
  },
  {
    name: "ideate_get_domain_state",
    description:
      "Returns the current domain knowledge state: policies, decisions, and open questions for one or more domains. Omit domains to retrieve all domains.",
    inputSchema: {
      type: "object",
      properties: {
        domains: {
          type: "array",
          items: { type: "string" },
          description:
            "Domain names to retrieve (e.g. ['workflow', 'artifact-structure']). Omit to retrieve all domains.",
        },
      },
      required: [],
    },
  },
  {
    name: "ideate_get_project_status",
    description:
      "Returns a high-level project status summary: current cycle, total work items by status, recent journal entries, open domain questions, and pending findings.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "ideate_append_journal",
    description:
      "Appends a new entry to the project journal (journal.md). Use after completing significant work to create a durable record.",
    inputSchema: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          enum: ["plan", "execute", "review", "refine", "brrr"],
          description: "The skill phase that produced this journal entry.",
        },
        date: {
          type: "string",
          description: "ISO 8601 date string for the entry (e.g. '2026-03-25').",
        },
        entry_type: {
          type: "string",
          description:
            "Short label describing the type of entry (e.g. 'work-item-complete', 'cycle-start', 'decision').",
        },
        body: {
          type: "string",
          description: "Markdown body of the journal entry.",
        },
      },
      required: ["skill", "date", "entry_type", "body"],
    },
  },
  {
    name: "ideate_archive_cycle",
    description:
      "Creates the archive directory for a cycle (archive/cycles/NNN/) and writes a cycle summary document. Call after a review cycle completes.",
    inputSchema: {
      type: "object",
      properties: {
        cycle_number: {
          type: "integer",
          description: "The cycle number to archive.",
        },
      },
      required: ["cycle_number"],
    },
  },
  {
    name: "ideate_write_work_items",
    description:
      "Writes or updates work item YAML files in the .ideate/work-items/ directory. Creates one {id}.yaml file per work item. Each file contains all fields inline including notes content.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Array of work item objects to write.",
          items: {
            type: "object",
            description: "Work item definition.",
            properties: {
              id: {
                type: "string",
                description: "Work item identifier (e.g. 'WI-224'). Auto-assigned if omitted.",
              },
              title: { type: "string", description: "Short title for the work item." },
              complexity: {
                type: "string",
                enum: ["low", "small", "medium", "large", "high"],
                description: "Complexity estimate.",
              },
              scope: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    op: { type: "string" },
                  },
                  required: ["path", "op"],
                },
                description: "Files this work item touches.",
              },
              depends: {
                type: "array",
                items: { type: "string" },
                description: "Work item IDs this item depends on.",
              },
              blocks: {
                type: "array",
                items: { type: "string" },
                description: "Work item IDs this item blocks.",
              },
              criteria: {
                type: "array",
                items: { type: "string" },
                description: "Acceptance criteria.",
              },
              notes_content: {
                type: "string",
                description: "Implementation notes content (stored inline in the YAML).",
              },
              domain: {
                type: "string",
                description: "Domain this work item belongs to.",
              },
              status: {
                type: "string",
                description: "Work item status (default: 'pending').",
              },
              resolution: {
                type: ["string", "null"],
                description: "Resolution note when item is closed/obsolete.",
              },
              cycle_created: {
                type: ["integer", "null"],
                description: "Cycle number when this work item was created.",
              },
            },
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "ideate_update_work_items",
    description:
      "Updates specific fields on existing work items without overwriting the full definition. Pass an array of partial update objects, each with an id and the fields to change.",
    inputSchema: {
      type: "object",
      properties: {
        updates: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string" },
              resolution: { type: "string" },
              title: { type: "string" },
              complexity: { type: "string" },
              depends: { type: "array", items: { type: "string" } },
              blocks: { type: "array", items: { type: "string" } },
              criteria: { type: "array", items: { type: "string" } },
              domain: { type: "string" },
              notes: { type: "string" },
              scope: { type: "array", items: { type: "object" } },
            },
            required: ["id"],
          },
        },
      },
      required: ["updates"],
    },
  },
  {
    name: "ideate_write_artifact",
    description:
      "Write any artifact to the .ideate/ directory as a YAML file. Handles path resolution, content hashing, and SQLite indexing automatically.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description:
            "Artifact type (overview, execution_strategy, interview, research, architecture, guiding_principles, constraints, etc.)",
        },
        id: {
          type: "string",
          description: "Artifact identifier",
        },
        content: {
          type: "object",
          description: "YAML fields to write (type-specific content)",
        },
      },
      required: ["type", "id", "content"],
    },
  },
  {
    name: "ideate_get_metrics",
    description:
      "Returns aggregated metrics from the metrics_events table. Supports three aggregation scopes: agent (per-agent-type token and finding aggregates), work_item (first-pass acceptance and rework counts), and cycle (convergence speed, finding totals, token totals, cost estimates). Omit scope to get all three levels.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["agent", "work_item", "cycle"],
          description:
            "Aggregation scope. 'agent' = per-agent-type aggregates, 'work_item' = per-work-item aggregates, 'cycle' = per-cycle aggregates. Omit to return all three.",
        },
        filter: {
          type: "object",
          description: "Optional filter to narrow the events included in aggregation.",
          properties: {
            cycle: {
              type: "integer",
              description: "Include only events from this cycle number.",
            },
            work_item: {
              type: "string",
              description: "Include only events whose payload references this work item ID.",
            },
            agent_type: {
              type: "string",
              description: "Include only events with this event_name (agent type).",
            },
            phase: {
              type: "string",
              description: "Include only events whose payload references this phase.",
            },
          },
          additionalProperties: false,
        },
      },
      required: [],
    },
  },
  {
    name: "ideate_emit_event",
    description:
      "Fires all hooks registered for the given event name. Returns a JSON summary with the event name, number of hooks matched, number successfully executed, and any per-hook errors.",
    inputSchema: {
      type: "object",
      properties: {
        event: {
          type: "string",
          description:
            "Event name to fire (e.g. 'plan.complete', 'work_item.started', 'work_item.completed', 'review.finding', 'review.complete', 'cycle.converged', 'andon.triggered').",
        },
        variables: {
          type: "object",
          description:
            "Optional key-value pairs for variable substitution in hook commands and prompts (e.g. { work_item_id: '219' }).",
          additionalProperties: { type: "string" },
        },
      },
      required: ["event"],
    },
  },
];

// ---------------------------------------------------------------------------
// handleTool — dispatcher
// ---------------------------------------------------------------------------

export async function handleTool(
  ctx: ToolContext,
  name: string,
  _args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "ideate_get_work_item_context":
      return handleGetWorkItemContext(ctx, _args);

    case "ideate_get_context_package":
      return handleGetContextPackage(ctx, _args);

    case "ideate_artifact_query":
      return handleArtifactQuery(ctx, _args);

    case "ideate_get_execution_status":
      return handleGetExecutionStatus(ctx, _args);

    case "ideate_get_review_manifest":
      return handleGetReviewManifest(ctx, _args);

    case "ideate_get_convergence_status":
      return handleGetConvergenceStatus(ctx, _args);

    case "ideate_get_domain_state":
      return handleGetDomainState(ctx, _args);

    case "ideate_get_project_status":
      return handleGetProjectStatus(ctx, _args);

    case "ideate_append_journal":
      return handleAppendJournal(ctx, _args);

    case "ideate_archive_cycle":
      return handleArchiveCycle(ctx, _args);

    case "ideate_write_work_items":
      return handleWriteWorkItems(ctx, _args);

    case "ideate_update_work_items":
      return handleUpdateWorkItems(ctx, _args);

    case "ideate_write_artifact":
      return handleWriteArtifact(ctx, _args);

    case "ideate_emit_event":
      return handleEmitEvent(ctx, _args);

    case "ideate_get_metrics":
      return handleGetMetrics(ctx, _args);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
