# Acceptance record — AGT-03 net-benefit settlement and the single-agent gate

Item: `AGT-03` (#1968), the settlement half. Tree: pull request #2857, squash
`f5742bab89`, parent `e5d81835b9` — the tip whose own record settled the
task-package half (`2026-11-11-agt03-task-package.md`) and named the
net-benefit measurement as deliberately open. The commands below are the
`cargo` invocations the CI workflow runs from `crates/miao-engine` on the
recorded tree; the observed cells cite this follow-up record's run, whose
only delta on the merged tree is a test-only format fix.

This record claims accounting and enforcement, not a measured benefit: the
experiment that would show delegating actually pays off (per-mechanism
toggles, identical-model arms) stays with `VAL-04` (#1948), exactly as the
task-package record scoped it.

## Criterion — "Track parent and child total cost, merged rework, and wall clock, and finish with a single agent when the benefit is insufficient."

| command | observed |
| --- | --- |
| `cargo test --test delegation_benefit` | ok. 3 passed; 0 failed (CI run 42949382139) |
| `cargo test --lib subagent::` | ok — `judge` unit tests pin positive / no_result / rework verdicts (same run) |
| `cargo test --lib usage::` | ok — `combined` sums covered axes and keeps an axis either side never reported unknown, never zero (same run) |

Pinned by `tests/delegation_benefit.rs`:

- `a_delivered_delegation_settles_positive_with_a_structured_report` — a
  delivered delegation settles a `delegation.settled` row on the parent with
  `verdict positive / delivered`, the child's cost (input 30 beside the
  parent's 100), the combined total (130 input, 15 output), a wall clock
  present, and `recommendation delegate`; the tool result carries a structured
  `report` (status, result, cost, wall clock, a pointer to the child whose
  history stays in its own Session) beside the unchanged `text`, and the
  `subagent_stop` row keeps its pre-existing shape.
- `an_empty_report_reads_no_result_and_the_retry_settles_rework_then_delegation_closes`
  — a child that returns nothing settles `insufficient / no_result`; the one
  sanctioned retry of the same child settles `insufficient / rework` even
  though it delivered (the task was paid for twice); the next delegation in
  that run is refused outright, with the refusal naming rework and telling
  the parent to finish the remaining work in this Session as a single agent.
- `a_failed_child_settles_no_result_but_does_not_close_the_gate` — a child
  whose provider fails settles `insufficient / no_result` with `reason
  failed`, and because that is not rework the gate stays open: a different
  child may still be tried in the same run and its delivery settles positive.

Wall clock reads the recorded start of the delegation to the settlement, and
a pre-timestamp tree leaves it unknown rather than zero. Cost axes follow the
VAL-02 rule: a provider that never reported an axis leaves the combined
figure unknown instead of understated.

## Still open on this item, deliberately

- The benefit experiment itself — whether delegating pays off in quality,
  cost, or latency — needs the VAL-04 (#1948) toggles and identical-model
  arms. Nothing here claims it.
- The verdict's thresholds are deterministic semantics (delivered vs no
  result vs rework), not a calibrated benefit model; tuning them against
  measured outcomes belongs to the experiment above.

## Criterion — link the implementation PR, the acceptance records, and applicable versions

- Implementation: #2857, on top of #2855's package half; the issue closes
  with both.
- Acceptance records: `2026-11-11-agt03-task-package.md` (package half) and
  this file (settlement half), run on tree `314f69dc4c`.
- Versions: no `roadmap:` stamp — `v0.3.61` is the latest published release
  and contains neither tree; the stamp belongs to the release that first
  ships this one.
