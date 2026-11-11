# Acceptance record — a failed delegated child names its cause

Item: `#2862` problems two and three. Tree: branch
`fix/issue2862-provider-failure-visibility` on `origin/main` `bc9d8bc399`, which
is the pull request's own head (`#2882`). Problem one — honouring a
`Retry-After` the retry window cannot hold — landed separately as `#2874` and is
recorded in `2026-11-11-retry-after-grace.md`; this branch was rebased onto it
and a duplicate implementation was dropped rather than merged beside it.

The defect: a delegated child whose provider turn failed closed its run as
`stop_failure`, and the parent waiting on `task` received
`report.status: "failed"` with an empty result. The provider's own words — the
`429 · retry-after: 30s` body, or `no response headers before the request
deadline` — existed only in a `stop_failure` event written *after*
`run.finished`, so nothing a parent reads carried them. An orchestrator running
several children had to notice a stalled one by polling its worktree.

## Criterion — "A waiting parent reads the child's failure terminal state, including why."

`run.finished` now carries `message` beside `reason`, written by
`finish_run_fenced_with_message` at the provider-turn close. That single
terminal event is what three readers consume:

- the settlement `report` a waiting `task` returns (`report.status` plus
  `report.message`);
- the parent's `subagent_stop` row, which `task_result` reads, so a failed
  background child answers with its cause instead of `(no output)`;
- `children`, whose `run` object now states `state`, `reason` and `message`.

| what | command | observed |
| --- | --- | --- |
| the cause reaches the waiting parent's report | `cargo test --test delegation_failure a_failed_child_reports_its_cause_to_the_waiting_parent` | ok — `report.status == "failed"` and `report.message` carries the `429` body |
| the parent's journal and the child's run both name it | `cargo test --test delegation_failure a_failed_child_reports_its_cause_to_the_waiting_parent` | ok — `subagent_stop.reason == "failed"` with a `message`, and the child's `run.finished` says `failed` with the same cause |
| the failure terminal state is queryable | `cargo test --test delegation_failure a_failed_child_is_queryable_with_its_cause` | ok — `children` reports `run.state == "failed"`, `run.reason == "failed"`, `run.message` carrying the `429` body |
| a child that delivered is not dressed up as a failure | `cargo test --test delegation_failure a_child_that_delivered_reports_a_completion_and_no_cause` | ok — `run.reason == "completed"` and `run.message` null |
| the engine crate still builds and its suites pass | CI workflow `ci`, run `42998196848` | see the run for the per-shard verdicts; local Rust compilation is blocked on this workstation (`~/.config/miao/no-local-cargo.sh`), so CI is the compile and test authority for this record |

The commands above are run from `crates/miao-engine`.

## Problem three, and what stays open

The criterion in `#2862` asks that an idle child's last result be queryable so
an orchestrator can tell "delivered" from "stuck". The `reason`/`message` pair
added here answers the part that caused the reported stalls: a child whose
provider turn failed is now distinguishable from one that finished, and readable
with its cause from `children`, `subagent_stop` and the settlement report.

What stays open: a delivered child's **result summary** is not part of the
`children` read — that row still states the boundary and the count, not the
child's last assistant text. A full "last result" field belongs to the children
read rather than to this failure path, so this record claims the failure
vocabulary only.

## What this record does not claim

- No live provider run: the two `stop_failure` rows quoted in the issue were not
  re-produced against a real endpoint. The tests drive the engine's own run
  close with a scripted provider failure, which is where the cause is recorded.
- No release stamp: this tree is in no published release.
