# Acceptance record — VAL-03 reviewing changes

Item: `VAL-03`. Tree: `a1239dff43`. Criterion, quoted from the issue:

> Measure six user tasks: startup, finding a session, editing input, approval,
> reviewing changes, and failure recovery

> Record time-to-state, keystrokes, mistakes, and rework

`2026-11-01-offline.md` recorded four of the six tasks and named the fifth —
reviewing changes — as **not accepted**, because the PTY harness never delivered
the chord to the running binary. This record is that missing run.

## Reviewing changes: keystrokes and time to the list

| criterion | command | observed |
| --- | --- | --- |
| reviewing changes: time to render | `cd crates/miao-tui && cargo test --locked --test interaction_review -- --nocapture` | `VAL-03 review-changes: 2 keys/17 ms` |

The test starts the real `miao-tui` binary in a 120×30 pty against the fixture
engine, opens the Session (`--session ses_a`), sends `ctrl+x` then `g`, and times
the wait until `src/parser.rs` paints in the change list. Two keys is the chord;
17 ms is from the keystroke to the list being on screen.

## What this number does and does not cover

- It covers the interaction cost: one chord, and the list is up before a frame
  could be perceived.
- It does **not** include the engine's read of a real repository: the fixture
  answers `vcs_status` with two files. A repository scan is a different
  measurement and belongs with the engine's own VCS numbers, not with VAL-03's
  interaction baseline.
- The five other tasks keep the numbers in `2026-11-01-offline.md` (finding a
  Session, editing input, failure recovery), `interaction_approval.rs`
  (`VAL-03 approval: resolve=1 key/…`) and `startup_latency.rs` (cold and warm
  start).

Still unaccepted after this record: **mistakes and rework** are operator
observations; no harness produces them, and this record does not pretend a
keystroke count is one. The six tasks have a mechanical baseline each; the
"real operator observations and before/after data" the issue asks for remain
with a human session.
