# Acceptance record — VAL-03's six baselines, read from a CI run

Item: `VAL-03` (#1910). Tree: `1806d88151`, the head of `feat/issue1910` that CI run
[`43012403931`](https://github.com/oxdingzg/miao/actions/runs/43012403931) verified
green; squash-merged as `97e3e8bb6e`. Criterion, quoted from the item:

> Measure six user tasks: startup, finding a session, editing input, approval,
> reviewing changes, and failure recovery

> Record time-to-state, keystrokes, mistakes, and rework

`2026-11-11-val03-six-tasks-and-rework.md` already records all six tasks and settles
the fourth quantity by definition. What no run could show was the numbers themselves:
the harnesses print them under `--nocapture`, and the `tui` leg ran `cargo test
--locked --no-fail-fast -- --test-threads=1` without it, so a green run proved the
suites pass while the baseline stayed readable only on the machine that last ran it.
This record is the same six measurements, printed by CI and quoted from the run.

## Criterion, command, observed

Command, as the `VAL-03 baselines` step of `.github/workflows/tui.yml` runs it from
`crates/miao-tui` on `ubuntu-latest`:

```
cargo test --locked --no-fail-fast \
  --test startup_latency --test interaction_cost --test interaction_edit \
  --test interaction_approval --test interaction_review --test interaction_recovery \
  -- --nocapture --test-threads=1
```

Run [`43012403931`](https://github.com/oxdingzg/miao/actions/runs/43012403931), job
`tui / tui (ubuntu-latest)`, step 9 `VAL-03 baselines`: `success`. Each binary reported
`1 passed; 0 failed` (`startup_latency`: `2 passed`), and printed:

| task | observed | harness |
| --- | --- | --- |
| startup | `PERF-03 cold: first_frame p50 15 / p95 15, ready_to_type p50 25 / p95 25`; `PERF-03 warm:` the same figures; gate `warm_ready_to_type_p95_ms 500` | `startup_latency` |
| finding a session | `VAL-03 find-session catalog=200 target=150: walk=152 keys/331 ms, filter=15 keys/38 ms` | `interaction_cost` |
| editing input | `VAL-03 edit-input: motions=44 keys/13 ms, retype=120 keys/57 ms` | `interaction_edit` |
| approval | `VAL-03 approval: resolve=1 key/5 ms` | `interaction_approval` |
| reviewing changes | `VAL-03 review-changes: 2 keys/11 ms` | `interaction_review` |
| failure recovery | `VAL-03 failure-recovery: typing=15 keys, recovery=2 keys/20 ms, total 140 ms` | `interaction_recovery` |

The same lines are written to the run's step summary, so they can be read without the
job log. The step fails when fewer than five `VAL-03` lines or two `PERF-03`
cold/warm lines print: a baseline that goes quiet must not read as a green one.

## What these numbers are, and what they are not

- **They are the same contract as the earlier record, on a different machine.** The
  assertions are what the suites guarantee — a query costs fewer keystrokes than a
  walk, a motion fewer than a retype, one key resolves an approval, one chord opens
  the changes view, two keys recover a failed turn, warm `ready_to_type` p95 under
  500 ms — and the printed figures move with the runner. The build-host run in
  `2026-11-11-val03-six-tasks-and-rework.md` reads 152 keys/348 ms against this
  run's 152 keys/331 ms for the same walk; that is the runner, not a product change,
  and no row here is a before/after claim.
- **Mistakes and rework are not re-measured here.** They are counters the engine
  already keeps and the sidebar already paints, defined and pinned in
  `2026-11-11-val03-six-tasks-and-rework.md` (`the_usage_scopes_are_ordered_and_abnormal_rows_come_first`).
  This record adds no operator observation and does not pretend a keystroke count is
  one.
- **The sample set is fixed and named per row**: a 200-Session catalog with target row
  150, a 41-character prompt corrected at its first character, a fixture that fails
  one run on request, a fixture `vcs_status` of two files. Each row ends at a state
  the test asserts on screen or in the engine, which is its termination condition.

## Status of the item

#1910 was closed with the six-task record above; this record does not reopen it and
claims no new acceptance. It replaces "somebody's machine" with a run id for the same
six measurements, which is what a reviewer needs to check them without compiling
Rust.

No `roadmap:` stamp is written: the stamp belongs to the release that first ships
this tree, and the behaviour measured here predates it.
