# Work Item 044: Fix Remote Dispatch README Documentation

## Objective

Fix three schema mismatches in `mcp/session-spawner/README.md` where documented response fields do not match implementation, and add role advisory disclaimers to both the session-spawner and remote-worker READMEs clarifying that `role` is an observability label only for remote dispatch — tool restrictions and system prompt injection are not enforced by the remote worker daemon.

## Acceptance Criteria

1. `list_remote_workers` Returns section in session-spawner README shows only fields that exist in implementation: `name`, `url`, `status` (`"ok"` | `"unreachable"` | `"auth_error"`), `active_jobs`, `queued_jobs`, `max_concurrency`. Fields `reachable`, `version`, and `error` are removed from the documentation.
2. `list_remote_workers` Returns section notes that `status` is the discriminator: `"ok"` for healthy workers, `"unreachable"` or `"auth_error"` for unhealthy workers. Null values for `active_jobs`, `queued_jobs`, `max_concurrency` when worker is unreachable.
3. `spawn_remote_session` Returns section removes `worker_url` field (it does not exist in the implementation).
4. `poll_remote_job` "when still running" example response includes `job_id`.
5. `mcp/session-spawner/README.md` contains a note under `spawn_remote_session` (or in a dedicated "Role Behavior" section) stating: "The `role` parameter is an observability label for remote dispatch. The remote worker daemon does not perform role resolution — tool restrictions, system prompt injection, and permission mode overrides defined in the role are not applied to the remote claude subprocess."
6. `mcp/remote-worker/README.md` contains a note in the `POST /jobs` section (or in a dedicated note box) stating the same advisory-only behavior for the `role` field.
7. No other content in either README is modified.

## File Scope

- modify: `mcp/session-spawner/README.md`
- modify: `mcp/remote-worker/README.md`

## Dependencies

None.

## Implementation Notes

**session-spawner README** — locate the `list_remote_workers` Returns section. Replace the current JSON example with:
```json
[
  {
    "name": "gpu-box-1",
    "url": "http://gpu-box-1:7432",
    "status": "ok",
    "active_jobs": 1,
    "queued_jobs": 0,
    "max_concurrency": 3
  },
  {
    "name": "gpu-box-2",
    "url": "http://gpu-box-2:7432",
    "status": "unreachable",
    "active_jobs": null,
    "queued_jobs": null,
    "max_concurrency": null
  }
]
```

**session-spawner README** — `spawn_remote_session` Returns: remove `worker_url` line from the JSON example.

**session-spawner README** — `poll_remote_job` when running example: add `"job_id": "550e8400-..."` to the JSON.

**Role advisory notes**: Add a "Note" or "⚠" callout after the `role` parameter row in each tool's parameter table. Keep it concise: one sentence stating role is advisory-only for remote dispatch.

## Complexity

Low
