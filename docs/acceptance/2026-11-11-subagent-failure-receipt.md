# Acceptance record — a failed background child leaves its parent a receipt

Item: `#2862` problems two and three. Tree: branch `fix/subagent-failure-receipt`
on `origin/main` `cf011bc26c`; the pull request's squash commit lands the same
content. Commands were run from `crates/miao-engine` on `xx02` (Linux, 20 cores).

The defect: a background `task` child's terminal state was already durable —
`finish_delegation` reads the child's `run.finished` reason and records a
`subagent_stop` row on the parent with `reason`/`text`/`tokens`, and
`store.subagents()` already projects `completed`/`cancelled`/`failed` out of
it. What was missing was anybody telling the parent. A child that died on a
provider failure left the delegating Session idle with no input, so an
orchestrating Session could only discover the loss by polling the child's
Session by hand — the "静默终结" in `#2862`.

## Criterion — "A failed child is a receipt the parent receives, not silence."

`finish_delegation` now announces a **failed** child to the parent as a queued
input (`task:{call_id}:finished`) and wakes it, so the existing drain promotes
the announcement at the parent's next safe boundary. Only failure announces:
AGT-06 fixes the other half, that a background child that delivered is a side
question as far as the parent's turn goes — its answer stays out of the parent
context and is fetched with `task_result`, so a success announcement would
continue a parent that asked nothing (`a_side_question_never_enters_the_parent_context_by_itself`). It is `Delivery::Queue`,
not a steer: a completion must not cut into a turn that is in flight. The
announcement names the outcome and points at `task_result`, which reads the same
`subagent_stop` row. The watcher's own failure path — the branch that records
`reason: "failed"` and used to record nothing else — announces through the same
helper, so a child that never reached `run.finished` is not silent either.
Admission is best effort: a parent Session that no longer exists must not fail
the child's settlement, which is already durable.

| command | observed |
| --- | --- |
| `cargo test` (miao-engine, full suite) | ok — 65 targets `test result: ok`, 0 failed |
| `cargo test --test subagent a_failed_background_child_leaves_the_parent_a_receipt` | ok. 1 passed; 0 failed |
| `cargo clippy --all-targets -- -D warnings` | exit 0 |

An earlier full run on the same host reported 10 failures, all in
`runtime::cancel_authority_tests` and all `Elapsed(())` at
`src/runtime/cancel_authority_tests.rs:96`; the module passes 10/10 when re-run
alone and the failures did not reproduce under a quiet host, so they are
timeouts under load rather than this change.

Pinned by `crates/miao-engine/tests/subagent.rs`:

- `a_failed_background_child_leaves_the_parent_a_receipt` — a child whose
  provider answers with a non-retryable stream error settles `failed` in
  `store.subagents("parent")`, the parent receives the announcement as a
  `queue` delivery under `task:start:finished`, and the parent's own history
  eventually contains the sentence — the promotion, not just the row.

## Deliberately open

- The child's partial work is not rolled back; the receipt says the work may be
  undone and leaves the retry decision to the parent, which is what
  `docs/background-subagents.md` already promises for interrupted children.
- `#2862` problem one (honouring a `Retry-After` longer than the retry window)
  landed separately in `#2874`.
- The todo-driven continuation loop that produced the repeated injected
  continuation prompt is a different defect and is not touched here.
