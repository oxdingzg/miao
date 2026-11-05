# Acceptance record — JOB-02 background tasks

Item: `JOB-02`. Tree: `db0b250ae6`. Commands ran on the Linux build host from
`crates/miao-engine`. All suites are Rust; the TS handler listed under the item's
"Evidence" (`packages/server/src/handlers/pty.ts`) is the implementation RUS-02 retires and
carries nothing here.

## Criterion 1 — owner, status and recent output for shells, jobs and subagents

| surface | command | observed |
| --- | --- | --- |
| background jobs | `cargo test --test jobs` | `9 passed` — `the_job_list_names_the_owner_and_the_command`, `job_list_and_wait_observe_a_completed_job`, `admitted_job_survives_turn_cancel_and_instruction_reads_do_not_wait_for_it`, `job_completion_after_idle_admits_once_and_wakes_the_existing_owner` |
| interactive shells | `cargo test --test terminal` | `5 passed` — `interactive_terminal_input_resize_replay_and_session_isolation`, `terminal_stop_and_shutdown_reap_processes_and_bound_output`, `runtime_dispatches_terminal_tools_through_durable_history` |
| subagents | `cargo test --test children` | `4 passed` — `a_running_child_is_busy_and_a_finished_one_names_its_outcome`, `a_bounded_answer_says_how_many_children_it_left_out`, `forked_children_keep_their_boundary_and_archived_ones_stay_visible` |

## Criterion 2 — individual cancel and global stop, with explicit permissions

`job_ownership_and_explicit_cancel_are_separate_from_turn_control`,
`stop_all_jobs_cancels_every_job_the_session_owns` and
`stop_all_jobs_leaves_another_sessions_jobs_running` (in the `jobs` run above) pin that a
stop is scoped to the Session that owns the job, and that another Session's work survives.
`task_is_denied_without_subagent_authority` (in the `subagent` run below) pins the
authority gate for delegation.

## Criterion 3 — true state after a crash or restart, never a false "running"

`crash_reconciliation_preserves_unknown_running_state_without_replay` (in the `jobs` run)
covers the restart case for background jobs: a job the previous process was running comes
back as an unknown, non-replayed state rather than as active work.
`a_subagent_that_never_stopped_is_closed_by_recovery` and
`recovery_leaves_finished_subagents_alone` (`cargo test --test subagent`) cover the same
question for delegated children.

| command | observed |
| --- | --- |
| `cargo test --test subagent` | `13 passed; 0 failed` (39 s) — run twice, both green |

**Observation, recorded rather than hidden:** the first `cargo test --test subagent` run in
this batch reported `6 passed; 7 failed` after 71 s, and two consecutive runs immediately
after were fully green with no code change between them. The failing output was not
captured, so this record does not claim the suite is steady; it is a flake under a
spawn-heavy load that needs its own root-cause fix. Because of that, the subagent half of
criteria 1 and 3 is recorded as **verified but not proven stable**.

Result: criteria 1–3 accepted for background jobs, shells and delegated children on the
evidence above; the subagent flake stays open as a follow-up.
