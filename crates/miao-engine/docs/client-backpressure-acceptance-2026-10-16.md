# Client transport recovery — 2026-10-16

G3 evidence for the real product HTTP listener. The executable tests are
`packages/miao/test/server/event-backpressure-http.test.ts`; they start
`Server.listen`, use real TCP/HTTP, and consume events through the generated
client SDK. They do not replace the listener with a custom HTTP adapter.

## Slow-client isolation

One raw TCP client opens `/api/event`, waits for `server.connected`, then pauses
reads. A healthy SDK client stays attached. The publisher sends 8,192 valid
text-delta events with 4 KiB payloads (32 MiB of payload, excluding framing),
waiting for the healthy peer between batches.

The slow subscriber's response is ended/reset independently. The healthy peer
receives the final event and remains attached. A fresh SDK connection receives
a new probe, which also reaches the original healthy subscriber. Publisher
progress is checked throughout; a global stall or disconnect of the healthy
peer fails the test.

This demonstrates the live fan-out overflow boundary at the production TCP
transport, complementing the bounded-queue unit tests. It is not an absolute
RSS bound for the entire TUI/client pipeline: kernel buffers, HTTP buffering
and client batching are distinct boundaries.

## Durable cursor reconnect

A TypeScript-owned Session is created over HTTP and its initial cursor is
read, then the subscriber disconnects. Two titles are committed in the gap.
Reconnecting with `after: 0` yields exactly sequences 1 and 2; the same
subscription then receives sequence 3 committed while attached. Event IDs are
unique and Session GET agrees with the final title. The cursor is exclusive.

Native Session recovery is separately covered by #916: live reconnect
invalidates stale snapshots, rehydrates visible histories and pending
permissions/questions, and does not resurrect old partial text or completed
requests during races. The TypeScript durable cursor test must not be read as
proof that every ephemeral native provider delta is replayable.

## Validation and remaining scope

Local package typecheck passed, as did the server suite: 143 tests, 809
assertions. The new TCP tests use published readiness and consumption signals,
not fixed delays to guess when a subscriber is ready.

This closes the measured server-side slow-subscriber isolation and product
HTTP cursor boundary. Third-party editor reconnect UI, full client-process
memory bounds, native process restart during active work, and full cache/TTFT
presentation remain separate acceptance items.
