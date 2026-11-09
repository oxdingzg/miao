# Acceptance record — JOB-03 declarative read parallelism and write serialization

Item: `JOB-03`. Tree: `a8dca49d0a` (branch `test/job03-declarative-parallel`, two commits:
`52d0fdb929` reports the observed peak in-flight concurrency for the read batch,
`a8dca49d0a` pins the declarative scheduling behaviour in tests). The commands below are the cargo invocations the pull request's CI workflow
runs on ubuntu-24.04 from the crate directory on this recorded tree; the
observed cells cite that run, and a Linux build-host run cross-checks them
when the host is idle.

## Criterion 1 — execute only declared read operations in parallel when resources do not conflict

| command | observed |
| --- | --- |
| `cargo test --test read_batch` | ok. 13 passed; 0 failed (CI run 42640414446, engine shard 4) |

Pinned by tests in that suite:

- `native_reads_dispatch_together_and_project_results_in_call_order` — four declared
  reads (`read_file`×2, `list_files`, `glob`) batch with `concurrency=4`; all four
  `tool.dispatched` precede the first `tool.completed`; results project in call order
  with the right contents.
- `batch_membership_follows_declarations_not_names` — batch membership follows the
  declaration, not the tool name.
- `long_read_prefixes_keep_the_bounded_parallel_prefix_and_ordered_remainder` — 20
  reads split into a bounded 16-call prefix (`concurrency=4`) plus an ordered
  remainder; 20 results, every one in request order.
- `an_undeclared_call_ends_the_declared_read_prefix` — an undeclared call ends the
  declared read prefix and settles serially behind the batched reads.
- `runtime_owned_session_reads_are_barriers_not_local_executor_batch_members` —
  runtime-owned reads (recall) are barriers, not batch members; no batch event.
- `denied_read_keeps_policy_result_and_serial_admission` — a policy-denied read keeps
  its policy result and serial admission.
- `cancellation_settles_every_dispatched_read_without_unknown_results` — cancellation
  settles every dispatched read, never an unknown result.

## Criterion 2 — serialize conflicting write operations and settle results in deterministic order

- `overlapping_write_targets_settle_in_request_order_deterministically` — two writes
  to the same path settle strictly in request order (`one` < `two` < `three`), no
  batch event either way, the last write wins on disk and in the projected history.
- `a_declared_write_conflicts_with_the_batch_and_stays_serial` — a declared write
  conflicts with the batch and stays serial.
- `mixed_turn_keeps_write_then_read_barrier` — the write→read barrier holds inside a
  mixed turn; no batch event.
- `partitions_a_mixed_turn_into_a_read_prefix_and_a_serial_tail` — a mixed turn
  partitions into a read prefix and a serial tail.

| command | observed |
| --- | --- |
| `cargo test --test read_batch` | ok. 13 passed; 0 failed (same run: writes settle in request order, no batch event) |

## Criterion 3 — report true concurrency overlap, wall-clock gains, and total costs, without treating RwLock as parallel execution

`52d0fdb929` adds the overlap receipt: `execute_read_batch` gauges reads as they enter
and leave `execute_prepared` and settles a `tool.parallel.finished` event carrying the
admitted count, the declared bound, and the observed peak in-flight — the ledger
distinguishes a genuinely parallel batch from a serialized one that was merely
admitted.

- `batched_reads_report_observed_peak_concurrency_above_one` — for a four-read batch:
  `tool.parallel.started` precedes `tool.parallel.finished`, `admitted=4`,
  `concurrency=4`, and `peak_in_flight >= 2` asserted by counter, not by timing.
- `batched_reads_settle_and_report_the_identical_bound_without_stopping_the_run` — the
  bound is reported identically and the run continues past the batch.

| command | observed |
| --- | --- |
| `cargo test --test read_batch` | ok — `batched_reads_report_observed_peak_concurrency_above_one` passes with the entry yield (same run) |

**Recorded open, not hidden:** a real wall-clock overlap benchmark and total-cost
accounting for a parallel turn are not measured here. They hang on the ablation and
default-toggle work tracked as VAL-04 (#1948), which is this item's declared
dependency. This record substitutes the deterministic peak-in-flight counter for the
overlap measurement and leaves wall-clock gains and cost totals explicitly open
rather than claimed.

## Full-suite result

JOB-03 touches `runtime.rs` scheduling and every engine suite exercises it, so the
whole integration set ran, not only the new suite (#1969's lesson: shard CI runs
everything, and a new suite passing does not prove the old ones still do):

| command | observed |
| --- | --- |
| `CARGO_INCREMENTAL=0 cargo test --no-run --tests` | ok on all four engine shards (CI run 42640414446) |
| `cargo test --test read_batch` | ok. 13 passed; 0 failed |
| `CARGO_INCREMENTAL=0 cargo test --tests` | ok — the integration set is green across shards 1-4; shard 4 alone ran 57 suites ok (blackbox needed one rerun: the npm mirror 5xx'd during its install, unrelated to this tree) |

## Criterion 4 — link the implementation PR, the acceptance records, and applicable versions

- Implementation: #2764, squash commit `85a0ff19b6` on `main` (the branch tip was
  `4dc873f5f4` after two rebases; the yield fix is its last commit).
- Acceptance record: this file, run on tree `a8dca49d0a`.
- Versions: applies from the release that first ships the merged tree; stamped per the
  repository convention when that release cuts.
