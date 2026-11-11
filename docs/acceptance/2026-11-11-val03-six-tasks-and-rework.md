# Acceptance record — VAL-03 the six tasks, and the mistakes/rework definition

Item: `VAL-03` (#1910). Tree: the pull-request head for branch
`test/val03-error-cost`, parent `origin/main` `2c703d1dd1`. Every command below ran on
the Linux build host from `crates/miao-tui`, `cargo 1.99.1`, against this tree; both
`--nocapture` and the machine are stated per row so a reviewer reproduces it.

The six tasks each had a mechanical baseline already, and `2026-11-05-val03-review-
changes.md` closed the fifth. What kept the item open was the fourth quantity:
**mistakes and rework**, which earlier records called "operator observations; no harness
produces them". This record re-runs the six baselines on one tree and settles that
quantity by definition rather than by pretending a keystroke count is a human-factors
study.

## The six tasks, measured on this tree

| task | command | observed |
| --- | --- | --- |
| startup | `cargo test --test startup_latency -- --nocapture` | `cold: first_frame p50 26 ms / p95 32 ms, ready_to_type p50 31 / p95 37`; `warm: first_frame p50 20 / p95 26, ready_to_type p50 25 / p95 36`; the gate is `warm ready_to_type p95 ≤ 500 ms` |
| finding a session | `cargo test --test interaction_cost -- --nocapture` | `catalog=200 target=150: walk=152 keys/348 ms, filter=15 keys/35 ms` |
| editing input | `cargo test --test interaction_edit -- --nocapture` | `motions=44 keys/13 ms, retype=120 keys/55 ms` |
| approval | `cargo test --test smoke an_approval_is_answered_from_the_panel -- --nocapture` | `approval-decision: 50 ms from the key` |
| reviewing changes | `cargo test --test interaction_review -- --nocapture` | `review-changes: 2 keys/13 ms` |
| failure recovery | `cargo test --test interaction_recovery -- --nocapture` | `typing=15 keys, recovery=2 keys/20 ms, total 142 ms` |

All six runs passed (`1 passed` each; `startup_latency` `2 passed`). The numbers are
lower than the ones the earlier records carry because those ran on a loaded host; the
*contract* each test asserts is unchanged, and the gate is expressed relative to the
machine it runs on.

## Mistakes and rework — the definition this item now uses

A harness can observe an action; it cannot observe a person's judgement. So this item
records the two quantities where the product itself sees them, and says so:

| quantity | definition used here | where it is recorded | pinned by |
| --- | --- | --- | --- |
| **mistakes** | a decision the operator took back: a rejected approval, a cancelled run, or a draft they rewrote before sending | the engine's `interventions` counters — `rejections`, `cancels`, `inputEdits` — read from the usage report and painted in the sidebar's `needs you` row | `cargo test --lib the_usage_scopes_are_ordered_and_abnormal_rows_come_first` (`crates/miao-tui`), which renders an approval with no answers and asserts the row reads `needs you 1` rather than a row of zeroes |
| **rework** | work the model had to redo: a tool call refused for a malformed input, and a turn replayed after a failed attempt | `rework.toolInputErrors` and `retries.replayedTurns` / `retries.failedAttempts` in the same report, painted in the sidebar's `retried` / `rework` rows | the same test: `retried 2`, `1 failed attempt`, `5 attempts`, `rework 3 · tool-input error` |

This replaces the earlier "unmeasurable" status with a definition that a reviewer can
check: every number in it comes from a counter the engine already keeps, and the paint
that shows it is asserted from a rendered sidebar at 60 columns.

**What it deliberately is not:** a study of human error rates. `mistakes` here counts
actions the product saw taken back, not errors a person believes they made; the
keystroke baselines above do not claim to measure comprehension. A human-factors study
would need a person, a task script and a recorder, and no test in this repository
pretends to be one.

## Criterion — "Fix the sample set and termination conditions; UI changes need before/after evidence."

Every row above names a fixed fixture (`catalog=200 target=150`, a 60-column sidebar, a
scripted engine), a command, and the assertion that ends it. The sidebar paint has its
own before/after in `2026-11-11-...`-series records; the task numbers are the "before"
any future change has to beat.

## Version

Applicable version: `v0.3.60` ships every behaviour measured here (the usage counters
arrived in `#2045`, well before it). No `roadmap:` stamp is written: the record's tree is
newer than that release, so the stamp belongs to the release that first ships this exact
tree — the same rule the other 2026-11-11 records follow.
