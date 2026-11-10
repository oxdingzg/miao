# Acceptance record — JOB-02 jobs dialog: owners, output, and stop-all

Item: `JOB-02`. Tree: PR #2791, squash merge of `test/job02-owner-subagent-rows`
(final head `bd8705dc4d` plus the review fixes through `dc1c966be7`) on `main`.
The commands below are the cargo invocations the pull request's CI workflow
runs on ubuntu-24.04 from the crate directory on this recorded tree; the
observed cells cite that run (run 42753914256: tui, cli, engine shards, unit,
typecheck green).

## Criterion — list owner, status, and recent output; cancel individually and stop all with confirmation; show true state after restart

The jobs dialog answers one wire command with jobs and the Session's delegated
subagents composed together (`Command::Jobs` → composed answer), each row
carrying owner, state, and the job's recent output tail; stop-all runs behind
a destructive confirmation (the `X` chord, confirm starting on cancel), and a
reopened dialog renders the state the engine holds now — restart-safe, with
the stopped job's output tail kept inside the row width.

Pinned tests (all `ok` in run 42753914256):

- `tests/jobs.rs::the_jobs_command_serves_owners_output_and_children_in_one_answer` —
  the wire answer composes owners, output, and the subagent side list
- `tests/jobs.rs::admitted_job_survives_turn_cancel_and_instruction_reads_do_not_wait_for_it`
- `tests/jobs.rs::job_ownership_and_explicit_cancel_are_separate_from_turn_control`
- `tests/jobs.rs::stop_all_jobs_cancels_every_job_the_session_owns`
- `tests/jobs_dialog.rs::the_jobs_dialog_names_each_owner_and_the_session_subagents` (PTY)
- `tests/jobs_dialog.rs::a_reopened_jobs_dialog_shows_the_state_after_the_restart` (PTY)
- `tests/jobs_dialog.rs::stopping_every_job_asks_first_and_shows_the_true_state_after` (PTY,
  the confirm gate and the stopped job's output tail rendering)

| command | observed |
| --- | --- |
| `cargo test --test jobs` (engine leg, run 42753914256) | ok |
| `cargo test --lib` (tui leg, same run) | ok — 606 passed; 0 failed |
| `cargo test --test jobs_dialog` (tui leg, same run) | ok |

## Criterion 4 — link the implementation PR, acceptance records, and target versions

- Implementation: #2791.
- Acceptance record: this file.
- Versions: applies from the release that first ships the merged tree; stamped
  per the repository convention when that release cuts.

**Recorded open, not hidden:** live-client verification of the stop flows in
real terminals stays open; the offline pins cover the wire, dialog, and PTY
semantics.
