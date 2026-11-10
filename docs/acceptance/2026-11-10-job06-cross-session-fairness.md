# Acceptance record — JOB-06 cross-session concurrency fairness and resource bounds

Item: `JOB-06`. Tree: `b298679b84` (branch `feat/job06-concurrency-bounds`,
pull request #2805: the fair pools and the `resources` snapshot land in
`fd5eb94ad3`, the pins in `cde3d73d76`, and the review fixes through
`b298679b84`). The commands below are the cargo invocations the pull request's
CI workflow runs on ubuntu-24.04 from the crate directory on this recorded
tree; the observed cells cite that run.

## Criterion 1 — Enforce observable upper limits on providers, subagents, terminals, and LSP instances

| command | observed |
| --- | --- |
| `cargo test --test resource_bounds` | ok. 4 passed; 0 failed; 0 ignored (CI run 42774315407, engine shard 4) |

Pinned by tests in that suite:

- `resources_reports_limits_shares_and_queue_accounting` — `Runtime::resources()`
  names every bound while the pools are loaded: drains 8, jobs 4 with a
  per-Session share of 2 (two slots active, the share-gated job counted as
  queued, admission and queue-wait accounting present), terminals 32 with a
  per-Session share of 8, LSP servers 8.
- `a_session_at_its_share_leaves_free_slots_to_other_sessions` — a Session
  asking for three jobs holds two: the pool's own counters read active 2 with
  one queued at the share, a second Session's job takes a free slot
  immediately (active 3, queued 1), and the hog's third durable row still has
  not started.

The limits themselves are named constants: `DRAIN_SLOTS`, `JOB_SLOTS`,
`JOBS_PER_SESSION`, `SUBAGENT_SLOTS` with `subagent::CONCURRENCY_LIMIT` /
`subagent::PER_SESSION_LIMIT` in `crates/miao-engine/src/runtime.rs` and
`crates/miao-engine/src/subagent.rs`, `GLOBAL_LIMIT` / `PER_SESSION_LIMIT` in
`crates/miao-engine/src/terminal.rs`, and `SERVER_LIMIT` in
`crates/miao-engine/src/lsp.rs`. A fair share queues, it never rejects; the
hard fleet limits (the jobs registry cap, the terminal registry, the LSP plan)
keep rejecting with a message that names the limit.

## Criterion 2 — Ensure long-running tasks do not block input admission or user control in other Sessions

| command | observed |
| --- | --- |
| `cargo test --test resource_bounds` | ok (same run: the saturated-pool control-lane pin holds) |

- `saturated_jobs_do_not_block_another_sessions_input_or_interrupt` — while a
  Session's jobs hold their share of the pool, another Session's prompt is
  admitted and finishes (`run.finished` `completed`), and a parked Session
  interrupts promptly (`run.finished` `interrupted`) under the same load.
- `a_share_gated_job_starts_when_the_sessions_own_job_settles` — queueing,
  not rejection: a Session's share-gated job starts as soon as one of that
  Session's own jobs settles, and all three jobs complete.

## Criterion 3 — Record queue latency, starvation metrics, RSS memory usage, and file descriptor curves under stress tests

**Not accepted yet.** `crates/miao-engine/tests/fairness_measurement.rs` is the
harness — `cargo test --release --test fairness_measurement -- --ignored
--nocapture` drives a hog Session plus four worker Sessions into the shared
job pool, samples `resources()` queue accounting, RSS, and the fd count every
200 ms, and asserts every worker job completes — but no recorded run of it
exists yet, so there are no numbers to cite. Staying open until a run lands
here.

## Criterion 4 — Link implementation PR, records, and applicable versions

Implementation: pull request #2805 on the tree above, with the design decision
in `crates/miao-engine/docs/adr/0021-cross-session-fair-pools.md`. This record
is the acceptance evidence for that tree. A release stamp
(`roadmap: CODE done in vX.Y.Z`) waits for the release that ships the tree.
