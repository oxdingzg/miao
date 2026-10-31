# PERF-01 input latency: first-character echo stays at 1 ms while a turn streams

Measured 2026-11-01 on the macOS build host (arm64, `cargo test`, debug
profile) with `crates/miao-tui/tests/input_latency.rs`.

Reproduce with:

```sh
cd crates/miao-tui
cargo test --test input_latency -- --nocapture --test-threads=1
```

The harness boots the real `miao-tui` binary in a PTY, then measures, per
keystroke, the time from writing the byte to that character appearing in the
rendered output stream. Two scenarios:

- `composer-idle` — the session is quiescent, 36 keystrokes.
- `composer-streaming` — the fixture commits an event every 10 ms for ten
  seconds while 12 keystrokes are measured, which is the "input-first latency
  under sustained streaming load" case PERF-01 is about. The test asserts the
  output advanced during the sample, so the scenario cannot silently degrade
  into the idle one.

| scenario | samples | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| composer-idle | 36 | 0 ms | 2 ms | 2 ms | 2 ms |
| composer-streaming | 12 | 1 ms | 1 ms | 1 ms | 1 ms |

Against the gate recorded beside the harness (p95 ≤ 50 ms, p99 ≤ 100 ms), both
scenarios pass with two orders of magnitude of headroom.

## What this does not cover

- A real provider stream: the fixture commits events without a network, so the
  numbers exclude model latency by construction — which is the intent, since
  this is a rendering/input measure, not a throughput measure.
- A large transcript: the fixture Session holds one exchange. Scrolling cost in
  a long session is PERF-02's subject, not this one.

Reports are written beside the workspace as `input-latency-<scenario>.json`.
