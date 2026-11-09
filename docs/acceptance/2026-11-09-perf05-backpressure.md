# Acceptance record — PERF-05 backpressure, event batching, and prioritized control

Item: `PERF-05`. Tree: `4fef705fe7` (branch `test/perf05-backpressure`; `90920cf23d`
pins the fan-out's stress behaviour, `9f6f812753` gives the in-process transport's
control lane a fixed poll order, `f810046d23` pins a cancel landing inside a pouring
delta flood). The commands below are the cargo invocations the pull request's CI
workflow runs from the crate directory on this recorded tree; the observed cells
cite that run, and a Linux build-host run cross-checks them.

## Criterion — backpressure is enforced and stress produces no unexpected Session terminations

| command | observed |
| --- | --- |
| `cargo test --lib progress::` (crates/miao-engine) | ok. 10 passed; 0 failed (CI run RUNID, engine shard 1) |

Pinned by tests in `progress.rs`:

- `concurrent_batches_survive_a_backpressured_reader_intact` — four producers ×
  1,000 one-KiB frames race a keeping-up reader on its own thread while two readers
  stall: every producer's frames arrive whole and in emission order for every
  reader, and the stall costs exactly one `backpressure` report per stalled reader
  at the reported depth (256).
- `a_sessions_deltas_arrive_in_emission_order_with_their_text_intact` — 600 deltas
  normalized from the provider's own framing replay in emission order with their
  text intact, and the backlog report rides along without displacing or rewriting a
  fragment: batching never alters semantics or ordering.
- `sessions_streaming_concurrently_are_not_cut_short` — eight Sessions stream 400
  frames each against two readers: no reader is pruned and every Session's frames
  are all there. The only way this fan-out ends a Session's egress is a failed
  send, so a storm that prunes nothing terminates nothing.
- The JOB-04 pins (`a_stalled_subscriber_receives_every_frame`, the hysteresis
  edges, the session-carrying report) stay green on the same tree.

Bounded limits the issue folds into this criterion, already enforced elsewhere and
unchanged here: large payloads externalize to content-addressed blobs past the
64 KiB threshold (`blob.rs`, DATA-04); the durable ledger writes through one
serialized WAL writer; slow subscribers and broadcast lag are named by the JOB-04
edge signal instead of being dropped or silently ringed.

## Criterion — user input, cancellation, and approvals outrank the rendering flood

| command | observed |
| --- | --- |
| `cargo test --test embedded_stream` (crates/miao-tui) | ok. 3 passed; 0 failed (CI run RUNID, tui job) |
| `cargo test --lib backpressure` (crates/miao-tui) | ok. 6 passed; 0 failed (same run) |

- `9f6f812753` closes the gap the issue names: the in-process transport's loop
  polled its lanes with the default fair `select!`, so under a delta flood every
  loop iteration was a random pick among ready lanes and a cancel or an approval
  answer waited on the scheduler's coin behind unbounded rendering frames. The
  lanes now poll in a fixed order — control requests first, then the durable-event
  tick (an `approval.requested` prompt among them), then the rare config report,
  and the notice backlog last.
- `a_cancel_lands_ahead_of_a_pouring_delta_flood` drives the real in-process
  runtime against a scripted SSE peer that floods sixty-four thousand deltas; five
  hundred frames in — past the reported backpressure mark — the test cancels: the
  control round trip is bounded (5 s), the run settles `interrupted` instead of
  riding the flood to completion, and no failure or resync tears the transport
  down.
- `keys_still_execute_while_an_engine_backpressure_flood_pours_in` — keystrokes
  land in the composer mid-flood while the streamed draft still folds in whole
  around them, and Esc during the backlog still issues the engine Cancel request.
- `an_operator_blocking_wait_outranks_a_backpressured_engine` — an approval wait
  outranks the backlog in the status strip (JOB-04's pin, unchanged).

## Build-host cross-check

The same commands ran on the Linux build host (`~/miao-acc-1999`) before the push:
`cargo clippy --locked --all-targets -- -D warnings` ok in both crates,
`cargo fmt --check` ok, and the suites above printed the same pass counts.

## Criterion — link the implementation PR, acceptance records, and applicable versions

- Implementation: #2785, branch tip `4fef705fe7` after the fmt and clippy repairs.
- Acceptance record: this file.
- Versions: applies from the release that first ships the merged tree; stamped per
  the repository convention when that release cuts.

## Still open

- Real-client latency, quality, and cost evidence beyond the bounded-latency pin
  (`crates/miao-engine/docs/measurements.md` work): this record's evidence is
  behavioural, not a benchmark.
- Real-terminal behaviour of the backlog status line under flood (tmux/Windows
  Terminal), carried open from the JOB-04 record.
- A slow consumer that reads haltingly (a hung or throttled PTY reader) rather
  than an idle queue stays unexercised here.
