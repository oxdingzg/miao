# Continuous committed-event refresh regression

The Rust TUI bridge scheduled a snapshot 150 ms after the most recent change.
Every committed message, tool, or run event reset that time. Sustained activity
could therefore postpone the visible Session status and transcript indefinitely.

The bridge now retains the first pending change's deadline. Later committed
activity and successful control requests coalesce into that refresh without
pushing it back. The deadline is cleared when a refresh runs or a Session opens;
the next change starts another refresh window. Snapshot and journal projection
remain authoritative, and the UI does not create another Session reducer.

`tests/stream_refresh.rs` drives the actual `engine::attach` bridge through the
existing executable engine stand-in. Its opt-in stream sends committed events
every 10 ms for up to 10 seconds, and snapshots expose an advancing transcript
and active run. The test requires three distinct active snapshots within three
seconds, then closes the request channel and observes bridge shutdown. Fixture
stdout is locked for whole frames so concurrent stream and RPC responses cannot
interleave their JSON. No global environment or process mock is used.

Before the fix, the regression timed out after three seconds without the
required snapshots. After the fix, the regression passed in 0.51 seconds during
the full crate run. This is a regression-test duration, not a measured input
latency or a human usability result.

On the macOS build host, from `crates/miao-tui`:

```sh
cargo test
cargo clippy --all-targets -- -D warnings
```

All 188 tests passed: 165 unit, 13 real PTY smoke, one continuous-refresh, and
nine transport tests. Formatting and diff checks also passed. No paid provider,
release installation, or user Session was involved.

This covers continuous committed activity. Raw token-progress rendering,
keyboard latency distributions, memory bounds, and human state-identification
measurements remain separate PERF-01/VAL-03 work. RPC or projection delays can
still exceed the coalescing interval; this change prevents event traffic from
continually moving the deadline, rather than promising a total 150 ms UI SLA.
