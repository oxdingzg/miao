# Remote session RPC, version 1

This contract runs inside the authenticated [secure channel](SECURITY-PROTOCOL.md).
The first client payload is the base64url-encoded JSON `ClientHello`; the reply
is the encoded `ServerHello`. All later payloads are authenticated encrypted
frames. A device key must already have a locally approved, unexpired grant.
Pairing and Hub account authentication are separate control-plane operations.

## Requests

```json
{
  "version": 1,
  "requestID": "<fresh UUID v4 for this request>",
  "hostID": "<host identity>",
  "runtimeID": "<current Runtime identity>",
  "grantID": "<locally approved grant>",
  "grantVersion": 1,
  "method": "session.prompt",
  "sessionID": "<session identity>",
  "operationID": "<stable UUID v4 for this business operation>",
  "payload": {}
}
```

`projectID` is optional except for session creation. If both project and session
are supplied, they must agree with authoritative placement. Session operations
require a session identity. The Agent rejects stale Runtime/grant identities
and out-of-scope projects before calling a handler. Request IDs correlate
transport responses; operation IDs survive reconnection and retain immutable
business parameters. A handler's durable receipt determines acceptance.

Read methods: `capabilities`, `project.list`, `session.list`, `session.get`,
`session.history`, `session.events`, `session.pending`, `session.diff`,
`selection.list`, `operation.get`. They require `read` permission. Writable
methods and permissions are `session.create` → `session.create`,
`session.prompt` → `prompt`, `session.interrupt` → `interrupt`,
`session.rename` → `session.rename`, `permission.reply` → `permission.reply`,
and `question.reply` → `question.reply`. All writable methods require an
operation ID. Only registered methods are callable; payload validation and
result semantics are supplied by each authoritative Runtime handler.

Directory queries must filter before serializing results. An operation query
must not reveal another device's receipt. Approval is limited to the current
request; the data plane provides no permission to save permanent tool rules.
An interrupt must include the observed execution identity in its method
payload. A read grant does not permit writes, even to a visible session.

## Responses and chunks

Success: `{version: 1, type: "result", requestID, data}`.
Failure: `{version: 1, type: "error", requestID, code}`.
Codes are `forbidden`, `not_found`, `conflict`, `expired`, `outcome_unknown`,
`invalid_request`, or `unavailable`. Internal exception messages are omitted.
Protocol violations and untrusted device identities close the channel.

Responses over 96 KiB use encrypted chunk objects:

```text
{version: 1, type: "chunk", transferID, index, total, payload}
```

`payload` is canonical base64url encoding of up to 64 KiB of the serialized
response. Index starts at zero and increments by one; transfer ID and total
stay fixed. At most 128 chunks / 8 MiB are permitted. Reassemble before parsing
the response or applying state. Reject invalid order, inconsistent identities,
oversized payloads and incomplete transfers. A new connection discards partial
transfers; channel sequence counters and keys are never reused. Results are
not truncated to fit a frame.

Neither a successful socket write nor a Hub acknowledgment is an operation
receipt. A lost response remains uncertain until `operation.get` or a method's
documented exact-retry mechanism establishes its authoritative outcome.
