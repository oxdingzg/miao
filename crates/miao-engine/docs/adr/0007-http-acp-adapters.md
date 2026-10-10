# ADR-07: HTTP and ACP adapters

Status: Proposed (M2; adapters not yet implemented. Extends
[ADR-03](0003-wire-replay.md) and [ADR-04](0004-authority.md), which planned a
non-stdio adapter and required explicit negotiation and authenticated authority
before one ships.)

## Context

The engine's domain model — `Runtime` plus the request/event vocabulary — is
currently reachable only over local stdio (`src/main.rs::serve`,
`src/protocol.rs`, `PROTOCOL.md`, revision `engine-stdio-0`). Two client classes
cannot use stdio: a remote or out-of-process client that attaches over the
network, and an editor that speaks the Agent Client Protocol (ACP). ADR-03 fixed
the adapter shape (adapters own their envelope; the domain model does not change;
lag is isolated; version negotiation and unknown-event behaviour must be explicit
before a non-stdio adapter ships). ADR-04 fixed that authority is a controller
capability, and `serve` already notes that a network adapter must authenticate
before receiving that handle. This ADR records the M2 wire decisions for both
adapters.

## Decision

- **One domain seam, three transports.** Extract the current request dispatch out
  of `serve` into a transport-agnostic handler that maps a framed request to the
  same `Runtime` operations. The stdio envelope (`engine-stdio-0`) is unchanged;
  HTTP and ACP are new framings of the same handler and share
  `Runtime::controller()` and `Runtime::progress()`. Adding an adapter never
  changes the domain model or renames the frozen event vocabulary.
- **Revision per transport, negotiated, additive-only.** The stdio revision stays
  `engine-stdio-0`. HTTP introduces `engine-http-0`; ACP uses its own
  `protocolVersion` (currently 1). New optional params, methods, payload fields
  and event kinds are compatible; renaming or removing a name, or changing a
  reserved field, is a break. A client refuses a revision it does not know, and a
  client must ignore an unknown event kind or field: the vocabulary only grows.
- **Unknown requests fail, unknown events pass.** An unknown or malformed request
  method returns a typed error (`invalid_request`) and never reaches the runtime.
  An event kind a consumer does not recognise is forwarded and ignored, never
  promoted to a fatal error, because the vocabulary is additive.
- **HTTP maps the method table, not the whole product HttpApi.** M2's HTTP
  adapter is a thin, versioned mapping of the same method set as stdio (session,
  events, approvals, questions, jobs, schedules, history, context, export)
  expressed as JSON requests plus a Server-Sent Events stream for committed
  `event` notifications and ephemeral `progress`, keyed by the durable `seq`
  cursor. Parity with the existing TypeScript HttpApi (`@miao/protocol/api`) is
  explicitly **not** an M2 goal; if it is wanted it is a separate adapter or a
  later milestone, so this crate does not take a dependency on the product
  protocol schema.
- **HTTP authority is authenticated and bounded.** The HTTP adapter binds to
  loopback by default and requires a bearer token. Only an authenticated
  connection may be granted the controller capability, and only a controller may
  `approve` or `answer_question`; first-answer-wins and `already_resolved`
  behaviour is unchanged. Read, list and subscribe do not require the controller
  capability. TLS termination is left to a reverse proxy rather than taken as a
  server dependency.
- **Subscriber lag stays isolated.** Each HTTP/ACP subscriber has a bounded
  queue; on overflow it is told to `resync` or disconnected, and a cursor too old
  to replay takes the same snapshot/resync path as stdio. A slow subscriber can
  never apply backpressure to the provider or the run loop, and the
  replay-to-live handoff has no gap or duplicate.
- **ACP is an editor mapping of the same model.** The ACP adapter is a
  newline-delimited JSON-RPC `Agent` implementation: `initialize` and
  `authenticate`, `session/new|load|resume|fork|list|close`, `session/prompt`,
  `session/cancel`, `session/set_mode`, `session/update` notifications, and
  permission requests mapped to engine approvals. Canonical events and ephemeral
  progress drive `session/update`; ACP content, tool and preview blocks map to
  canonical message parts. The engine refuses an ACP revision it does not
  implement. Behaviour that must match the existing TypeScript ACP surface is
  captured as shared scenarios and re-implemented, not ported line for line
  (ADR-05).

## Consequences

- A remote client and an editor reach the engine without a TypeScript runtime,
  and neither can widen authority past policy or stall execution.
- `engine-stdio-0` and the durable ledger are untouched, so existing stdio
  clients and the headless acceptance keep working unchanged.
- Version negotiation and unknown-request/event behaviour are explicit before the
  first non-stdio adapter ships, satisfying ADR-03.
- Deferred: full product-HttpApi parity, TLS termination, multi-client controller
  election, the TypeScript compatibility worker (M3), single-binary delivery
  (M4), and any Windows process enforcement.
