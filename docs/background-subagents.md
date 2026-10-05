# Background subagents

The `task` tool accepts `background: true`. It immediately returns a durable `taskID` and a child `sessionID`, allowing the parent to continue independent work. Omitting `background` keeps the foreground behavior.

- `task_list` lists the current Session's recent tasks (running tasks first).
- `task_result` reads a task's full durable report without waiting or restarting it.
- `task_cancel` requests cancellation of an owned task, subject to the `task_cancel` permission. Cancellation does not roll back effects already performed by child tools.
- `task_id` resumes a child Session belonging to the parent; it is a Session ID, whereas result/cancel tools take the returned `taskID`.

## Scheduling and delivery

Background children use the process-local Session execution coordinator and its global drain limit. Runtime-scoped watchers outlive the parent tool and collect reports after children become idle. Interrupting a parent does not automatically cancel its background children.

The terminal task event projects both its result and a pending machine notification transactionally. The parent promotes the notification into a synthetic message at a provider-turn boundary, or starts an advisory drain when idle. Human steers take priority; queued user prompts are considered before an otherwise-idle machine notification. Machine notifications do not reset the current drain's agent step allowance. Reports are forwarded verbatim, with a 64 KiB context prefix for large reports; `task_result` retains the complete report.

Repeating an invocation with the same parent, assistant message, and tool-call ID returns its existing task. Conflicting arguments fail. Terminal status is first-writer-wins, so late reports cannot replace cancellation or interrupted recovery, and one task produces one durable notification.

`MIAO_MAX_BACKGROUND_SUBAGENTS` sets the active child-task limit per parent (default 4). Admission also rejects an exhausted configured cost budget and a backlog of 64 unread reports. Child provider turns retain the normal runner limits, and descendant usage is included in parent cost. The watcher fails a child after 15 minutes without durable child events and interrupts only the execution identity it observed.

## Restart reconciliation

At the next parent drain, tasks whose runtime owner has disappeared become `interrupted` with an outcome-unknown report. Recovery never restarts a child provider turn or repeats its tool effects. Tasks owned by another live process are left with that process; cancellation cannot steal their execution. Inspect the child transcript before explicitly retrying interrupted or failed work.

This implementation is process-local execution, not clustered ownership or automatic post-crash provider recovery.
