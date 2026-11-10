# Acceptance record — AGT-02 delegation boundaries, cancellation, and budget inheritance

Item: `AGT-02` (#1967). Tree: `02cbf3f6c8` (branch `feat/agt02-delegation-boundaries`, two
commits: `f723aa8c29` states the delegation contract and enforces it, `02cbf3f6c8` pins
the behaviour in tests). The commands below are the cargo invocations the pull request's
CI workflow runs from the crate directory on this recorded tree; the observed cells
will cite this PR's CI engine-shard run, and a Linux build-host run cross-checks them
when the host is idle. A delegation is now an explicit contract: the `task` call states
the child's budget (`max_turns`, `wallclock_ms`) and a `deny_tools` list, the grant is
resolved deterministically — parent-stated, then the parent's goal budget (AGT-04),
then the host default, always capped by what the delegating turn still has left — and
recorded durably on the child as `delegation.boundary` before its first wake, so every
delegated run reads its own grant instead of the environment's.

## Criterion 1 — constrain delegation depth, concurrency, turn budgets, and permissions explicitly from the parent

| command | observed |
| --- | --- |
| `cargo test --test delegation_boundaries` | pending — will cite this PR's CI run |

Pinned by tests in that suite:

- `an_explicit_parent_budget_closes_the_child_at_the_stated_turn_allowance` — the
  parent states `budget.max_turns: 2`; the child's `delegation.boundary` records
  `max_turns=2, source="parent"` with the delegating parent, and the child closes on
  the recorded grant with the delegated-turn-allowance note in its transcript.
- `an_explicit_wallclock_closes_the_child_at_the_stated_deadline` — the parent states
  `budget.wallclock_ms: 400`; the boundary records it and the child closes with the
  delegated-time-limit note.
- `deny_tools_narrow_the_child_surface` — `deny_tools: ["bash"]` lands in the
  boundary event and the engine's actual offer to the child drops `bash` while every
  other tool stays; the child is still a leaf, so `task` is absent either way.
- `deny_tools_must_name_registered_tools` — a denied name that registers nothing
  refuses the delegation instead of silently narrowing nothing.
- `a_budget_that_states_no_feasible_bound_is_refused_without_a_child` — an empty
  budget, a zero or over-ceiling `max_turns`, and a zero or over-ceiling
  `wallclock_ms` are each refused before any child Session is created, and the parent
  reads why.
- `an_explicit_budget_is_capped_by_what_the_delegating_turn_has_left` — under a
  four-turn host policy the parent's `max_turns: 50` grant lands as exactly `3`: a
  child can never be granted more than its delegator may still spend.
- `the_parents_goal_budget_caps_a_child_when_the_parent_states_none` — with no stated
  budget, the parent's `goal.budget.iterations: 2` (AGT-04) becomes the child's
  recorded ceiling with `source="goal"`, and the child closes on it.

Depth and concurrency stay host-level bounds, enforced where they already were and
pinned by the existing suites: `cargo test --test subagent` pins the leaf rule
(`a_delegated_child_cannot_delegate_again`) and the lineage-walk depth cap, and the
`subagent_slots` semaphore stays the concurrency bound — a per-delegation concurrency
knob is not part of this record (see the open paragraph below).

## Criterion 2 — prevent automatic redispatch or retry of subtasks with unknown outcomes

| command | observed |
| --- | --- |
| `cargo test --test delegation_boundaries` | pending — same run |

- `a_running_child_refuses_redispatch_until_its_outcome_is_settled` — a background
  child parks on its run; a second delegation into the same `session_id` is refused
  with "subtask outcome is unknown: the child Session is still running; settle it
  with task_result or task_cancel before delegating again"; the refusal records no
  second `subagent_start`; `task_cancel` settles the first run into an
  `interrupted` terminal, and only then does the adoptive redispatch succeed and
  return the child's new report.

The guard sits on the duplicate-fork path in `delegate`, so no layer can redispatch
into a running child even by skipping the tool's own checks.

## Criterion 3 — deterministic terminal states for transitions, independent cancellations, and parent cancellations

| command | observed |
| --- | --- |
| `cargo test --test delegation_boundaries` | pending — same run |
| `cargo test --test subagent` | pending — will cite this PR's CI run |

New pin:

- `cancelling_the_parent_run_settles_a_synchronously_waited_child` — the parent
  blocks in the synchronous tool wait; cancelling the parent run carries the child
  to a settled state, and the parent's durable `subagent_stop` names the child with
  reason `interrupted`.

Pinned by the existing `subagent` suite and unchanged by this branch: explicit
`task_cancel` settles a background child into a cancelled terminal state;
cancelling the spawning run settles its background child; cancelling a later run
preserves an older background child; and a subagent whose watcher died is closed by
recovery rather than left running.

**Recorded open, not hidden:** a *mid-call* synchronous-to-background transition — a
running foreground wait converting to background without cancelling the child — is
not implemented: the engine takes its background/foreground decision at delegation
time, and the deterministic terminals around that choice are what this record pins.
The foreground-to-background client transition the issue's status snapshot names
remains open. Token-axis budget inheritance (a child's spend drawing down
`goal.budget.tokens`) is also open: this record covers the provider-turn and
wall-clock axes and the goal-iteration ceiling.

## Full-suite result

`delegation_boundaries` touches `runtime.rs`'s run loop and every engine suite
exercises it, so the whole integration set runs in CI, not only the new suite:

| command | observed |
| --- | --- |
| `CARGO_INCREMENTAL=0 cargo test --no-run --tests` | pending — will cite this PR's CI engine shards |
| `CARGO_INCREMENTAL=0 cargo test --tests` | pending — will cite this PR's CI engine shards |

## Criterion 4 — link the implementation PR, the acceptance records, and applicable versions

- Implementation: this pull request (link recorded when the PR opens), branch tip
  `02cbf3f6c8`.
- Acceptance record: this file, run on tree `02cbf3f6c8`.
- Versions: applies from the release that first ships the merged tree; stamped per
  the repository convention when that release cuts.
