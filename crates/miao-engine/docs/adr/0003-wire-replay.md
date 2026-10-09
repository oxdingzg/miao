# ADR-03: Wire, replay and subscription

Status: Accepted (stdio adapter implemented by `src/protocol.rs`,
`src/main.rs`, `src/events.rs`; HTTP/ACP adapters planned).

## Context

Clients attach over different transports and can fall behind, reconnect, or
crash. The engine needs a replay contract that is safe under lag and handoff,
and it must not let a slow subscriber stall execution.

## Decision

- **Adapters own their envelope.** The internal command/event model does not
  require any particular external framing. A stdio adapter ships first; an HTTP
  compatibility adapter and an ACP adapter are separate mappings of the same
  domain model.
- **Durable cursor.** Canonical events carry an ordered, unique cursor. A
  subscription captures a high-watermark, replays up to it, then continues
  live from it. The cursor only needs to be ordered and unique, not gapless after
  client-side filtering.
- **Bounded streaming.** Text/reasoning/tool-input deltas are a bounded transient
  stream and may be merged into durable message updates that expose a committed
  watermark. Deltas a client saw but that were never committed may be replaced by
  a snapshot after a crash; this boundary is stated to clients.
- **Snapshot and resync.** A snapshot carries session, epoch, cursor and
  outstanding requests. A cursor too old to replay takes the resync path.
- **Lag is isolated.** A slow subscriber has a bounded queue and is disconnected
  or told to resync on overflow; it can never apply backpressure to the provider
  or the run loop.
- **Two cancellation messages.** "Cancel accepted" and "execution stopped" are
  distinct events; a half-finished item is terminated as interrupted.
- **Version negotiation.** Protocol version/capability negotiation and the
  behaviour for unknown events are adapter concerns and must be explicit before
  a non-stdio adapter ships.

## Consequences

- Reconnection and handoff are testable without stop-the-world semantics.
- A misbehaving client degrades only itself.
- Adding an adapter is additive; it does not change the domain model.
