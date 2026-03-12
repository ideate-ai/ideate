# 064: Create migration script

## Objective
Create `scripts/migrate-to-domains.sh` — a one-time shell script that migrates an existing flat `reviews/` artifact directory to the new `archive/` + `domains/` structure.

## Acceptance Criteria
- [ ] `scripts/migrate-to-domains.sh` exists and is executable
- [ ] Script accepts `<artifact-dir>` as positional argument; exits with usage message if missing
- [ ] Step 1: creates `archive/incremental/` and copies `reviews/incremental/*.md` there
- [ ] Step 2: creates `archive/cycles/001/` and copies `reviews/final/*.md` there
- [ ] Step 3: invokes `claude -p` with domain curator bootstrap prompt (skips gracefully if claude not on PATH)
- [ ] Script does NOT delete `reviews/` — leaves original intact for user verification
- [ ] Prints summary of files copied and domains created

## File Scope
- `scripts/migrate-to-domains.sh` (create)

## Dependencies
- Depends on: none
- Blocks: none

## Implementation Notes
The `claude -p` step cannot run inside an active Claude Code session (nested session restriction). The script should detect this and print a clear message. In that case, the domain bootstrap step must be run manually via the domain-curator agent from within the active session.

## Complexity
Low
