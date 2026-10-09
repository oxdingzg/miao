# Device pairing

The pairing coordinator is an optional Agent capability. A configured Runtime
composes it with the outbound Agent and exposes owner-authenticated local
administration. Unconfigured Runtimes report device access as disabled.

An owner issues a scoped invitation containing protocol version 1, pairing ID,
256-bit secret, Hub URL, host/runtime IDs, pinned host public key and expiry.
Invitations last at most three minutes, expire no later than the proposed grant,
and are limited to eight concurrent flows. Put invitation secrets in a URL
fragment or transfer them directly; never place them in query strings or logs.
The invitation contains no local Server password or Hub host credential.

The TUI's `/remote-control` command (also available as `/remote`) opens the
device and IM access menu. The device dialog proposes either one-hour read-only
or interactive access to the current Session, or seven-day interactive access
to the current registered project, including Session creation. The local owner
must explicitly approve the scanned device after comparing its SHA-256 public
key fingerprint, scope, permissions and grant expiry. Device labels are
untrusted; the dialog strips terminal controls and bidirectional formatting.

For an App invitation, the QR code and copy action use this URI:

```text
miao://pair#<base64url UTF-8 JSON invitation>
```

An operator may instead configure a same-origin HTTPS browser entry:

```text
https://relay.example.invalid/control/#pair=<base64url UTF-8 JSON invitation>
```

The path is deployment configuration, not a protocol constant. A browser client
accepts the fragment only when the invitation's Hub origin matches its own,
removes it from the address bar before asynchronous requests, and retains the
short-lived invitation in tab-only session storage across account login. After
login, it consumes and removes that saved invitation and starts the same local
approval handshake below. OAuth callback codes remain separate from invitations.

The fragment decodes to the entire version-1 invitation above. QR expiry is
distinct from grant expiry. If the terminal cannot fit the entire QR code, the
dialog offers copying the same link rather than displaying a clipped code.
Closing the dialog cancels its unapproved invitation, including an invitation
whose issue response arrives after the window closes. A confirmation view does
not dispose the invitation. Revocation names the observed grant version and
disconnects the device without interrupting the Session's execution.

This URI documents the native client entry point; it does not itself provide a
published App or a hosted web frontend.

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
