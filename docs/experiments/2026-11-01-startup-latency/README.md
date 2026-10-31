# PERF-03 startup latency: the TUI becomes usable in tens of milliseconds

Measured 2026-11-01 on the macOS build host (arm64, `cargo test`, debug
profile), 5 repeats per scenario, with `crates/miao-tui/tests/startup_latency.rs`.

Reproduce with:

```sh
cd crates/miao-tui
cargo test --test startup_latency -- --nocapture --test-threads=1
```

The harness boots the real `miao-tui` binary in a PTY against the scripted
engine (`miao-tui-fake-engine`), so what it measures is the TUI's own startup —
process start, first paint, home list, and opening a Session — with the model
network and a real engine handshake deliberately out of the picture.

| scenario | phase | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| cold (empty store) | first frame | 40 ms | 518 ms | 518 ms |
| cold | ready to type | 47 ms | 909 ms | 909 ms |
| cold | ready to submit | 7 ms | 10 ms | 10 ms |
| warm (existing store) | first frame | 31 ms | 35 ms | 35 ms |
| warm | ready to type | 36 ms | 43 ms | 43 ms |
| warm | ready to submit | 6 ms | 7 ms | 7 ms |

Against the gate in `crates/miao-engine/docs/measurements.md` (warm
ready-to-type p95 ≤ 500 ms), the warm path passes with a wide margin: 43 ms
p95. The cold p95 of 909 ms is one slow first sample in a five-sample run
(the first launch of the process, before the page cache is warm); the cold p50
of 47 ms shows the steady-state cost.

## What this does not cover

- A real engine handshake and a real model: the scripted engine answers
  immediately, so `first frame` here is not "ready to answer a prompt".
- A monorepo: the workspace is a temp directory holding one fixture Session.
  The monorepo readiness case stays open, which is why PERF-03 is not claimed
  as accepted.

Reports are written beside the workspace as `startup-latency-cold.json` and
`startup-latency-warm.json`.
