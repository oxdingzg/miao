# Acceptance record — PERF-04 idle CPU, process-tree RSS, and leak profiling

Item: `PERF-04`. Tree: PR #2808, squash merge of `feat/perf04-idle-profile`
(final head `3abbf283`) on `main`. The commands below are the cargo
invocations the pull request's CI workflow runs on ubuntu-24.04 from the crate
directory on this recorded tree; the observed cells cite that run (run
42774027390: tui leg green after one clippy iteration on the new harness).

## Criterion — idle CPU, full process-tree RSS, and resource leaks are profiled

The harness samples the whole process tree (the tui plus every child it
spawns) over an idle window: per-process CPU time, RSS, and a convergence
check that the samples settle, with named thresholds in the assertions. The
pins live in the tui crate's tests.

Pinned tests (ok in run 42774027390, tui leg):

- the whole-process-tree sampler covers the tui and its children
- the switch CPU sample converges over the idle window
- the named thresholds hold on the recorded tree

| command | observed |
| --- | --- |
| `cargo test --lib` (tui leg, run 42774027390) | ok |
| `cargo test --tests` (cli leg, same run) | ok |

## Criterion 4 — link the implementation PR, acceptance records, and target versions

- Implementation: #2808.
- Acceptance record: this file.
- Versions: applies from the release that first ships the merged tree; stamped
  per the repository convention when that release cuts.

**Recorded open, not hidden:** longer-soak leak windows (hours, not seconds),
cross-platform RSS sampling beyond the linux CI leg, and a persisted profile
artifact for trend comparison stay open.
