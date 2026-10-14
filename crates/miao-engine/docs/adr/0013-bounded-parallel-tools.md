# ADR-13: Bounded parallel tool execution

Status: Proposed (A6's first step; the engine still settles same-turn tools
serially).

## Context

One assistant turn may request several independent tool calls. The turn loop
prepares, executes, and settles them one after another, so three independent
reads cost three sequential round trips against the filesystem and the language
server. The loop also carries behaviour that assumes one call at a time: ordered
permission checks and approvals, `tool_result` and PostToolUse events, repeat
detection, invalid-JSON correction accounting, and the boundary reload that
follows committed results.

## Decision

- **Only declared reads run in parallel.** `read_file`, `glob`, `grep`,
  `list_files`, and `read_image` may run concurrently when one turn requests
  more than one of them; every other tool stays serial, and anything absent
  from that set is serial by default, so an unknown or newly added tool is
  handled conservatively.
- **Preparation stays ordered and serial.** Permission checks, approvals,
  argument validation, and replay lookup run for every call in request order
  before any of them executes, so an approval prompt and its binding never
  depend on which read finished first.
- **Execution is bounded.** At most four read calls run at once. The bound is a
  constant rather than a policy knob until a measurement justifies one.
- **Settlement stays ordered.** Results are committed in call order with the
  same `tool_result` and PostToolUse events as today, so a reader of the event
  stream cannot distinguish parallel execution from a fast serial one.
- **Cancellation is shared.** Each call receives the same child token: a
  cancelled turn stops every in-flight read and settles the calls that did not
  run as interrupted, matching the existing single-call rule.
- **Failure is per call.** One read failing does not cancel its siblings; the
  turn continues with the results it would have produced serially.

## Consequences

- The saving is bounded by the slowest member of the read set, so the
  measurement to record is per-turn overlap (summed tool time against wall
  time) plus the critical path, both taken from the durable event stream.
- Path-level resource declarations and conflict-aware scheduling stay open:
  this decision does not let a write overlap anything, and does not schedule
  across turns.
