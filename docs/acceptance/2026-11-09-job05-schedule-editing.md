# Acceptance record — JOB-05 scheduled, cron, wakeup, and recurring task editing

Item: `JOB-05`. Tree: PR #2792, squash merge of `feat/job05-schedule-editing`
(final head `4cdbf8339b`) on `main`. The commands below are the cargo
invocations the pull request's CI workflow runs on ubuntu-24.04 from the crate
directory on this recorded tree; the observed cells cite that run (run
42756627101: engine shards, cli, unit green after the lock and type fixes).

## Criterion — scheduled triggers are editable in place; restart adoption re-arms the edited definition; editing and cancellation stay distinct from goal continuation

`cron::Change::parse` edits pending cron schedules and pending wakeups in
place: the update is appended as `cron.updated` and one overlay feeds every
reader — a fired occurrence, a list row, and the restart re-arm — so one edit
moves the definition everywhere at once. Wakeup edits recompute the due time
and keep identity; fieldless, resolved, and invalid changes are refused.
Adoption after restart re-arms the edited definition (never the original
window), and recurring occurrences keep admitting distinct inputs without
catch-up bursts.

Pinned tests (all `ok` in run 42756627101):

- `tests/cron.rs::edit_retargets_the_armed_pattern_and_keeps_identity`
- `tests/cron.rs::restart_adoption_rearms_the_edited_definition`
- `tests/cron.rs::recurring_occurrences_admit_distinct_inputs_without_catch_up_bursts`
- `tests/cron.rs::queued_backlog_coalesces_and_timer_survives_turn_cancel`
- `tests/cron.rs::nonrecurring_expiry_recovery_and_fork_have_no_hidden_replay`
- `tests/cron.rs::cron_and_wakeup_share_one_capacity_budget`
- `tests/wakeup.rs::edit_moves_the_due_time_and_keeps_identity`
- `tests/wakeup.rs::edit_refuses_fieldless_resolved_and_invalid_changes`
- `tests/wakeup.rs::timer_survives_turn_cancel_and_fires_one_atomic_admission`
- `tests/wakeup.rs::independent_cancel_ownership_and_shutdown_close_timers_without_prompts`
- `tests/wakeup.rs::capacity_and_recovery_are_bounded_and_fork_does_not_copy_timers`

| command | observed |
| --- | --- |
| `cargo test --test cron` (engine shards of run 42756627101) | ok |
| `cargo test --test wakeup` (engine shards, same run) | ok |

The background loops re-arm through cooperative tokens: an edit exits the
loop without resolving the schedule, and the replacement loop adopts the
edited definition — cancellation stays a separate, explicit act.

## Criterion 4 — link the implementation PR, acceptance records, and target versions

- Implementation: #2792.
- Acceptance record: this file.
- Versions: applies from the release that first ships the merged tree; stamped
  per the repository convention when that release cuts.

**Recorded open, not hidden:** the TUI interactive editing surface for
schedules stays open; per-task budget accounting for model calls fired by a
schedule hangs on the usage-attribution work and is called out in the issue.
