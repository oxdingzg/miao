# Acceptance record — #2862 a running child row carries its age

Follow-up to #2862, whose two answered problems landed in `#2882` (a failed child names its
cause) and `#2883` (a failed child tells its parent). The third problem the report names —
"a normal stop and a stalled child look the same" — was answered for a child that **ended**;
a child that never ends had nothing to look at.

Tree: the pull-request head for branch `feat/issue2862-child-age`, parent `origin/main`
`0ff2239251`. Commands ran on the Linux build host `xx04` from `crates/miao-engine`,
`cargo 1.99.1`.

## What changed

`Store::subagents` reads the event's `recorded_at_ms` beside its `kind` and `data`, and a
`running` row now carries:

- `started_at_ms` — when the child was scheduled;
- `age_ms` — how long it has been running, computed at read time.

An orchestration reading `task_list` can therefore see that a row has been `running` for
forty minutes rather than inferring it from a worktree (`#2862`'s report: the parent could
only discover a stalled child by polling outside the engine).

## The commands

| pin | command (`crates/miao-engine`) | observed |
| --- | --- | --- |
| a running row says when it started and how long it has been running | `cargo test --test subagent a_running_child_row_carries_its_age` | `ok` — the child blocks forever; the row is `running` with `started_at_ms > 0` and an `age_ms` |
| the age is a live figure, not a constant captured at spawn | the same test | `ok` — 80 ms later the age had grown by at least 40 ms |
| the sub-agent suite around it | `cargo test --test subagent` | `16 passed; 0 failed` |
| the crate around it | `cargo test --lib` | `479 passed; 0 failed` |
| lints | `cargo clippy --all-targets -- -D warnings` | `Finished` with no warnings from this crate |

## What this record does not claim

- **No stall threshold.** The row reports age; deciding that 40 minutes of `running` means
  "wedged" depends on what the child was asked to do and on the caller's own budget, so the
  engine does not label a child stalled.
- **No heartbeat.** A child that is quiet between two provider turns and one that has
  deadlocked still have the same row apart from the age; a heartbeat (or a per-child
  last-activity stamp) would be the next step if age alone proves too coarse in practice.
- No Windows or macOS run.

## Version

No `roadmap:` stamp: this tree is in no published release.
