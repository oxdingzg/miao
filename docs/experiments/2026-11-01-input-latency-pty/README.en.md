# Input echo latency on the Rust TUI (PTY boundary), idle composer

This is the first measurement PERF-01 has had, and it is a **partial** one: it
covers the idle composer, not the sustained streaming load the epic's gate asks
for. It exists because the harness could not start at all.

## Why there were no numbers before

`packages/miao/script/measure-input-pty.py` decided readiness from text only the
legacy TypeScript TUI renders — `tab agents`, `Build` and `Test Model`, cursor
row 27. The default TUI is the Rust one, which renders a `sessions` panel and a
`composer` panel, so every run died with "Session prompt did not become ready"
before its first sample.

Two further facts were needed, both found by capturing the Rust TUI's frames
under a PTY:

1. **Readiness marks**: the panel headers. A TUI that rendered its panels but
   lost its engine is not a valid place to measure, so the engine-failure banner
   (`engine_closed`) has to be excludable.
2. **Focus**: the Rust TUI starts with the sessions panel focused and advertises
   `tab prompt`. Without that keystroke, input never reaches the composer — the
   marker strings the harness types never appear on screen. Sending `tab` first
   makes them appear, which is what this record measures.

The harness now takes `--ready-text` (repeatable, all must appear),
`--ready-absent`, `--ready-min-cursor-row` and `--focus-key`, with the old marks
kept as defaults so the legacy path is unchanged.

## Method

```
packages/miao/script/measure-input-pty.py \
  --binary <miao from source> --directory <fixture workspace> \
  --database <400-message fixture db> --commit <sha> \
  --duration 60 --interval 1 \
  --ready-text sessions --ready-text composer --ready-min-cursor-row 0 \
  --focus-key tab
```

- Boundary: PTY input write → application output bytes, kernel echo disabled, so
  this is the product's own render path, not terminal echo.
- Fixture: `script/seed-input-latency.ts` seeds one session with 400 messages.
- Each sample types a unique marker (`key00000z`, …) and measures until that
  marker is visible on the reconstructed screen.

## Result — 52 samples, 0 timeouts

| p50 | p95 | p99 | max | samples | timeouts |
| --- | --- | --- | --- | --- | --- |
| **5.50 ms** | **10.87 ms** | **16.54 ms** | **18.57 ms** | 52 | 0 |

Against PERF-01's suggested gate (p95 ≤ 50 ms, p99 ≤ 100 ms) this path is
comfortably inside it.

Raw samples: [`raw/rust-tui-idle.jsonl`](raw/rust-tui-idle.jsonl).

## What this does not measure

- **Sustained streaming load.** This run had no live provider: the engine exited
  with "API key or explicit credential source is required", which the screen
  showed as `engine_closed`. Typing echo is rendered locally, so the numbers are
  a real idle-path measurement — but the epic's gate is about typing while output
  streams, which needs a working engine and a model.
- **Large output, 10k-line history and input methods**, which the epic also asks
  for.
- **Startup (PERF-03)**: this measures after readiness, not the time to reach it.
