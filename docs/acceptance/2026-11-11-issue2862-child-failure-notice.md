# Acceptance record — #2862 a failed child tells its parent, and a row says why

Issue: #2862 (a sub-agent silently ends as `stop_failure` on a provider 429 or transport
timeout, and the delegating Session never learns). Tree: the pull-request head for branch
`fix/issue2862-subagent-failure-notice`, parent `origin/main` `bc9d8bc399`. Commands ran on
the Linux build host `xx04` from `crates/miao-engine`, `cargo 1.99.1`.

The report names three problems. One of them was already answered in the code, which this
record establishes before changing anything; the other two are what this tree fixes.

## Problem 1 — "the 429's `retry-after` is not respected" — already implemented

`crates/miao-engine/src/provider.rs` grants a vendor-declared wait outside the retry
window: the retry notice carries `extended_ms`, the allowance is bounded (two grants), and
a third request is refused with a `provider.window` event whose note names the numbers it
used ("the provider asked for 1382ms but this turn already extended its retry window 2
times"). `docs/acceptance/2026-11-11-*` records that grace; `provider::retry_tests::` pins
both the grant and the refusal.

What the report saw is the **bounded** part of that design: a child that keeps meeting 429
after two granted waits does end, by design, rather than waiting forever. That is a
deliberate choice, not a missing feature, and this record does not change it.

## Problem 2 — "the parent has no idea the child failed" — fixed here

A finished background **job** already tells its owner (an admitted steer input pointing at
`job_status`). A failed background **child** did not. It now does, in the same shape:

| surface | before | after |
| --- | --- | --- |
| a background child ending `failed` | `subagent_stop` recorded; no input admitted, so an orchestration that only polls saw a child that stopped answering | one admitted steer input naming the child and carrying its own words, then a wake: *"Background task `<id>` failed: `<error>` Read its stored result with task_result; it does not resume on its own."* |
| a background child ending `completed` | no input admitted | **unchanged** — AGT-06 measured that, and `a_side_question_never_enters_the_parent_context_by_itself` still pins exactly one admitted input for a completed child |
| a child whose provider failed | the only record of why was the child's own `stop_failure` | the notice reads that record back, because a failed child has no assistant text to quote |

The notice is bounded (512 characters, whitespace collapsed) and reuses the job-completion
mechanics (`Store::admit_subagent_failure` → `notify_admission`), so one shape covers both
kinds of background work.

## Problem 3 — "a normal stop and a stalled child look the same" — fixed for the ended case

`Store::subagents` rows now carry `reason` (`completed` / `failed` / `cancelled` /
`interrupted`) and `error` (the endpoint's own words, for a failure) beside `status` and
`text`. The parent's `task_list` therefore answers "did it finish, fail, or get cancelled,
and why" without a second query.

**Not covered:** a child that is still `running`. Its row has no age, so a child that is
working and one that has wedged look identical until something settles them. Detecting that
needs a liveness/age signal on the row (or a heartbeat the parent can compare), which this
tree does not add.

## The commands

| pin | command (`crates/miao-engine`) | observed |
| --- | --- | --- |
| a failed background child tells the parent, with its words | `cargo test --test subagent a_failed_background_child_tells_the_delegating_session` | `ok` — one `input.admitted` ending `:failed` whose prompt contains `Background task`, `failed:`, the endpoint's `429`, and `task_result`; and the child's row reads `status: failed`, `reason: failed`, `error` containing `429` |
| a completed child still admits nothing | `cargo test --test subagent a_side_question_never_enters_the_parent_context_by_itself` | `ok` (unchanged) |
| the whole sub-agent suite | `cargo test --test subagent` | `15 passed; 0 failed` |
| the crate around it | `cargo test --lib` | `479 passed; 0 failed` |
| lints | `cargo clippy --all-targets -- -D warnings` | `Finished` with no warnings from this crate |

## What this record does not claim

- **No wake on success.** A completed child still admits nothing; the parent reads it when
  it asks. Only a failure reaches out, because only a failure leaves nothing to read.
- **No stalled detection** for a child that is still running (see problem 3 above).
- No Windows or macOS run: the rows above are from the Linux host.

## Version

No `roadmap:` stamp: this tree is in no published release.
