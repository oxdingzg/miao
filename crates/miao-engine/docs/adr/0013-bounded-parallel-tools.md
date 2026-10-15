# ADR-13: Bounded parallel tool execution

Status: Accepted (implemented by `execute_read_batch`, pinned by
`tests/read_batch.rs`).

## Context

One assistant turn may request several independent tool calls. The turn loop
prepares, executes, and settles them one after another, so three independent
reads cost three sequential round trips against the filesystem and the language
server. The loop also carries behaviour that assumes one call at a time: ordered
permission checks and approvals, `tool_result` and PostToolUse events, repeat
detection, invalid-JSON correction accounting, and the boundary reload that
follows committed results.

## Decision

- **Only declared reads run in parallel.** A call joins the batch by its own
  declaration, not its name: it must prepare as `Access::Read` against a
  named resource and be policy-allowed. Two to sixteen such calls in one
  turn run concurrently; every tool that declares a write — or declares
  nothing — conflicts with the batch and stays serial, so an unknown or
  newly added tool is handled conservatively. `read_image` declares a read
  resource like its siblings and joins the set.
- **Preparation stays ordered and serial.** Permission checks, approvals,
  argument validation, and replay lookup run for every call in request order
  before any of them executes, so an approval prompt and its binding never
  depend on which read finished first.
- **Execution is bounded.** At most four read calls run at once. The bound is a
  constant rather than a policy knob until a measurement justifies one.
- **Mixed turns preserve barriers.** Only the leading prefix of two to sixteen
  admitted reads batches. The first write, unknown tool, denied call, invalid
  argument, or provider-executed call ends that prefix. The remaining calls
  execute serially in request order: a read after a write sees the write's
  result, and no write overlaps the batch. A prefix shorter than two stays
  serial; an oversized prefix stays serial rather than changing the bound.
- **Settlement stays ordered.** Results are committed in call order with the
  same `tool_result` and PostToolUse events as today, so a reader of the event
  stream cannot distinguish parallel execution from a fast serial one. The batch
  announces itself once (`tool.parallel.started`, naming its call ids and the
  bound), and a tool whose result came from the batch is settled without
  re-running it.
- **Cancellation is shared.** Each call receives the same child token: a
  cancelled turn stops every in-flight read and settles the calls that did not
  run as interrupted, matching the existing single-call rule.
- **Failure is per call.** One read failing does not cancel its siblings; the
  turn continues with the results it would have produced serially.

## Consequences

- The saving is bounded by the slowest member of the read set, so the
  measurement to record is per-turn overlap (summed tool time against wall
  time) plus the critical path. Durations are deliberately kept out of event
  payloads, because the blackbox tape replay pins those payloads exactly and a
  wall-clock value is not reproducible; the evaluation runner measures the
  batch from its own receipt times instead (batch count, the reads the batch
  named, and the observed window). The `tool.parallel.started` event names
  each member's declared resource, so a run's read-set lineage is auditable.
- Scheduling inside one turn is declaration-driven and batches safe read
  prefixes of mixed turns. Scheduling across turns stays open. Writes never
  overlap anything.
