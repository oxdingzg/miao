# Acceptance record — JOB-05 a schedule row states its zone, its next run and its lifetime

Item: `JOB-05` (#1965). Tree: the pull-request head for branch
`feat/job05-schedule-rows`, parent `origin/main` `cdaa1fc82b`. Commands ran on the Linux
build host `xx04` from `crates/miao-tui`, `cargo 1.99.1`.

`2026-11-11-job05-schedule-edit.md` landed editing and named two rows still open: what a
row *shows*, and a per-task budget. This record closes the first. The budget stays with
`COST-02` (#1972), because a second budget vocabulary here would collide with the one
`goal.budget` already owns.

## Criterion — "Display next execution time, timezone, ownership, persistence, and expiration criteria."

| fact | how the row states it | observed |
| --- | --- | --- |
| the expression it is scheduled by | the cron's own pattern | `*/5 * * * *` |
| the zone the occurrences were computed in | `Store::crons`' `timezone`, verbatim | `Asia/Shanghai` |
| when it next runs | `next_occurrence_ms` through the same coarse `due_in` the wakeup rows use | `next in 5m` |
| when it stops existing | `expires_at_ms` | `expires in 2h` |
| how often it ran | `fired_count` / `skipped_count` | `2 fired · 1 skipped` |
| **ownership** | the panel is the open Session's, so every row is already its own; a row does not repeat a field the panel header states | — |
| a fact the engine never recorded | omitted rather than invented | a row recorded before zones existed reads `0 9 * * 1 · 0 fired · 0 skipped` |

## What changed

`crates/miao-tui/src/engine.rs`'s `refresh_schedule` used to build the row text inline;
the builder is now a pure `schedule_rows(wakeups, crons)` so the fields a row shows are
testable without an engine connection, and the cron row gained the zone, the next run and
the lifetime. A wakeup row gained the zone it was recorded with.

## The commands

| surface | command (`crates/miao-tui`) | observed |
| --- | --- | --- |
| a cron row states zone, next run and expiry | `cargo test --lib a_cron_row_states_its_zone_next_run_and_expiry` | `ok` — `*/5 * * * * · Asia/Shanghai · next in 5m · expires in 2h · 2 fired · 1 skipped` |
| parts the engine did not record are omitted | `cargo test --lib a_cron_row_omits_parts_the_engine_did_not_record` | `ok` — `0 9 * * 1 · 0 fired · 0 skipped` |
| a wakeup row states its due time and zone | `cargo test --lib a_wakeup_row_states_its_due_time_and_zone` | `ok` — `in 1m · Europe/Berlin` |
| the panel's other behaviour is unchanged | `cargo test --lib schedule` | `8 passed` |
| the crate around it | `cargo test --lib` | `642 passed; 0 failed` |
| lints | `cargo clippy --all-targets -- -D warnings` | `Finished` with no warnings from this crate |

The three time-sensitive rows add a margin to their timestamps (330 s reads `in 5m`,
90 s reads `in 1m`) so a few milliseconds of drift cannot move the assertion into the
neighbouring bucket — a boundary the first draft of the test would have straddled.

## Still open on this item

**Accounting a schedule's own model calls against a per-task budget.** The engine bounds a
Session's tokens (`goal.budget`) and a delegated child's turns and wall clock, but a cron
or wakeup has no budget of its own. That is a cost design (`COST-02`, #1972) rather than a
display, and this record does not invent one.

## Version

No `roadmap:` stamp: this tree is in no published release yet, and the item keeps the
budget row open.
