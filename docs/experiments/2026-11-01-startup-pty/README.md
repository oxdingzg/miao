# Startup to ready-to-type on the Rust TUI (PTY boundary)

PERF-03 had no measurement entry point at all, so it had no numbers. This adds
one and records the first result: **the warm ready-to-type gate is not met**.

## Method

`packages/miao/script/measure-startup-pty.py`:

- "Ready to type" is not "a frame was painted": after the `sessions` and
  `composer` panels appear the harness sends one character and stops the clock
  when that character shows up in the rendered output. A build that paints a
  composer but cannot accept input is not counted as ready.
- `--mode cold` gives every run a fresh HOME and a fresh copy of the fixture
  database; `--mode warm` reuses both after one unrecorded warm-up run.
- The PTY is made the child's controlling terminal. Without that, the Rust TUI
  cannot open `/dev/tty` and exits with `Inappropriate ioctl for device` before
  painting — which is what made the first attempts return no samples at all.

Artifact: the release binary `~/.miao/bin/miao` 0.3.23
(`sha256 c139faec33a012fb…`). Fixture: one Session with 400 messages
(`script/seed-input-latency.ts`). Boundary: process spawn to the first keystroke
visible in rendered output; kernel echo disabled; excludes terminal presentation.

## Result

| mode | n | ready p50 | ready p95 | painted p50 | painted p95 |
| --- | --- | --- | --- | --- | --- |
| cold | 3 | 3,579 ms | 3,579 ms | 3,317 ms | 3,317 ms |
| **warm** | 5 | **3,765 ms** | **3,924 ms** | 3,488 ms | 3,650 ms |

PERF-03's suggested gate is **warm ready-to-type p95 ≤ 500 ms**. On this
machine, with this artifact, the measured value is **3,924 ms — about 7.8×
the gate**. Cold and warm are nearly identical, and most of the time is spent
before the first frame is painted at all, so the cost is in startup rather than
in accepting the first keypress.

Raw samples: [`raw/`](raw/).

## What this does not measure

- **A monorepo.** The fixture workspace is a small directory, so workspace
  scanning cost is not represented.
- **Network waits.** The fixture has no provider, so model/connection time is
  excluded by construction; the epic asks for it to be listed separately.
- **Ready-to-submit and first semantic output.** Both need a live model turn.
- **Other platforms.** One machine, one artifact.
