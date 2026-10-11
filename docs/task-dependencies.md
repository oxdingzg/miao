# Task dependencies and background waits

Todos may declare a stable `id` and a `depends_on` array of other task IDs. List order is not a dependency. Existing todos without these fields keep their independent-task behavior.

```json
[
  { "id": "4", "content": "CI run 123", "status": "waiting", "priority": "high" },
  { "id": "5", "content": "Release after CI", "status": "pending", "priority": "high", "depends_on": ["4"] },
  { "id": "6", "content": "Verify published artifacts", "status": "pending", "priority": "high", "depends_on": ["5"] },
  { "id": "7", "content": "Independent contract audit", "status": "pending", "priority": "medium" },
  { "id": "8", "content": "Independent baseline preparation", "status": "pending", "priority": "medium" },
  { "id": "9", "content": "Independent documentation update", "status": "pending", "priority": "low" }
]
```

The runner computes the runnable set from `pending` and `in_progress` tasks whose prerequisites are all `completed`. In this example it can continue 7–9 while 4 waits. Completing 4 unlocks 5; completing 5 unlocks 6. Cancelling 4 does not count as completing it.

Use `waiting` for a task awaiting an external job, and identify the job in its content. Keep not-started dependent tasks `pending` with explicit links. Use `blocked` for a missing human decision. If only waiting/blocked tasks and their locked dependents remain, the Session becomes idle and completion notifications drive resumption rather than polling.

A dependency graph is persisted with the task list. Updates reject empty or duplicate task IDs, unknown dependencies, duplicate edges, cycles, and tasks entering `in_progress` or `completed` before their prerequisites complete. Preserve prerequisite records while other tasks reference them.

Autonomous idle-boundary continuation requires either the existing `loop.enabled` configuration or an active durable goal with `autonomous: true`, recorded only after the user explicitly authorizes continuous work. A goal's paused, blocked, or done state stops autonomous continuation. Iteration, agent-step, and no-progress limits still apply. This does not grant permissions, authorize delegation, or bypass tool concurrency constraints.

Dependency declarations make scheduling explicit; miao does not infer prerequisites from task numbers. The agent must declare actual relationships. Independent runnable tasks can proceed alongside background work without requiring additional agents.
