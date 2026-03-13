# Work Item 045: Manager Agent Diff Application

## Objective

Update `agents/manager.md` to include a diff application section. When the manager polls a completed remote job that returns a `git_diff`, it should apply the diff to the local project source root using `git apply`, handle conflicts by routing to the Andon cord, and confirm successful integration.

## Acceptance Criteria

1. `agents/manager.md` has a dedicated section describing the diff application workflow (e.g., "Remote Job Result Integration" or "Applying Remote Diffs")
2. The section specifies: after `poll_remote_job` returns a completed job with non-null `git_diff`, apply the diff using `git apply` (or `git apply --index`) in the project source root
3. The section specifies: if `git apply` exits non-zero (conflict or rejection), the manager does NOT attempt to resolve the conflict — it routes the conflict to the Andon cord with: the job_id, worker_name, failed diff content, and the `git apply` error output
4. The section specifies: if `git apply` succeeds, log the successful integration (job_id, worker_name, files changed) to the status report
5. The section specifies: if `git_diff` is null or empty, no application step is taken (job completed with no file changes)
6. The section specifies: the manager uses its Bash tool to execute `git apply`
7. The section is integrated into the manager's existing workflow description — it is not a standalone appendix

## File Scope

- modify: `agents/manager.md`

## Dependencies

None.

## Implementation Notes

Locate the section in `agents/manager.md` that describes polling remote jobs (likely in the "Remote Job Monitoring" or "Poll Remote Jobs" section). After the poll step description, add the diff application workflow as a sub-step or follow-on step.

The Bash command to apply a diff:
```bash
cd {project_source_root} && git apply - <<< "{git_diff_content}"
```
Or using a temp file:
```bash
echo "{git_diff_content}" > /tmp/remote-job-{job_id}.patch
cd {project_source_root} && git apply /tmp/remote-job-{job_id}.patch
```

If `git apply` returns non-zero:
- Capture stderr output
- Stage an Andon cord event: "Remote diff application failed for job {job_id} from {worker_name}. Error: {stderr}. The diff is attached for manual review."
- Do not leave a partial application state — run `git apply --check` first if uncertain, or `git checkout -- .` to revert any partial state before raising the Andon event.

The tone of all additions must match the existing manager.md tone: neutral, direct, no hedging.

## Complexity

Medium
