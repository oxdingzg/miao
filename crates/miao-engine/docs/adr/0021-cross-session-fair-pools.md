# ADR-21: Cross-session fair pools

Status: Accepted (implemented by the job and subagent pools in
`crates/miao-engine/src/runtime.rs`, pinned by `tests/resource_bounds.rs`).

## Context

One engine process hosts every Session of a workspace. The background-job
pool and the subagent pool are process-wide semaphores, so they cap the
fleet but not the tenant: one Session's long-running jobs or delegated
children could hold every permit while the other Sessions' work queued
behind it. To the waiting Sessions that is indistinguishable from a hang,
and nothing accounted for the wait.

Drains already serialize per Session through the durable claim, and each
Session holds at most one drain by construction, so cross-Session
unfairness concentrates in the two delegation pools. Terminals (32
fleet-wide, 8 per Session) and LSP servers (8 configured) carry registry
bounds of their own and already refuse at their limit.

## Decision

- **A per-Session share sits under each delegation pool's fleet cap.**
  Jobs: two of the four fleet slots. Subagents: two of the four fleet
  slots. A Session at its share waits for one of its own permits to come
  back instead of taking another, which keeps a free slot available for
  the next Session. With the share at half the cap, two Sessions always
  proceed at full share and the fleet bound keeps its strength.
- **Queueing, not rejection.** The hard fleet limits (the jobs registry
  cap, the terminal registry, the LSP plan) reject with a message naming
  the limit; a fair share only delays. A share-gated call is visible as
  queue accounting, never as an error.
- **Waits are cancel-aware.** The share wait registers its wakeup before
  re-reading the share (`Notify::enable` before the check), so a release
  cannot be missed; the fleet wait keeps the semaphore's FIFO order
  across Sessions.
- **Observability is part of the bound.** `Runtime::resources()` reports
  every pool's limit, per-Session share, active and queued counts,
  admitted count, and queue wait (total and max). Drain slots gain the
  same accounting; their claim and fencing semantics are untouched.
- **Constants until a measurement justifies a knob.** The same stance as
  the read batch bound (ADR-13): the numbers are named constants, and a
  measurement would have to argue for a policy surface.

## Consequences

- A single Session keeps the parallelism it had: two concurrent jobs
  (the old fleet cap) and two concurrent subagent children; what it
  loses is the ability to hold the whole fleet while others wait.
- A Session's next job pays a share wait only while it holds its share;
  once one of its own jobs settles, the gate opens and the fleet
  semaphore applies.
- The stress harness (`tests/fairness_measurement.rs`) samples the queue
  accounting, RSS, and the fd curve under sustained concurrent load;
  the numbers land in `docs/acceptance` records.
- Still open: queue-latency and starvation curves under sustained
  real-client load beyond this harness, and any dynamic re-balancing of
  shares.
