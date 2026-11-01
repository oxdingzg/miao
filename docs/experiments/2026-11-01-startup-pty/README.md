# Startup to ready-to-type on the Rust TUI (PTY boundary)

PERF-03 had no measurement entry point, so it had no numbers. This adds one and
records the first results — which say the warm gate is **not met**, and that the
absolute value is dominated by measurement conditions rather than by the code.

## Method

`packages/miao/script/measure-startup-pty.py`:

- "Ready to type" is not "a frame was painted": after the `sessions` and
  `composer` panels appear the harness sends one character and stops the clock
  when that character shows up in the rendered output.
- `--mode cold` gives every run a fresh HOME and a fresh copy of the fixture
  database; `--mode warm` reuses both after one unrecorded warm-up run.
- The PTY is made the child's **controlling terminal**. Without it the Rust TUI
  cannot open `/dev/tty`, exits with `Inappropriate ioctl for device`, and the
  harness records nothing at all.
- Each sample records `engineClosed`, because a TUI that painted but lost its
  engine still accepts typing: timing alone cannot tell a healthy startup from a
  degraded one.

Artifact: release `~/.miao/bin/miao` 0.3.23 (`sha256 c139faec33a012fb…`).
Fixture: one Session with 400 messages (`script/seed-input-latency.ts`).
Boundary: process spawn to the first keystroke visible in rendered output;
kernel echo disabled.

## Results

| condition | n | ready p50 | ready p95 | engineClosed |
| --- | --- | --- | --- | --- |
| cold, no engine | 3 | 3,579 ms | 3,579 ms | true |
| warm, no engine | 5 | 3,765 ms | 3,924 ms | true |
| warm, engine present (run A) | 3 | 1,783 ms | 1,783 ms | false |
| warm, engine present (run B) | 5 | 3,029 ms | 3,486 ms | false |

Two conclusions, and the second matters as much as the first:

1. **The gate is not met.** PERF-03 suggests warm ready-to-type p95 ≤ 500 ms;
   the best sample here is 1,173 ms and the worst 3,924 ms. Even the most
   favourable run is above the gate.
2. **The number is not yet a property of the code.** The same condition produced
   1,783 ms and 3,029 ms in two consecutive runs; this machine was concurrently
   building, running CI jobs and serving several sessions. PERF-03's own wording
   asks for a *pinned* machine, and this is why: on a loaded host the figure
   moves by more than the difference between the two conditions below.

What is stable across runs: the TUI spends most of its time **before the first
frame** (painted p50 tracks ready p50 within ~250 ms in every run), so this is
startup cost, not input-acceptance cost. And a missing engine roughly **doubles**
the painted time.

Raw samples: [`raw/`](raw/).

## What this does not measure

- **A quiet/pinned machine** — which is what a defensible p95 needs.
- **A monorepo**: the fixture workspace is a small directory.
- **Network and model waits**: the fixture has no provider.
- **Ready-to-submit and first semantic output**: both need a live model turn.
- **Other platforms**: one machine, one artifact.
