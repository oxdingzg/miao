# Acceptance record — AGT-06 a side question forks the mainline instead of restating it

Item: `AGT-06` (#1971). Tree: pull request **#2891**, head `df5bc33b5d` on
`feat/issue1971`, parent `origin/main` `7f13b8130d`; squash-merged to `main` as
`7ae9259205`. Every command below is run from `crates/miao-engine`. The run recorded here
is GitHub Actions run **`43012528798`**, job `engine (ubuntu-24.04, shard 1/4)`, which is
the only job that carries this crate's unit tests and `--test subagent` (test targets are
sharded round-robin; `subagent` is index 180 of 181, so it lands in shard 1). This
workstation refuses local Rust compilation (a `rustc` wrapper), so CI is the recording
instrument rather than a build host, and no local cargo evidence is claimed.

What was already true, and what this adds: `2026-11-11-agt06-side-question.md` (PR #2859)
pinned that a background child does not write into the parent's context. But that child
**forks empty** — `delegate` called `store.fork(parent, child, Some(0))` — so a question
about the work in progress could only be asked by restating that work, which is the cost
the item exists to remove. `specs/agt06-exploration-branches.md` asks for the other half:
a branch that starts under the mainline (C1), returns one conclusion (C2), and stays
cheap (C4). `task` now takes `explore: true` for exactly that.

## Criterion — "Support a short side question or forked exploration without interrupting the main task."

The branch copies this Session's history at its **newest closed boundary** — the last
message before which every tool call already has its result — so the question is asked
against the context it is about and nothing still in flight is copied. The parent's turn
is not interrupted: the branch is its own Session, run, cancellation, agent and billed
usage, and it starts from a copy instead of from the live Session.

| what | command | observed |
| --- | --- | --- |
| the branch starts at a real boundary of this Session, not from empty | `cargo test --test subagent an_exploration_branch_answers_from_the_mainline_without_restating_it` | `ok` — the child's lineage point is a nonzero message seq, `subagent_start.forked_at` equals it, and the copy carries the mainline's own answer (`mainline marker: the ledger has three rows`) |
| the copy is what makes the question answerable | the same test's control: the same question delegated plainly | `ok` — a plain delegation reports `forked_at: 0`, its child history holds no marker, and the branch answers `context absent` |
| a finished branch does not restart the mainline | `cargo test --test subagent an_exploration_branch_leaves_the_mainline_to_finish_its_own_work` | `ok` — see the third criterion for its counts |
| the whole target | `cargo test --test subagent` | `ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 7.85s` |

## Criterion — "State whether results enter the main context, how conclusions are brought back, and who bears the cost."

| question | answer, as the code settles it | pinned by |
| --- | --- | --- |
| do results enter the main context? | **not by themselves.** A settled branch records `subagent_stop` on the delegating Session's journal and admits no input there. | `an_exploration_branch_leaves_the_mainline_to_finish_its_own_work` |
| how is a conclusion brought back? | **only by asking.** `task_result` reads a background branch's durable report; a synchronous `task { explore: true }` returns the conclusion in its own tool result, once. | `an_exploration_branch_answers_from_the_mainline_without_restating_it` (synchronous) and `background_task_survives_the_parent_turn_and_reports_durably` (background) |
| who bears the cost? | **the branch.** Its own Session, its own run, its own `subagents.{sessions,turns,attempts,tokens}` line; the branch is told in its frame that its conclusion is the whole deliverable. | `an_exploration_branch_is_bounded_as_a_side_question`, and the stop payload's `tokens`/`turns` read by the tests |

The branch also **states** its own shape to the child (`EXPLORE_FRAME`): the history it
sees is a copy, the mainline does not read it unless it asks, and abandoning the branch
costs the mainline nothing. That text is pinned by the unit test
`subagent::tests::an_exploration_branch_is_asked_for_one_conclusion`.

## Criterion — "Verify reduced context pollution and the absence of implicit background continuation."

| what | command | observed |
| --- | --- | --- |
| the conclusion stays out of the mainline until asked | `cargo test --test subagent an_exploration_branch_leaves_the_mainline_to_finish_its_own_work` | `ok` — the parent's serialized history contains no `context present`, while the branch's own settled text is `context present` |
| settling admits nothing, so discarding needs no cleanup | the same test counts `input.admitted` on the mainline | `ok` — exactly **2**, the two prompts the operator sent |
| there is no implicit continuation | the same test counts `run.started` on the mainline | `ok` — exactly **2**, so a finished side question starts no run of its own |
| the earlier pin still holds | `cargo test --test subagent a_side_question_never_enters_the_parent_context_by_itself` | `ok` |
| the allowance is the exploration one, and a stated budget still wins | `cargo test --test subagent an_exploration_branch_is_bounded_as_a_side_question` | `ok` — `delegation.boundary` reads `max_turns: 12` with `source: explore`, and `max_turns: 3` with `source: parent` when the parent states three turns |
| the crate's own unit tests around it | `cargo test --lib` | `ok. 482 passed; 0 failed` |

"Reduced context pollution" is therefore a structural claim, not a measured one: nothing
the branch says reaches the mainline except the conclusion the mainline asks for, and a
branch that copies the mainline replaces the restating a side question used to require.

## Criterion — "Link implementation PR, offline or real client acceptance records, and applicable versions; attach quality, cost, or latency evidence for optimizations."

- Implementation: PR **#2891** (`feat(engine): a side question forks the mainline`),
  squash `7ae9259205`.
- Design: `specs/agt06-exploration-branches.md` (#1700). Prior pin:
  `2026-11-11-agt06-side-question.md` (#2859).
- Offline record: this file.
- Version: no `roadmap:` stamp — this tree has not shipped in a release yet.
- Cost/latency evidence: **none claimed.** This change adds a capability; it is not an
  optimization, so no saving is asserted. `AGT-03` (#1968) owns the delegation-cost policy
  and `VAL-04` (#1948) the measurement that would have to back any such number.

## What this record does not claim

- No client affordance: there is no keystroke, command or TUI control that asks a side
  question. A caller asks by passing `explore: true` to `task`, which is what the model
  does; the subagent surface (AGT-01) lists the branch like any other child.
- No cost saving, for the reason above.
- No measurement of the boundary search: locating the newest closed boundary reads the
  Session projection once more than the copy itself does, so a very long Session pays that
  per side question. Recorded as a known cost, not measured.
- A branch the parent leaves unbounded is capped at 12 provider turns and 5 minutes
  (`EXPLORE_TURN_LIMIT` / `EXPLORE_TIME_LIMIT_SECS`); whether that is the right size for a
  useful side question is a product judgement this record does not settle.
