# Acceptance record — JOB-04 backpressure signal

Item: `JOB-04`. Tree: `c1b981f229`. Commands ran on the Linux build host
(`~/miao-acc-1964`, clean checkout of the branch head) from `crates/miao-engine`
and `crates/miao-tui`. This record closes the gap the 2026-11-01 JOB-04 record
left open: an engine backpressure signal with no named state in the TUI.

## Criterion — the engine names backpressure and the status line repeats it

| surface | what is pinned | command | observed |
| --- | --- | --- | --- |
| engine signal | `progress.rs` raises a `backpressure` edge when a subscriber's queued depth crosses 256 frames and clears it below 32 (hysteresis); the signal frame inherits the session id so stdio delivers it to the subscribed client; the queued depth is counted by the `Subscriber` itself (`Arc<AtomicUsize>` incremented on send, decremented on recv/try_recv) because tokio's sender has no `len()` | `cargo test --lib progress::` (crates/miao-engine) | `7 passed; 0 failed` |
| edge refusal | the oversized-call-hierarchy style budget refusal for the signal path stays exact (the backpressure edge test) | `cargo test --lib backpressure` (crates/miao-engine) | `1 passed; 0 failed` |
| status line | the embedded transport synthesizes the `backpressure` progress frame from its notice-queue depth counter and `App::provider` intercepts it before the run-id filter; `update_status` names `Engine backlog · N queued`, ranks it below operator blocking (`needs approval` wins) and above the live phase, and `EngineFailure` clears it | `cargo test --lib backpressure` (crates/miao-tui) | `5 passed; 0 failed` (includes `an_engine_backlog_is_named_in_the_status` and `an_operator_blocking_wait_outranks_a_backpressured_engine`) |

## Criterion — deadline and silence limits do not refill the retry budget

| surface | what is pinned | command | observed |
| --- | --- | --- | --- |
| retry window | a deadline failure does not refill the retry window and a spent window refuses a stream reconnect without a new budget (`a_deadline_failure_does_not_refill_the_retry_window`, `a_spent_window_refuses_a_stream_reconnect_without_a_new_budget` in `provider.rs`) | `cargo test --lib retry` (crates/miao-engine) | `21 passed; 0 failed` |

## Still open

- The wider JOB-04 acceptance surface beyond the two gaps above (full
  cancellation matrix over slow tools) stays with `2026-11-01-job04.md`'s
  accepted scope; nothing here retracts it.
- tmux/Windows Terminal real-terminal behaviour of the new status text is not
  exercised on this host.
