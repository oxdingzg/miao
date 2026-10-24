# HTTP client backpressure and cursor-resume acceptance (2026-10-24)

Executed the committed `packages/miao/test/server/event-backpressure-http.test.ts`
against the production server assembly and production `@miao/client` SDK:

```text
bun test test/server/event-backpressure-http.test.ts

2 pass
0 fail
135 expect() calls
Ran 2 tests across 1 file. [3.10s]
```

This is a live loopback HTTP/TCP acceptance using actual client decoding and
server routing. It is not a mocked stream or a claim about a manually driven
editor/TUI. Event content is generated deterministically; no model credentials
or paid provider calls are involved.

## Slow reader isolation

A raw TCP SSE client reads `server.connected`, then pauses socket reads. A
second, healthy SDK client keeps consuming the same live event stream.
The test publishes 128 batches of 64 text deltas, each containing 4096 bytes:
8192 events and 32 MiB of text payload before SSE/JSON overhead. Between
batches it waits for the healthy client to observe the batch's last event.

After resuming reads, the slow connection is closed or its chunked response
terminates, while the healthy client has observed the final sentinel without
an error. A newly connected SDK client and the original healthy client both
receive a new probe event. This verifies isolation and reconnection, not a
measured process-RSS bound or equality of every intermediate event.

## Durable cursor replay without duplicates

A second live SDK connection creates a Session and observes its durable
sequence-zero event. After disconnection, two title changes commit. Reconnect
using `after: 0`, receive the missed events, then commit one more title change
while the connection follows live events.

The received sequences must be exactly `[1, 2, 3]`, with three distinct event
IDs and the final Session title matching the third change. This verifies the
exclusive cursor boundary, replay-to-live transition, and absence of duplicate
frames in this acceptance sequence.
