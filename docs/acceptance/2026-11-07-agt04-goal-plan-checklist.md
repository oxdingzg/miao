# AGT-04 — separate execution checklists, pending plans, and persistent Goals

**Item:** AGT-04 · Subagents, workflows, and goals
**Tree:** the AGT-04 squash commit `817ea9487a` on `main`. The commands below ran on
the pre-rebase branch tree (build-host log `acc1969.log` on xx02) and re-ran green on
the rebased tree in CI run 42622702798.
**Environment:** Linux x64 build host, `cargo test` from `crates/miao-engine`, stable `rustc 1.99.1`.

## Criterion 1 — "Display the execution checklist, the plan awaiting approval, and the persistent Goal separately."

**Command:** `cargo test --test state todos_goal_and_plan_live_in_separate_durable_rows a_plan_persists_across_restart_and_is_copied_by_fork`
**Observed:** `goal_lifecycle_moves_through_create_edit_pause_resume_and_terminate` walks the full lifecycle,
`goal_budget_is_a_structured_boundary_not_prose` pins budget as structure, and `a_plan_persists_across_restart_and_is_copied_by_fork`
pins persistence and fork copy. Same green CI run 42622702798; the build-host log shows each test `ok` on the pre-rebase tree.

The engine keeps three independent durable rows: `todos`, `goal`, and — added here — `plan`, each with its own revision counter. Writing the goal leaves the todo and plan rows and revisions untouched. The plan survives a store close/reopen and a fork copies the plan row the same way it already copied todos and goal (`store.rs` fork's inherited-kind list now includes `"plan"`). The per-turn `<session-state>` payload carries `"plan"` next to `"todos"` and `"goal"`, `state_selected` reports a `plan_revision`, and the all-empty null-gate includes the plan. The engine-side separation is what this record accepts; the TUI's three-way *display* stays open for the follow-up UI round.

## Criterion 2 — "Allow the Goal to be edited, paused, resumed, and terminated with explicit budget and stopping conditions."

**Command:** `cargo test --test state goal_lifecycle_moves_through_create_edit_pause_resume_and_terminate` and `cargo test --lib goal_budget_is_a_structured_boundary_not_prose`
**Observed:** `a_completed_todo_lands_unverified_until_a_receipt_fills_it` and `an_approved_plan_must_already_live_in_the_checklist`
pin the verified/implemented distinction, and `a_waiting_todo_or_an_active_goal_keeps_a_peer_unfinished` /
`every_recorded_todo_completed_with_no_goal_is_completed` pin the peer semantics. Same green CI run 42622702798;
the build-host log shows each test `ok` on the pre-rebase tree.

`budget` is now a structured boundary — `{iterations, tokens, wallclock_ms}`, at least one unit declared and none zero — plus optional `stop_when` conditions (at most 16, each non-empty and ≤512 chars). Prose budgets (`"two hours"`) and zero bounds are refused at `Mutation::parse`, so the boundary stays decidable later instead of degrading back into prose. The lifecycle test drives create → edit (budget + stop_when) → paused → active → done-with-evidence across optimistic revisions, and the goal tool schema advertises the same object shape.

## Criterion 3 — "Do not treat completed todos as verified success or a displayed plan as implemented."

**Command:** `cargo test --test state a_completed_todo_lands_unverified_until_a_receipt_fills_it` plus `cargo test --lib a_todo_cannot_claim_verification_through_the_write_surface an_approved_plan_must_already_live_in_the_checklist`
**Observed:** from `crates/miao-engine` on the recorded tree: `todos_goal_and_plan_live_in_separate_durable_rows`,
`durable_state_block_carries_goal_and_open_tasks_verbatim`, and `summary_plans_stay_single_until_the_prefix_cannot_fit`
pin the three durable kinds as separate rows projected verbatim. The whole engine suite on this rebased tree is green in
CI run 42622702798 (ubuntu shards 1-4), and the same tests appear individually `ok` in the earlier build-host run
(`acc1969.log`, pre-rebase tree).

The todo write surface rejects `verified` outright (`deny_unknown_fields`), and the durable value records `verified: false` for a completed todo until a verification receipt fills it — a completed checkbox is never presentable as verified success. The plan lives in its own row apart from the checklist and the goal; `status: "approved"` asserts the steps already live in the checklist (`transcribed: true` is required at parse time), and the plan feeds no loop — only the checklist does. `superseded` retires a plan without faking approval.

## Criterion 4 — "Link implementation PR, offline or real client acceptance records, and applicable versions; attach quality, cost, or latency evidence for optimizations."

**Observed:** This record is the offline acceptance evidence, and the implementation PR references issue #1969. AGT-04 is a clarity item, so no quality/cost/latency optimization is claimed and no such evidence is attached. The TUI three-way display stays open.

## Regression coverage

**Command:** `cargo test --lib` and `cargo test --test state`
**Observed:** on tree `0f0cfa0283` from `crates/miao-engine`:
`cargo test --lib` → `414 passed; 0 failed`; `cargo test --test state` →
`4 passed; 0 failed`; `cargo test --test full_http` → `1 passed; 0 failed`
(the standalone tool list counts `planwrite`); `cargo test --test accuracy`
→ `4 passed; 0 failed` after `MIAO_UPDATE_GOLDEN=1` regenerated the two
tool-schema snapshots for the structured `goal.budget`, `goal.stop_when`
and the `planwrite` definition.
