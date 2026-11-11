# Acceptance record — AGT-04 the plan gets its own section

Item: `AGT-04` (#1969). Tree: the pull-request head for branch
`feat/his05-plan-display`, parent `origin/main` `1b2b85d3fa`. Commands ran on the Linux
build host in a synced copy of this tree, from `crates/miao-tui`, `cargo 1.99.1`, debug
profile. A reviewer runs the same commands from the same directory anywhere.

`2026-11-07-agt04-goal-plan-checklist.md` accepted the engine side — the checklist, the
pending plan and the Goal as three separate durable kinds, with `goal.budget` +
`stop_when` and plan persistence — and named one residual: **the TUI three-way display**.
The engine already publishes all three in the `session.state` snapshot (`plan` beside
`todos` and `goal`), so the residual was a client-side gap. This tree closes it.

## What changed

- `crates/miao-tui/src/session.rs` decodes `state.plan.value` into `PlanView`
  (summary, status, step count) beside `GoalView`, and treats a retired plan (`null`) as
  absent rather than as an empty section.
- `crates/miao-tui/src/pane.rs` renders a `▾ Plan · <status>` section between the Goal
  and the checklist — the Goal says why the Session exists, the plan says how it means to
  get there, the checklist says what this turn is doing — with `approved` as the only
  status that earns colour, and the step *count* rather than a second copy of the steps,
  which stay in the checklist.
- `crates/miao-tui/src/app.rs` feeds the decoded plan to the sidebar with the same call
  that feeds the Goal and the checklist.

## Criterion — "Display the execution checklist, the plan awaiting approval, and the persistent Goal separately."

| surface | command (`crates/miao-tui`) | observed |
| --- | --- | --- |
| the three rows decode apart from one another | `cargo test --lib the_pending_plan_is_decoded_apart_from_the_goal_and_the_checklist` | `ok` — a snapshot carrying all three yields one todo, one goal objective and one plan summary |
| a retired plan is absent, not empty | `cargo test --lib a_retired_plan_is_absent_rather_than_empty` | `ok` — `plan: null` leaves `state.plan` as `None` |
| the plan paints between the Goal and the checklist, with its step count | `cargo test --lib the_pending_plan_sits_between_the_goal_and_the_checklist` | `ok` — the rendered rows order `▾ Goal · active` < `▾ Plan · approved` < the summary < `2 steps` < `▾ Todo 0/1` |
| every section header still opens after a blank row, the new one included | `cargo test --lib every_section_header_opens_after_a_blank_row` | `ok` — the header list now includes `▾ Plan` |
| the whole crate around it | `cargo test --lib` | `test result: ok. 628 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.42s` |
| lints | `cargo clippy --all-targets -- -D warnings` | `Finished` with no warnings from this crate |

## Criterion — "Do not treat completed todos as verified success or a displayed plan as implemented."

The section states a plan's *status word* and nothing stronger: `approved` means the
steps were transcribed into the checklist, and the header carries no success decoration
for any other status. The pre-existing `verified` flag on the goal stays the only
implementation claim, and the existing goal test (`the_goal_has_its_own_section_above_
the_todo_list`) still pins that the checklist is not the objective.

## Criterion — "Link implementation PR, offline or real client acceptance records, and applicable versions."

- Implementation PRs: `#2742` (the three durable kinds), `#2767` (the goal section), and
  this one (the plan section).
- Offline records: `2026-11-07-agt04-goal-plan-checklist.md` and this one.
- Version: **no release stamp yet.** This change is not in a published release — the
  latest published tag is `v0.3.60` and `v0.3.61` is still a draft — so the
  `roadmap: AGT-04 done in vX.Y.Z` line is deliberately absent. It belongs in the record
  of the release that first ships this tree.

## What this record does not claim

- No real terminal was driven: the rows are asserted against a rendered widget at 60
  columns, which is what the criterion describes.
- The Goal's edit/pause/resume/terminate controls and their budgets stay as the earlier
  record accepted them (engine-side `goal.budget` + `stop_when`); nothing here changes
  them.
- No cost or latency evidence: this is a display change on an existing snapshot.
