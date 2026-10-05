# Agent Concurrency: Non-Blocking Subagents and Wake-on-Completion

## Goal

Keep a Session making progress while long-running delegated work runs, instead of
blocking the turn and leaving subsequent user prompts stalled at `RECEIVED`.

Today a `task` subagent is synchronous from the parent's point of view: `runSubagent`
does not return until the child drain finishes, so the parent's turn cannot reach its
next safe boundary and a queued steer waits. The same is true of `job_wait`. This spec
turns delegation and long waits into durable, non-blocking handoffs: the parent turn
ends, the work runs in its own Session, and the result comes back as a durable,
system-generated notification that wakes the parent.

## Why it fits V2 already

The substrate is in place and does not need a new execution model:

- Durable per-Session `session_input` inbox with `steer`/`queue` delivery
  (`packages/core/src/session/input.ts`).
- `SessionExecution.wake` and the runner's `wake` callback seam
  (`specs/v2/session-messaging.md`, `packages/core/src/session/execution/local.ts`).
- `SessionRunCoordinator` serializes drains per Session and runs different Sessions
  concurrently, capped by `MIAO_MAX_CONCURRENT_DRAINS` (default 8)
  (`packages/core/src/session/run-coordinator.ts`).
- Session-scoped tools injected by the runner (`task`, `send_message`, `job_*`)
  (`specs/v2/session-scoped-tools.md`).
- Subagents are Sessions with `parentID`, created by `SessionCreate`, and the runner
  already holds a runner-local drain capability (`runDrain = run`) used by
  `runSubagent` (`packages/core/src/session/runner/llm.ts`).
- Parallel tool execution within a turn: each tool call is `FiberSet.run` and the turn
  waits for all of them (`awaitToolFibers`).
- The `BackgroundJob` registry runs a tool without blocking the turn
  (`packages/core/src/background-job.ts`, `packages/core/src/tool/bash.ts`).
- `SessionEvent.Synthetic` already carries system-generated context into the model
  window; `goal` uses it.

## Design

### 1. Background `task`

`task` gains an optional `background?: boolean` (default `false`).

- **Foreground (default, unchanged).** Create/resume the child Session, admit the
  prompt, run to completion, return the child's final text. This is `runSubagent`
  today, and remains the "next action depends on the result" path.
- **Background.** Create/resume the child Session, admit the prompt, `wake(child)`, and
  return `{ sessionID }` immediately. The parent turn continues and then ends.

The child runs concurrently. It is a normal Session: the user can open it,
`list_sessions` shows it, and its transcript is durable.

### 2. Result delivery: synthetic notification, not a user turn

When the child finishes, deliver its report to the parent as a durable
`SessionEvent.Synthetic` message tagged `<subagent-result session="…">…</subagent-result>`
and `wake(parent)`.

Why synthetic and not a queued user input:

- A queued `session_input` is a **user instruction**: it consumes `MAX_INBOUND_QUEUE`
  and, when promoted, resets the agent's provider-turn allowance. A subagent report is
  machine output; it should not spend the user-input budget or reset the step allowance.
- miao already routes system-generated context through `Synthetic` (`goal`, the tool-call
  leak nudge). The model renders both as a user-role message
  (`runner/to-llm-message.ts`), so nothing is lost by choosing the non-budget path.
- Peer frameworks treat a delegated result as a **tool result or feedback**, not a new
  user turn (Mastra `resultText`/feedback; LangChain deep agents store the subagent output
  in state for the supervisor to read).

Completion semantics:

- Report exactly **once**, after the child's first drain-to-idle, snapshotting the final
  assistant text. A later resume of the same child does not re-report.
- The notification carries the child session id so the parent (and the user) can open the
  full transcript.

### 3. Result contract

A recurring production bug (LangChain's benchmark attributes roughly half of the
supervisor-vs-swarm quality gap to it) is a subagent that does its work in tool calls and
returns a final message that omits the findings, so the parent only ever sees the empty
tail. Guard against it:

- The subagent must return its findings as text; an empty or tool-call-only finish is
  reported as a failure-like result, not a successful empty delegation.
- The parent forwards the report **verbatim**; it must not re-summarize it into the
  parent's context (the game-of-telephone loss).
- An optional `resultText` override lets the launcher replace a misleading tail (for
  example an empty stop) with a clear message, mirroring Mastra.

### 4. Execution seam and scheduler

Two facts constrain the implementation and must be respected:

- **The runner cannot reach global `SessionExecution`.** It is a Location-graph service;
  depending on the global execution service reintroduces the tag cycle documented in
  `specs/v2/session-messaging.md` and `specs/v2/session-scoped-tools.md`. The background
  launcher must use the **runner-local `runDrain`**, not `SessionExecution.resume`.
- **The completion watcher must outlive the parent turn.** The per-turn `toolFibers` set is
  cleared when the turn ends, so the watcher is forked on a **runner-owned fiber set**
  (the `titleFibers` pattern) that survives the tool settling and the turn boundary.

**The drain cap does not currently bound subagents.** `runSubagent` calls `runDrain`
directly, bypassing `SessionRunCoordinator`, so children do not consume a concurrency
permit and do not emit busy/idle status. That is the existing behavior and it is also why
a naive "route children through the coordinator" change is unsafe: a synchronous parent
holds a permit while awaiting a child that needs a permit, so a shared pool can deadlock
under fan-out.

Resolution:

- **Background children go through the coordinator** (the parent no longer holds a
  synchronous wait), so they get the cap and status for free.
- **Foreground unification is a follow-up that needs a separate lane.** Routing foreground
  children through the coordinator requires either a dedicated subagent permit lane
  (`MIAO_MAX_SUBAGENTS`) that does not share the top-level pool, or reentrant/hierarchical
  permits where a parent's descendants do not compete with the parent's own permit.
  Sharing the top-level pool must be documented as a deadlock hazard.
- The target is one scheduler for all drains; background-first is only the first slice.

### 5. Wake-on-completion for background jobs

`run_in_background` already lets a shell command outlive the turn, but the model has to
call `job_wait` (which blocks) to learn the result. Give the job registry a completion
hook: when a job finishes, publish a durable notification to its owning Session (from
`job.metadata.sessionID`) and `wake` it. `job_wait` stays available for explicit waits;
the common path no longer blocks.

### 6. Fan-out and control flow

Fan-out needs no new primitive: the model can emit several `task` calls in one turn and
the runner already executes them as parallel fibers. Make the control flow explicit:

- `background: true` → **push** (auto-notify on completion). Independent work the user
  should not wait for.
- `task_wait(sessionIds)` / join → **pull**. A barrier for fan-out-then-synthesize: spawn
  N background tasks, wait for all, then synthesize. Without it, N completion pushes
  fragment the parent's synthesis.
- Foreground `task` → the join-of-one (unchanged).

This mirrors the field's sync/async split (LangChain: sync when the next action depends on
the result, async when independent) and the fan-out/fan-in barrier used by
orchestrator-worker systems.

### 7. Bounds, cost, and cancellation

Concurrency has a global cap; add the bounds that keep fan-out safe and reviewable:

- **Per-Session background cap** (`MIAO_MAX_BACKGROUND_SUBAGENTS`, default 4). Exceeding it
  fails the `task` call with a clear message rather than silently queueing.
- **Spawn permission.** Background delegation asserts the same permission action as `task`
  (fork-bomb protection); nested subagents stay blocked in the first slices so depth cannot
  multiply the budget.
- **Aggregate accounting.** `cost.budget_usd` is per-Session, so fan-out escapes the parent
  budget. Track spawned-subagent cost against the parent and stop spawning when the budget
  is exhausted.
- **Cancellation.** Interrupting the parent does not stop running children (peers keep
  running, matching Anthropic's model), so a `task_cancel(sessionId)` (or an explicit
  session interrupt) is required to stop background work.
- **Observability.** Expose running background subagents (extend `list_sessions`, or a
  status event) so "spawn N and continue" is visible.

### 8. Why this removes `RECEIVED` stalls

A `RECEIVED` prompt is a `steer` admitted while a foreground turn runs; it is promoted only
at a safe turn boundary, so a turn blocked on a long tool cannot promote it. With this
design the long work is delegated:

- The parent turn ends quickly, so the next boundary is reached and steers promote.
- Long work runs in child Sessions concurrently.
- Completion returns as a durable synthetic notification, so nothing depends on polling.

## Design decisions

- **Synthetic notification, not a user input.** Keeps machine results out of the
  user-input budget and off the provider-turn-allowance reset; consistent with `goal` and
  with peer frameworks treating delegated results as tool results.
- **Runner-local `runDrain`, not global `SessionExecution`.** Avoids the documented
  Location/global tag cycle.
- **Background-first coordinator routing; foreground via a separate lane.** One scheduler
  is the target, but sharing the top-level permit with synchronous parents deadlocks, so
  the lane split is explicit.
- **Push for `background: true`, plus `task_wait` for barriers.** Matches the sync/async
  guidance and the fan-out/fan-in pattern; avoids fragmenting synthesis.
- **Process-local first, with a durable handoff slice.** Background jobs already start
  process-local. The first slice must still fail safe (see Acceptance) so a crash cannot
  strand the parent silently.
- **Why not a DAG/script scheduler (LLMCompiler, Graph Harness).** Deterministic parallel
  fan-out and dependency tracking cost a planner and scheduler. Coding tasks have fewer
  independent subtasks than research, and the model already emits parallel tool calls, so
  orchestrator-worker with non-blocking handoffs captures most of the value. A DAG executor
  stays a possible later layer.

## Non-goals

- Cross-machine/cluster routing (process-local drains only, matching V2 execution).
- Intra-Session parallel provider turns: one Session keeps one serial transcript.
- Unbounded fan-out; every level is capped.
- Nested subagents remain blocked in the first slices.

## Acceptance

- A `background` `task` returns a child session id immediately; the parent turn ends and
  the child runs concurrently; when the child finishes, the parent receives a
  `<subagent-result>` synthetic message and is woken, without a manual poll.
- While a background subagent runs, a user `steer` is promoted at the next boundary — no
  `RECEIVED` stall waiting for the subagent.
- A background child consumes a coordinator permit and emits busy/idle status; exceeding
  `MIAO_MAX_BACKGROUND_SUBAGENTS` fails the call with a clear message; exceeding the global
  cap waits rather than spawning unbounded work.
- The report is delivered exactly once; a resumed child does not re-notify.
- Foreground `task` behavior and the existing subagent tests are unchanged.
- Interrupting the parent leaves children running but cancellable via `task_cancel`.
- **Fail-safe on crash.** If the process dies between child completion and notification,
  the parent is not left waiting forever: the pending handoff is durably recorded and
  either delivered on restart/next drain or surfaced as a failed task.

## Rollout

1. **Slice 1 — background `task`.** `background: true`, immediate return, synthetic
   result + wake on completion, runner-local `runDrain` on a runner-owned fiber set,
   per-Session cap, spawn permission, and a durable "pending handoff" marker so a crash
   fails safe.
2. **Slice 2 — durable handoff.** Deliver the pending result on restart / next drain,
   sharing its shape with the background-job restart-recovery item.
3. **Slice 3 — wake-on-completion for background jobs.** Completion hook on
   `BackgroundJob` → durable notification + wake.
4. **Slice 4 — fan-out control.** `task_wait` join, observability surface, aggregate
   budget accounting, `task_cancel`.
5. **Slice 5 (optional) — unified scheduler.** Route foreground children through the
   coordinator via a dedicated subagent lane or reentrant permits; provider-level
   backpressure and nested depth.

## Status

Draft, revised after architecture review. No implementation yet. Slice 1 is the recommended
first PR; it is the smallest change that turns delegation from blocking to non-blocking and
directly addresses the `RECEIVED` stall, provided it ships with the fail-safe handoff
marker.
