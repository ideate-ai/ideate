# Work Item 047: Update Architecture Document Component Tables

## Objective

Update `specs/plan/architecture.md` component tables to include the four new components added in WI 030-038 that were not reflected in the architecture document: the remote-worker daemon (external tooling), manager and proxy-human agents, and brrr skill. The architecture document is the primary input for agents performing system analysis — an incomplete component map violates Guiding Principle 1 (Spec Sufficiency).

## Acceptance Criteria

1. The "Skills (User-Invocable Workflows)" table includes `/ideate:brrr` with Purpose, Invokes Agents, and Key Artifacts columns populated
2. The "Agents (Delegated Workers)" table includes `manager` and `proxy-human` rows with Model, Background, Tools, and Spawned By columns populated
3. The "External Tooling" table includes `remote-worker` with Type and Purpose columns populated
4. The data flow diagram (Section 2) or a new sub-section references the remote worker dispatch flow: `session-spawner → spawn_remote_session → remote-worker HTTP API → poll_remote_job → manager (diff apply)`
5. The agent table `Background` field for manager and proxy-human matches their agent frontmatter (`background: false`)
6. No existing content in architecture.md is removed or incorrectly modified

## File Scope

- modify: `specs/plan/architecture.md`

## Dependencies

None.

## Implementation Notes

**Skills table** — add row:
```
| `/ideate:brrr` | Autonomous SDLC loop until convergence (zero findings + zero violations) | spec-reviewer, code-reviewer, gap-analyst, proxy-human | brrr-state.md, proxy-human-log.md, journal.md |
```

**Agents table** — add rows:
```
| manager | sonnet | no | Read, Grep, Glob, Bash, list_remote_workers | execute, brrr |
| proxy-human | sonnet | no | Read, Grep, Glob, Write | brrr |
```
Note: model is `sonnet` after WI-040 changes architect/decomposer/proxy-human to sonnet default.

**External Tooling table** — add row:
```
| remote-worker | HTTP daemon (Python/FastAPI) | Runs on remote machines; accepts jobs via REST API; executes them using local `claude` CLI; returns output + git diff |
```

**Data flow addition**: After the existing `session-spawner` section, add a brief note or extend the data flow diagram to show:
```
session-spawner ──spawn_remote_session──▶ remote-worker:7432/jobs
               ◀──poll_remote_job──────── remote-worker (job status + git_diff)
                                          manager (applies git_diff via git apply)
```

Keep additions minimal — update tables and add one flow note. Do not rewrite sections that are accurate.

## Complexity

Low
