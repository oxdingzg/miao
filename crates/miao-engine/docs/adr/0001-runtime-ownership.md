# ADR-01: Runtime ownership and lifecycle

Status: Accepted (implemented by `src/runtime.rs`, `src/store.rs`).

## Context

The engine must own durable session state, schedule model and tool work, and
never execute the same session twice across processes. Control (admission,
approval, cancellation) must stay responsive while a provider turn or a
long-running tool is in flight, and background work must outlive a single
provider turn without being silently killed by turn cancellation.

## Decision

- **Single durable owner per database.** Opening the store takes an OS advisory
  lease; a second process that cannot take the lease fails to start rather than
  running a second executor against the same rows.
- **Session coordinator.** Each session has one control loop. It promotes
  admitted inbox rows, consumes approvals and results through `select!`, and
  never blocks the control mailbox on a provider or tool await.
- **Bounded execution slots.** A process-global `Semaphore` bounds concurrent
  session executions (8) and background jobs (2); acquisition is cancellable so
  a session cancel releases a waiter immediately.
- **Location-scoped capabilities.** Model resolution, tool registry, permission
  policy and filesystem root are scoped to the session's `Location`. An omitted
  workspace keeps the implicit-local placement; placement is looked up by
  session id only when a drain starts.
- **Distinct cancellation scopes.** Interrupting a turn, cancelling a session,
  cancelling a job, and process shutdown are separate operations with separate
  reach; a cancelled turn does not delete a job already promoted to the
  background supervisor.
- **Process-local execution.** Session drains and background jobs are
  process-local; clustering is explicitly out of scope. A crashed process leaves
  no in-memory owner, and its in-flight work is reconciled (ADR-02) rather than
  replayed.

## Consequences

- Control latency does not depend on provider or tool latency.
- Global admission limits prevent one session or parent task from exhausting the
  execution lanes.
- Horizontal scale-out is deferred; recovery rests on durable state, not on a
  surviving process.
