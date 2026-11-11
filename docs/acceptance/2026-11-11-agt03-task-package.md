# Acceptance record — AGT-03 the task package, and what a report answers

Item: `AGT-03` (#1968). Tree: the pull-request head for branch `feat/agt03-task-package`,
parent `origin/main` `1681fc93c9`. Commands ran on the Linux build host `xx04` from
`crates/miao-engine`, `cargo 1.99.1`, against this tree.

The item's own gate is a benefit experiment, and earlier records left it open because
"delegate only when the net benefit pays off" needs measurement. Three of its four
criteria are not measurement, though — they are what a delegated call *carries* — and
those are what this tree settles. Criterion 3's measurement half is named below as
still open, with the reason.

## Criterion — "Include the goal, input references, completion criteria, and minimal necessary context in every task package."

| surface | command | observed |
| --- | --- | --- |
| a caller may state a goal and its acceptance conditions, and the child receives them above the instructions | `cargo test --lib subagent::tests::a_task_package_states_the_goal_and_the_criteria` | `ok` — the block starts with `<task-package>`, trims and states `Goal: …`, numbers each criterion, asks the report to answer each with evidence and not to paste history, and closes with `</task-package>` |
| a caller that states neither sends exactly what it sent before | `cargo test --lib subagent::tests::a_bare_prompt_renders_no_package` | `ok` — `package()` is empty for a bare prompt and for blank values |
| an over-long package is refused, not truncated | `cargo test --lib subagent::tests::an_oversized_package_is_refused_rather_than_truncated` | `ok` — a goal past 512 bytes, a criterion past 256, or 17 criteria fail the call; exactly 16 are allowed |
| input references still travel, bounded | `cargo test --test subagent` | `13 passed; 0 failed` — including `task_reference_reaches_an_archive_beyond_one_bounded_scan` |
| the whole crate around it | `cargo test --lib` | `457 passed; 0 failed` |

**Why optional rather than required.** both Claude Code and Codex hand a child a prompt
and a budget, not a mandatory acceptance form; making the fields required would break
every existing caller for no evidence gain. What the fields buy when present is the part
that was missing: the child, which forks empty, now sees the parent's goal and the
conditions its report will be read against.

## Criterion — "Report verifiable results and evidence without copying long history."

The package asks for exactly that — "answer each criterion with the evidence that proves
it … do not paste long history" — and the existing report bound (a bounded final message,
with the durable report readable through `task_result`) is unchanged. This record does
not claim a report-quality measurement; it claims the instruction is now stated in the
place the child reads first.

## Criterion — "Track parent and child total cost, merged rework, and wall clock, and finish with a single agent when the benefit is insufficient."

| part | state |
| --- | --- |
| child cost, attempts and turns | tracked already: `subagents.{sessions,turns,attempts,tokens}` in the usage report, painted in the sidebar (`subagents 2 · 3 turns · in 1.2k`) |
| rework | tracked already: `retries.replayedTurns/failedAttempts` and `rework.toolInputErrors` |
| wall clock | bounded already: a child the host left unbounded closes itself at `TURN_LIMIT` / `TIME_LIMIT_SECS` (`#2831`), and the parent can state `budget.max_turns` / `budget.wallclock_ms` |
| finish with a single agent when the benefit is insufficient | **policy, now stated where the decision is made**: the tool description tells the model to delegate only when the work is separable and the handover costs less than doing it here, and to finish a small edit itself because a child repeats the reading the parent already did |

**Still open on this item, deliberately:** the *measurement* of net benefit. It needs
per-mechanism toggles and identical-model arms, which is `VAL-04` (#1948); this record
does not claim a benefit experiment it did not run.

## Version

No `roadmap:` stamp: this tree is in no published release yet (`v0.3.60` is the latest
published tag), so the stamp belongs to the release that first ships it.
