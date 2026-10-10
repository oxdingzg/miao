# ADR-11: The client contract and where compatibility sits

Status: Proposed. Extends [ADR-07](0007-http-acp-adapters.md) (which deferred the
product-HttpApi adapter) and [ADR-08](0008-delivery-and-migration.md) (migration).

## Context

The product's client contract is a typed HTTP API, not the engine's wire:

- `packages/protocol/src/groups` defines ~29 groups and ~124 endpoints
  (`session` 32, `runtime` 11, `pty` 9, `workspace`/`permission`/`integration` 7,
  `mcp` 6, `project` 5, …) plus an event stream.
- The shell consumes a client **generated from that schema**
  (`packages/client/src/generated`), and the server implements it under
  `packages/server/src/handlers`.

The engine exposes a different contract: `POST /rpc` (its own command table),
`GET /events` (SSE) and ACP. The two are not interchangeable, so the shell cannot
consume the engine as it stands, and "replace the runtime directly" has to answer
where the compatibility boundary lives.

## Decision

- **The compatibility boundary sits in the product server façade, not in the
  engine.** The engine keeps its own wire; a façade maps the product HttpApi and
  event stream onto engine commands and events. This keeps the engine
  contract-independent and avoids re-creating the product API inside it.
- **For a direct replacement that keeps the shell, use the engine core + façade
  shape.** Keep the HttpApi, the generated client and the shell; reimplement the
  server handler bodies as engine calls and bridge the event stream. The client
  does not change; the migration cost is the handler behaviour, not the transport.
- **Do not reimplement the product HttpApi inside the engine.** Implementing the
  ~124 endpoints in Rust duplicates the product API and contradicts "the engine
  keeps its own wire"; rejected.
- **A client rewire is the same shape with more churn.** Making the generated
  TypeScript client speak the engine wire is the façade decision moved into the
  client; rejected as more work for no benefit.
- **A TypeScript-free product is a separate, larger decision.** Dropping the
  shell means a new shell over the engine wire (ADR-08 M4c); that is not the
  default and is taken only if removing TypeScript is itself the goal.

## Consequences

- The shell keeps working throughout the migration; only handler bodies move.
- The hard part is the behaviour-bearing groups (`session`, `runtime`, `pty`,
  `permission`), not the ~124 route definitions; `client-contract.md` enumerates
  the surface so the façade can be scoped handler by handler.
- The engine's own transports (stdio/HTTP/ACP) remain the contract for
  non-product clients (editors, headless), unaffected by this decision.
- Deferred: which handlers are pure passthrough versus behaviour-bearing, and the
  concrete event-stream bridge.
