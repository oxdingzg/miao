# Signed account device rosters

The validation and durable authority core is implemented in `device-roster.ts`
and `grants.ts`. Local Runtime owner controls can now bind and cancel delegation. Client
enrollment transport and its browser/iOS UI still need integration before this
enables the full account-wide workflow. Roster-claim admission is now supported.

## Local authority

Account login alone does not authorize a device to access Sessions. A local
owner first approves a device through the existing invitation handshake, then
explicitly binds its signing key to an account. The account ID comes from the
host's authenticated Hub setup, not a device claim. The Hub origin is pinned
locally alongside it. A Hub cannot bootstrap trust by delivering a self-signed
roster.

`DeviceGrants.bindAccount` requires the exact ID and version of a live approved
grant. It records that key as the initial signer, accepted sequence zero, and
an owner-selected permissions/scope/expiry policy. Existing files without
account trust remain readable. Network updates cannot rebind that authority or
change its policy.

## Signed envelope

```json
{
  "version": 1,
  "roster": {
    "version": 1,
    "accountID": "account_identifier_0001",
    "sequence": 1,
    "issuedAt": 0,
    "devices": [
      {
        "publicKey": "<base64url uncompressed P-256 point>",
        "label": "Owner device",
        "signer": true,
        "addedAt": 0
      }
    ]
  },
  "signature": "<base64url 64-byte P1363 ECDSA signature>"
}
```

Signing uses ECDSA P-256/SHA-256 over UTF-8 canonical JSON of
`["miao.control.roster.v1", roster]`, with recursively sorted object keys.
Signatures use IEEE P1363 `r || s`, not DER. Device keys must be valid canonical
65-byte uncompressed P-256 points, unique and sorted by literal public-key
string ordering. There are 1–64 devices. All timestamps and sequences are safe
non-negative integers; sequence starts at one. Timestamps are display metadata
and never decide whether a roster is authorized. Unknown fields are rejected.

A host verifies a signature against signer keys from its **previously accepted**
local state. An incoming table cannot nominate its own signer. Account IDs must
match, and sequence must strictly advance. Equal-sequence forks and rollbacks
are rejected, even when signed by an otherwise trusted key. Verification takes
an immutable snapshot before asynchronous cryptographic work.

## Durable update and revocation

Account trust lives in the same owner-only, symlink-rejecting, size-limited
`devices.json` as grants, under the existing OS-backed cross-process lock.
Accepting a new roster and revoking grants for removed keys share one atomic,
fsynced file replacement. This avoids a separate roster/grant transaction that
could persist one half and expose revoked devices after a restart. Revocation
advances each affected grant's version, so existing data-plane authorization
checks reject it. Other keys and local policy remain unchanged.

Membership updates do not issue grants. Enrollment must separately prove
possession of the member's signing key and apply the local owner's policy.

## New-device host trust

A new device must not treat directory-provided host public keys as trusted.
`HostEndorsement` lets a previously trusted device transfer the keys it learned
from local pairing. It signs canonical JSON of
`["miao.control.host-endorsement.v1", payload]`, using the same P1363 encoding.
The payload includes the Hub origin, account, recipient device signing key,
recipient's fresh enrollment challenge, and a sorted, unique list of host IDs
and public keys. The recipient verifies against a signer key obtained out of
band from the approving device, never a signer key nominated by the Hub.

This separates two directions of trust: signed device rosters let a host admit
a member; host endorsements let that member authenticate the real host. Neither
account login nor an untrusted directory substitutes for either decision.
The enrollment UI must consume its nonce once and persist the endorsed keys
before calling `SecureChannel.startClient().finish`. Device-to-device transport and the enrollment UI remain follow-up work.
Local owner controls and roster-claim admission are described below.

## Local owner controls

Authenticated local administrator endpoints provide:

- `GET /api/runtime/control/account/trust`: authority summary or `null`.
- `POST /api/runtime/control/account/trust`: live `grantID`, exact `version`, and
  owner-selected `policy`. The account ID comes from current authenticated
  Runtime configuration; request-supplied identities are never used.
- `DELETE /api/runtime/control/account/trust`: atomically remove account
  authority and revoke its member keys' grants, then disconnect live peers and
  revoke their notification registrations.

The desktop device dialog presents separate confirmations for trust and
cancellation. Its default trust proposal retains the selected device's scopes
and permissions, excludes Session creation, and expires after 90 days. The
confirmation displays that scope and deadline. Cancellation is available even
when relay transport is disabled and preserves local model work. Unrelated
manually paired devices remain authorized.

## Roster-claim admission

An account device may send a first frame with `version: 1`,
`type: "rosterClaim"`, the authenticated host account ID, a signed `hello`, and
an optional signed `roster`. The host uses its own configured account ID and
local trust binding. It verifies the ClientHello signature and target before
updating any authority or issuing a grant. A supplied table must advance local
authority, or exactly match the already accepted canonical digest; stale tables
and equal-sequence forks are rejected.

Only a durable roster member receives an encrypted approval grant. Its
permissions, scopes and absolute expiry come exclusively from local policy.
Managed grants have a private key-to-grant-ID index, use one bounded row per
member and reuse unchanged versions on reconnect. Revoked matching-key rows can
be recycled after a local reset with an advanced version. Existing manual grants
are not upgraded by ordinary admission. Authority and row updates share the
existing atomic file/lock transaction; repeated unchanged claims avoid file
writes. This supports the current explicitly displayed policy expiry; it does
not silently extend delegation beyond that deadline.

`BrowserChannel.connect` accepts an optional roster admission descriptor,
consumes the encrypted approval, validates the returned grant for its own device
identity and passes it to the RPC client. It still requires an independently
trusted host public key. Hub directory metadata cannot supply that trust.

## Device enrollment proof

`DeviceEnrollment.request` creates a signed, account-and-Hub-bound request for
one device public key and display label. The domain is
`miao.control.enrollment.v1`. A fresh 32-byte challenge and ten-minute expiry
bind the response; approving devices verify proof of possession before adding
membership. Only an already accepted local signer may approve, using a roster
whose sequence and canonical digest match durable local authority. A new member
is not made a signer. Endorsed host keys must come from the approving device's
independent pairing state.

The approval contains both a signed next roster and a recipient/challenge-bound
`HostEndorsement`. The recipient separately supplies the approving signer's key
obtained out of band. A signer key nominated by the Hub is not sufficient. Both
signatures, recipient membership and the host endorsement must validate before
trust may be persisted. `DeviceEnrollment.make` manages one tab-local pending
request, consumes it once and fences verification against cancellation or a
newer request. Callers cancel it on account changes and persist the accepted
roster authority and host pins together before connecting.

The browser's account device registration section uses this exchange. A signing
browser is initialized only after independent computer pairing and explicit
signer consent. The computer must also explicitly bind its account trust to that
device. Existing self-signed authority can be restored using the same device key;
an unrelated device cannot replace an existing account root.

A new device generates a ten-minute request, transfers it directly to a trusted
signing device and receives the signed approval plus the independently supplied
signer public key. The approving browser verifies the request and local accepted
authority, publishes the next signed roster, and returns recipient-bound host
endorsements. The recipient verifies both signatures and saves roster authority
and host pins in one account-and-device-bound local record. This explicit code
exchange is independent of the Hub directory's asserted signer or host keys.

On connection, enrolled browsers refresh the roster against previously accepted
signers, compare independently pinned host keys, and send a roster claim. Only
an encrypted Agent approval provides the device grant used for session RPC.
The existing direct computer invitation flow is also available. Native mobile
registration, production OAuth and physical-phone acceptance remain separate
verification work.

## Hub roster transport

The Hub exposes authenticated-account metadata at these routes:

- `GET /api/hub/roster` returns `{ roster: null }` or `{ roster: record }`.
- `PUT /api/hub/roster` accepts `{ sequence, payload, signature, digest }`.
  `payload` is the canonical roster object described above; `signature` is the
  signed roster's P1363 base64url signature; `digest` is its domain-separated
  canonical fingerprint from `DeviceRoster.fingerprint`. The record adds
  `accountID` and `updatedAt`.
- `GET /api/hub/roster/history` returns `{ history: [{ sequence, digest,
updatedAt }] }`, newest first, limited to 16 revisions.
- `GET /api/hub/roster/devices` returns `{ devices: [...] }`, or an empty list
  when no roster has been submitted.

Every route derives the account from live authentication. Updates require
JSON, enforce a 64 KiB request limit, validate device-key shape and curve
points, and compare the canonical digest. The payload account and sequence
must match the authenticated account and outer sequence. Sequence updates and
history insertion/pruning are one transaction; stale or equal sequences return
`409`, including concurrent updates. Logout invalidates both reads and writes.
History is bounded by count even when sequence numbers have gaps.

The Hub does not decide which signing root is trusted. Stored signatures and
membership metadata are untrusted until a local Agent or recipient checks
its independent trust state. Uploading a roster does not itself admit a device
or supply trusted host keys. The browser registration section connects this
transport to independently verified roster and host authority.

An explicit additive `HubRoster.migrate` creates the versioned metadata tables;
service startup with migration enabled performs it alongside directory migration.
Existing databases can continue serving other APIs without these tables, while
roster endpoints return `503` until an administrator runs migration. Unknown
roster schema versions fail startup rather than resetting metadata.

Development fixtures may explicitly opt into HTTP enrollment and endorsements
on `localhost`, `127.0.0.1` or `::1`, matching the existing browser channel's
loopback-only test mode. HTTPS remains the default; the opt-in never permits a
non-loopback HTTP Hub. `check:web:enrollment` exercises two independent browser
contexts against a real Runtime, including owner binding, wrong-pin rejection,
encrypted member admission, reload, grant reuse and local owner revocation.
