# Acceptance record — COST-05 default tracing overhead is capped

Item: `COST-05`. Tree: `main` including #2684. Commands ran on the Linux build
host (`x86_64-unknown-linux-gnu`) from `crates/miao-tui/` at that tree, using
PERF-04's real-process resource harness.

## The criterion this record accepts

**Default tracing overhead is capped so a per-second refresh does not raise
idle CPU.** The cap is structural: this build has no tracing facility and no
periodic sampling timer — the render loop parks on events (a parked loop is
what let the engine tasks stream; a spinning refresh would have starved them),
so the default overhead an idle session pays is the idle wait itself.

The harness measures the real binary against the scripted engine and samples
`ps` over a quiet three-second window:

| state | cpu over 3 s | RSS | fds |
| --- | --- | --- | --- |
| idle TUI | **0 ms** | 36.3 MB | 15 |
| streaming TUI | **0 ms** | 38.8 MB | 15 |
| spawned engine (2 processes) | **0 ms** | 39.1 MB total | 18 |

The harness's own bound fails anything busier than a full core over the
window; the measured figure is zero, so there is no per-second refresh burn to
cap and no knob to tune — the honest reading of "capped by default".

## Suites

| what | command | observed |
| --- | --- | --- |
| idle and streaming resource harness | `cargo test --test idle_resources` | `3 passed; 0 failed`, 5.3 s |

## What this record does not claim

- The Session/cursor-bound log export and the redacted diagnostic bundle are
  this item's remaining criterion — separate record.
- Windows unexercised, as before.
