# Acceptance record — VAL-02 task accounting

Item: `VAL-02`. Tree: `97b4dea0ce`. Criteria, quoted from the tree:

> Human interventions are not counted, so VAL-02's "time from submit to
> verified completion plus human interventions" is only half measured.
> (`docs/experiments/2026-11-01-val01-engine-baseline/README.md`)

> …with the cost and wall-clock figures VAL-02 asks for on a per-completed-task
> basis… (`docs/experiments/2026-11-01-ts-suite-real-model/README.en.md`)

> **Human-intervention accounting** (VAL-02): none occurred by construction and
> the harness does not record it.
> (`docs/experiments/2026-11-01-two-arm-real-model/README.en.md`)

Those two-arm rounds measured cost and wall clock but left VAL-02's three
figures — per-completed-task cost, submit-to-verified-completion time, and
human-intervention accounting — unrecorded by construction. This record is the
engine-side accounting that closes that gap, with the semantics
`specs/baseline-completion-accounting.md` already fixed: all recorded attempts
are retained, `perCompletedTask` divides those totals by the number of runs
whose verified outcome is `passed`, and a missing value stays unknown rather
than folding in as a fabricated zero.

## Criteria and what was observed

| criterion | command | observed |
| --- | --- | --- |
| every run — retries, failures, unverified — is charged beside the completions it accompanies | `cd crates/miao-engine && cargo test --locked --test task_accounting` | `every_run_is_charged_to_the_completed_task_beside_it ... ok` |
| an unpriced turn leaves task cost unknown, never zero | (same suite) | `an_unpriced_turn_leaves_the_task_cost_unknown_instead_of_zero ... ok` |
| wall clock covers submit to verified completion plus human waits | (same suite) | `wall_clock_covers_submit_to_completion_and_human_waits ... ok` |
| an interrupted run has no wall clock until it finishes | (same suite) | `an_interrupted_run_has_no_wall_clock_until_it_finishes ... ok` |
| delegated child-Session spend lands in the one task window it served | (same suite) | `delegated_child_spend_is_attributed_to_the_task_window_it_served ... ok` |
| a stored estimate keeps the rates it was computed from | (same suite + `--lib pricing`) | `test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.64s`, then `3 passed; 0 failed; 0 ignored; 0 measured; 395 filtered out` |

Observed on the build host per the workstation's build-offloading policy
(over SSH, Linux build host): the six-test suite and the pricing filter as quoted above, plus a
full `cargo test` for `crates/miao-engine` on the same tree whose 196 test
targets all reported `test result: ok` — none `FAILED`. Any reviewer can run
the same commands wherever a Rust toolchain is available.

## What this accounting does and does not cover

- Covered by the engine now: one admitted user input is one task; the runs that
  promoted it are its work. `usage_report` carries a `tasks` block — outcome
  (`passed`/`failed`/`unverified`), submit→completion wall clock, billed tokens
  against the agent's budget, cost by currency across the task's own runs and
  the child Sessions attributed by time window — and a `wallClock` block with
  first submit, last verified finish, and permission/question intervention
  spans with their wait times.
- A cheap-but-wrong run is charged to the completions beside it: the
  per-completed-task numerator is every user task's totals; the denominator is
  only the `passed` count. Work outside every task window stays at the Session
  level in the existing `subagents` block.
- Missing figures stay unknown: a task whose run never finished has no wall
  clock; an unpriced turn sets `cost.known = false` instead of adding zero.
- Not covered: a real-model, real-intervention measurement round. The fixtures
  pin the timeline with `Store::record_at`, which is what makes the wall clock
  and wait figures reproducible; operator-in-the-loop timing on paid providers
  remains a separate evidence round, and this record does not read as invoice
  reconciliation.
