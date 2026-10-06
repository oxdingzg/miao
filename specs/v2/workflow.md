# Workflow Tool

## Problem

A Session can already spawn one subagent (`task`) and can already run a confined
orchestration script over its own tools (`execute`, Code Mode). Neither expresses
"run these twelve reviews at once, feed every report into two more agents, and
return the merged result": the model has to orchestrate that with its own turns,
paying for every intermediate report with context it wanted to keep.

## Goal

One tool, `workflow`, that runs a confined script whose only capability is
spawning subagents. The script owns the control flow; the runner still owns every
turn.

## Non-goals

- No scheduler, no durable workflow state, no resume after a restart.
- No second orchestration loop in the runner. The runner keeps running one
  provider turn at a time.
- Nested subagents stay unsupported, exactly as they are for `task`.
- No new event, table, route, or migration.

## Architecture

### The script

The script runs in the Code Mode interpreter (`@miao/codemode`), the same
confined JavaScript subset `execute` uses. Nothing new is executed here: the
interpreter already supports `await`, `Promise.all`, `Promise.allSettled`, the
stdlib, and per-execution budgets.

Its tool namespace is exactly one entry:

```js
const report = await tools.workflow.agent({ prompt: "...", description: "...", agent: "explore" })
const [a, b] = await Promise.all([tools.workflow.agent({...}), tools.workflow.agent({...})])
return { merged: a.text + b.text }
```

The interpreter forks admitted tool calls under a concurrency permit, so
`Promise.all` over `agent(...)` really does run them at the same time, the same
way it does for any other tool in Code Mode today.

### The capability

`agent` is the capability the runner injects; it is the same path
`task` already takes: create a child Session with `SessionCreate`, admit the
prompt as a `steer`, drain that child to completion, and return its last
assistant text as `{ sessionID, text }`. The step's `agent` field defaults to the
built-in `general` subagent.

Because the capability is injected as a closure by the runner, the tool itself
stays a plain `Tool.make` value and the Location graph gains no dependency on
`SessionV2`, `SessionExecution`, or `SessionCreate`. This is the same reason
`task`, `goal`, and `list_sessions` are registered through
`ToolRegistry.registerSession`.

### The result

The script's returned value becomes the tool's `text` (serialized when it is not
a string), and the child Sessions it spawned are returned alongside it as
`sessions`, so a caller that wants to follow up on one step's work still can.

### Why this is not an in-memory tool loop

`specs/v2/session.md` and the root `AGENTS.md` forbid replacing the provider-turn
loop with an in-memory one. A workflow does not do that: it is a tool call like
any other. The runner still builds every request, streams every provider turn,
and settles every step; the script only decides which child Sessions to ask and
in what order. Its own state is the recursion of the script, and the work it
causes is recorded durably in the child Sessions it creates.

### Budgets

The interpreter's existing limits are the budgets: `timeoutMs` for wall-clock,
`maxToolCalls` for fan-out (each `agent` call is one), and `maxOutputBytes` for
the returned text. A script that exceeds a budget fails the tool call with the
interpreter's own diagnostic; it never runs unbounded. The interpreter already
tests limit enforcement itself, so the runner tests cover the fan-out instead of
re-testing the budgets.

### Failures

A failed step fails the workflow: the tool call reports the interpreter's
diagnostic as a `ToolFailure` rather than answering with a partial report. Every
`agent` call is a whole provider turn, so a silently completed but broken
fan-out is the expensive mistake; a caller that wants to tolerate one step's
failure has to say so in the script.

### Durable state

None of its own. A crash loses the orchestration and every child that had not
finished, but every child that did finish has its transcript, so the work is
recoverable by hand and nothing is silently replayed. Durable workflow state
would have to answer what a restart should do about an interrupted fan-out,
which is the same question `specs/v2/session.md` leaves to an explicit design.

## Regression coverage

- A workflow whose script calls `agent` twice returns both reports, in order, and
  creates two child Sessions.
- `Promise.all` over two `agent` calls has both steps waiting on the provider at
  the same time.
- A failing child fails the tool call instead of returning a partial report.
