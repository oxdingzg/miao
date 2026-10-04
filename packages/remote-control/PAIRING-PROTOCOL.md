# Device pairing

The pairing coordinator is an optional Agent capability. Runtime administration
and client scanning interfaces still need to invoke it; a deployed Agent does
not enable pairing merely because this module exists.

An owner issues a scoped invitation containing protocol version 1, pairing ID,
256-bit secret, Hub URL, host/runtime IDs, pinned host public key and expiry.
Invitations last at most three minutes, expire no later than the proposed grant,
and are limited to eight concurrent flows. Put invitation secrets in a URL
fragment or transfer them directly; never place them in query strings or logs.
The invitation contains no local Server password or Hub host credential.

The client creates the normal signed ClientHello and submits this initial frame,
encoded as base64url JSON through the Hub client channel:

```text
{ pairingID, label, hello, proof }
```

`proof` is lowercase hex HMAC-SHA256 using the invitation secret bytes over the
canonical JSON transcript:

```text
["miao.control.pair.v1", pairingID, label, hello]
```

Canonical JSON recursively sorts object keys and retains array order. The signed
hello binds device identity, its fresh challenge, agreement key, host and runtime.
The Agent verifies both proofs before reserving a single candidate. Ten attempted
claims exhaust an invitation. Competing valid claims cannot reserve two devices.

The response is the usual signed ServerHello. The client verifies it against the
host key from the invitation and establishes a provisional encrypted channel.
The Agent sends an encrypted `{ version: 1, type: "pairing", status: "pending",
pairingID }` notification. The device has no Session authorization at this point.
Any business frame sent before approval closes the connection and rejects the
pending flow rather than queuing a write.

Local administration lists the candidate public key, label, client challenge,
proposed scope and expiry, without exposing the invitation secret. Approval must
name the exact candidate public key and cannot expand the invitation's scope.
After the grant is durably persisted, the Agent sends an encrypted notification
with `type: "pairing"`, `status: "approved"` and the grant. Subsequent normal RPC
requests name that grant and version and undergo the standard scope checks.

Rejection, expiry, disconnect or shutdown cancels a pending flow. Shutdown stops
new invitations and waits for in-flight local grant writes before storage
ownership can be released. Once approved, the device uses its persistent signing
identity and grant; the invitation is consumed and cannot be reused. If the
approval notification is lost, a client recovery flow must reconcile its grant;
clients must not treat an uncertain approval as permission to send business RPC.
