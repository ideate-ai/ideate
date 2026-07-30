# autopilot phase — reporting

Terminal phase for the autopilot loop. The controller runs this once, when the
loop ends, for any reason. Its job: reconstruct and present a truthful account
of the whole run from the durable record — autopilot ran unattended, so this
report is how the user learns what happened.

## Determine why the loop ended
One of:
- **Converged** — review returned `converged` and the board has no open
  claimable work. The project met its bar.
- **Max cycles** — `cycle >= --max-cycles`. Work may remain.
- **Appetite spent** — the recorded effort budget was reached.
- **Diverged / stalled** — `refine.md`'s divergence guard stopped the loop, or
  a proxy-human decision halted it. Needs human attention.

## Reconstruct the run from the record
Autopilot state lives in records, not memory — rebuild from ground truth:
- `record_read(scope="autopilot")` — every `autopilot-cycle` record: per-cycle
  items completed, findings, verdicts, head commits.
- `work_list` — final board state (done / open / cancelled counts, remaining
  claimable frontier). These counts are whole-board: page with `next_cursor`
  until it is `null`; a page shorter than `limit` is not the end.
- `record_read(scope="andon")` — every proxy-human decision, especially those
  flagged `human: true`.
- `git log --oneline <first-cycle-head>..HEAD` — what actually shipped.

## Present the report
- **Outcome** — why it ended (above), stated plainly. If not converged, say so
  clearly; do not dress up an incomplete run as success.
- **Work** — cycles run, items completed vs. still open, commits produced.
- **Findings** — totals by severity across the run, and how many remain open.
- **Proxy-human decisions** — list them, and **highlight the `human:true`
  ones** — these are the autonomous calls a human should still review.
- **Remaining work** — the open board frontier and the recommended next step
  (`/ideate:refine` for a stalled/incomplete run, or the next planned work if
  converged).

Finally append a closing `record_append(kind="journal")` summarizing the run,
and a `record_append(kind="autopilot-complete")` milestone with the outcome.

## Honesty bar
This report is the only window the user has into an unattended run. Report
failures, deferrals, and skipped work explicitly, with evidence (record ids,
commits). A converged verdict must be backed by the derived convergence test,
not asserted.
