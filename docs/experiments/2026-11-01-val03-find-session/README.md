# VAL-03 (mechanical half): finding a Session in a 200-Session catalog

Measured 2026-11-01 on the macOS build host with
`crates/miao-tui/tests/interaction_cost.rs`.

VAL-03 asks for six tasks measured on time-to-state, keystrokes, mistakes, and
rework. "Finding a Session" is the one where keystrokes and time-to-state are
fully observable from a script; mistakes and rework are not, and stay with the
operator observation session.

## Method

The PTY harness boots the real `miao-tui` binary against the scripted engine
with a 200-Session catalog (`MIAO_TUI_FAKE_SESSION_COUNT=200`, newest first) and
reaches row 150 two ways:

- **walk** — `j` once per row, then `Enter`: what a list without a query costs.
- **filter** — `/`, the substring `session 150`, then `Enter`.

Keystrokes are counted by construction; the clock starts at the first keystroke
and stops when the target Session's transcript renders.

## Result

| route | keystrokes | time to open |
| --- | --- | --- |
| walk (`j` × 149 + `Enter`) | 150 | 456 ms |
| filter (`/` + `session 150` + `Enter`) | 13 | 48 ms |

Repeatable within a few milliseconds across runs (455–458 ms and 48 ms over
three runs). The query costs **11× fewer keystrokes** and about **9× less time**
for the same outcome on the same surface.

## What this does not cover

- Mistakes and rework: a person mistyping a query or overshooting a walk is the
  part of VAL-03 that needs the operator, so those columns stay empty here.
- The other five tasks (startup, editing input, approval, reviewing changes,
  failure recovery). Startup has its own harness (PERF-03); the rest need
  either their own scripted flow or an operator session.
- This is one synthetic catalog, not a real workspace's Session mix.
