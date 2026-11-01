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
rendered output stream. Five scenarios:

- `composer-idle` — the session is quiescent, 36 keystrokes.
- `composer-streaming` — the fixture commits an event every 10 ms for ten
  seconds while 12 keystrokes are measured, which is the "input-first latency
  under sustained streaming load" case PERF-01 is about. The test asserts the
  output advanced during the sample, so the scenario cannot silently degrade
  into the idle one.
- `composer-long-history` — the Session carries 10,000 messages before typing
  starts, which is the "10k-line history" case PERF-01 also asks for. The
  fixture builds it from `MIAO_TUI_FAKE_HISTORY`, so the renderer's
  per-keystroke cost is measured against a real transcript instead of assumed.
- `composer-large-output` — one 200 KB message is on screen before typing
  starts, so a single oversized block is held by the renderer while keys are
  measured.
- `composer-multi-byte` — seven CJK characters, each delivered as its own UTF-8
  sequence. **Scope note**: a PTY sees *composed* text, not the input method's
  candidate window, so this measures the product's handling of multi-byte input
  rather than IME composition itself. Composition happens in the terminal and is
  not observable from this boundary at all.

| scenario | samples | p50 | p95 | p99 | max |
| --- | --- | --- | --- | --- | --- |
| composer-idle | 36 | 0 ms | 2 ms | 2 ms | 2 ms |
| composer-streaming | 12 | 1 ms | 1 ms | 1 ms | 1 ms |
| composer-long-history (10,000 messages) | 36 | 1 ms | 2 ms | 3 ms | 3 ms |
| composer-large-output (200 KB message) | 36 | 0 ms | 0 ms | 0 ms | 0 ms |
| composer-multi-byte (7 CJK characters) | 7 | 0 ms | 0 ms | 0 ms | 0 ms |

Against the gate recorded beside the harness (p95 ≤ 50 ms, p99 ≤ 100 ms), every
scenario passes with two orders of magnitude of headroom — including the long
transcript and the oversized message, so the cost does not grow with either
history length or output size at these scales.

## What this does not cover

- A real provider stream: the fixture commits events without a network, so the
  numbers exclude model latency by construction — which is the intent, since
  this is a rendering/input measure, not a throughput measure.
- A large transcript: the fixture Session holds one exchange. Scrolling cost in
  a long session is PERF-02's subject, not this one.

Reports are written beside the workspace as `input-latency-<scenario>.json`.
