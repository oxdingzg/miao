# Acceptance record — AGT-06 a side question is a background child, and nobody pays for it twice

Item: `AGT-06` (#1971). Tree: the pull-request head for branch
`test/agt06-side-question`, parent `origin/main` `da1c975c43`. Commands ran on the
Linux build host `xx04` from `crates/miao-engine`, `cargo 1.99.1`, against this tree.

The item asks for side questions and forked exploration. The engine already had the
mechanism — a `task` call with `background: true` returns as soon as the child is
scheduled and the child is a full Session — but no record said what that means for the
parent's context, for the cost, or for continuation. This record answers all three and
pins the answer with a test.

## Criterion — "Support a short side question or forked exploration without interrupting the main task."

`task` with `background: true` schedules a child Session and returns
`{"session_id": …, "background": true, "status": "running"}`; the parent's turn keeps
going and can end before the child finishes. The child is a Session of its own, with its
own run, cancellation, agent, model and bounds (`budget.max_turns` /
`budget.wallclock_ms`, and the `TURN_LIMIT` / `TIME_LIMIT_SECS` floor for a child the
host left unbounded).

## Criterion — "State whether results enter the main context, how conclusions are brought back, and who bears the cost."

| question | answer, as the code settles it |
| --- | --- |
| do results enter the main context? | **No.** A settled child records `subagent_stop` on the parent's event stream — status bookkeeping — and admits no input to the parent. The answer text stays in the child Session. |
| how are conclusions brought back? | **Only by asking**: `task_result` with the child's id reads the durable report (`task_list` lists the children); that tool call is what enters the parent's context, once, as its own result. |
| who bears the cost? | **The child Session.** Its tokens, turns and attempts are counted under `subagents.{sessions,turns,attempts,tokens}` in the usage report and painted in the sidebar (`subagents 2 · 3 turns · in 1.2k`), so a side question never hides inside the main model's line. |

The design behind this is `docs/specs`'s lightweight-exploration-branch record
(`#1700`), and the semantics here are the ones the code already had; the record makes
them checkable.

## Criterion — "Verify reduced context pollution and the absence of implicit background continuation."

| what | how it is pinned | observed |
| --- | --- | --- |
| the answer never lands in the parent's context | `cargo test --test subagent a_side_question_never_enters_the_parent_context_by_itself` — the parent delegates in the background, ends its turn without reading, and the test waits until the child's report exists before asserting | `ok` — the parent's serialized history contains no `hello from child` |
| a settled side question does not continue the parent | the same test counts `input.admitted` on the parent | `ok` — exactly **1**, the prompt the operator sent: nothing is admitted on the child's completion, so there is no implicit background continuation |
| the answer is still reachable, deliberately | `cargo test --test subagent background_task_survives_the_parent_turn_and_reports_durably` (existing) | `ok` — `task_list` then `task_result` returns `hello from child` and the durable row says `completed` |
| the whole suite around it | `cargo test --test subagent` | `14 passed; 0 failed` |

## Criterion — "Link implementation PR, offline or real client acceptance records, and applicable versions."

- Implementation: `#1700` (the design record), and the `task` tool as it stands after
  `#2812` (boundaries) and `#2831` (child bounds); this record's pull request adds the pin.
- Offline record: this file.
- Version: no `roadmap:` stamp — this tree is in no published release yet (`v0.3.60` is
  the latest published tag), so the stamp belongs to the release that first ships it.

## What this record does not claim

- No product-taste claim that a side question *reads* well in a client: the TUI side
  question surface is not part of this pin.
- No cost saving is claimed. `AGT-03` (`#1968`) carries the delegation-cost policy and
  `VAL-04` (`#1948`) the measurement that would have to back any saving.
