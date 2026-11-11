# Acceptance record — AGT-03 delegate only when net benefit pays off

Item: `AGT-03`. Tree: PR #2857, squash merge of `feat/issue1968` on `main`
(the branch also carried #2855's goal/acceptance conditions). The commands
below are the cargo invocations the pull request's CI workflow runs on
ubuntu-24.04 from the crate directory on this recorded tree; the observed
cells cite that run's engine shards (green after the format/clippy fixes).

## Criterion — delegate only when the net benefit pays off, with structured reports

A `task` call states the child's goal and its acceptance conditions; the
engine settles the delegation against its net benefit — a delegation that does
not pay off is refused rather than launched — and a settled delegation records
a structured report instead of a free-text summary.

Pinned tests (green in the PR's CI run):

- the net-benefit settlement refuses a delegation that does not pay off
- a settled delegation records its structured report
- the task call states the child's goal and acceptance conditions (#2855)

| command | observed |
| --- | --- |
| `cargo test --test delegation_benefit` (engine shards) | ok |
| `cargo test --lib` (engine unit leg) | ok |

## Criterion 4 — link the implementation PR, acceptance records, and target versions

- Implementation: #2857 (+ #2855).
- Acceptance record: this file.
- Versions: applies from v0.3.62 onward (shipped in this release).

**Recorded open, not hidden:** a real multi-agent benefit benchmark (net
benefit measured against wall-clock/cost across many runs) stays open.
