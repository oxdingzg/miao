# Runtime upgrades and release compatibility

## Contract

Installing a release must not interrupt a running Session, stop a Runtime, or
require every window to exit. Existing windows keep their loaded client build;
new windows load the installed build and join the compatible owner of their
database. A software release number is diagnostic identity, not a wire protocol
compatibility test.

This contract applies to the TUI, run, ACP, and local Runtime administration.
Explicitly attached servers keep their existing connection semantics.

## Compatibility and identity

Local discovery and challenge proofs already carry a wire protocol version.
The currently supported protocol is 1. Both discovery and proof decoding reject
unsupported protocols before any administrator credential is sent. The signed
proof must still match the discovered release, Runtime ID, canonical storage ID,
listener address, and protocol. Replacing the expected client release with the
discovered owner release does not remove any of those identity checks.

All releases advertising the same protocol must preserve the existing client
contract: paths, required request fields, response and event meanings, durable
input admission, replay cursors, and interruption identities. Additive features
must remain optional for older clients. A newer client must not assume that an
older owner implements a new operation simply because their protocols match.
Before shipping such a feature, add capability negotiation and its client
fallback, or introduce a protocol version with explicit compatibility adapters.
Changing a software version alone is never a substitute for doing this work.

A breaking protocol change requires a new protocol version and a deliberate
rolling upgrade design before release. Unsupported peers fail closed; clients
must not kill another window's owner to make themselves compatible. Database
migrations stay with the one storage owner, never a joining client.

## Installation and execution lifetime

The installer updates the program on disk. Running clients and the Runtime keep
their loaded code. Client release and service release may consequently differ;
`miao runtime status` reports the actual service release and protocol.

One persistent database continues to have one Runtime, one OS storage lock, and
process-local Session execution coordination. Sharing a compatible owner must
not start another Runtime, migrate its database, promote inputs twice, change
its startup configuration, or restart an active provider/tool call.

This change deliberately preserves the shared-service execution model. A new
client does not imply that the shared service's execution code has hot-reloaded.
Applying service changes uses a graceful explicit stop after tasks finish. Stop
verifies the owner across releases and waits for discovery removal and lock
release. If a successor starts during shutdown, stop reports it and never shuts
down the successor automatically. Automatic installation does not call stop.

## Future service replacement

An automatic service upgrade needs an owner-side admission barrier, connected
client/remote lease accounting, durable pending-input checks, and an execution
quiescence signal. Checking only active model calls or visible windows is not
sufficient: queued inputs, approvals, remote clients, and concurrently admitted
prompts must be accounted for. A new owner may open or migrate storage only
after the prior owner releases its lock. An interrupted provider/tool call must
never be automatically replayed as part of an upgrade. `specs/runtime-lifetime.md`
designs the Runtime lifecycle and the idleness that supplies the quiescence
signal.

Running different execution builds simultaneously for one database is a
separate architecture change. It requires the Runtime to retain durable
admission and storage coordination while versioned execution workers acquire
one serialized ownership chain per Session. It cannot be implemented by
launching two existing Runtimes, using a lock per release, or copying databases.
That architecture is not required for compatible client windows to coexist and
is not claimed by this change. `specs/v2/execution-workers.md` designs that
change.

## Regression coverage

- A client joins an older or newer release with the supported protocol.
- Concurrent joining clients reuse the same owner without requesting shutdown.
- The owner retains its storage lock throughout client joins.
- Unsupported protocols and forged identity proofs never receive credentials.
- A different startup configuration cannot replace the running owner's config.
- Cross-release stop verifies identity and returns only after storage is free.
- The actual Runtime host still authenticates clients, persists Session history,
  refuses a second owner, and shuts down cleanly.
