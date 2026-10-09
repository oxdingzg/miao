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
before calling `SecureChannel.startClient().finish`. Device-to-device transport
and owner/claim integration are follow-up work, not enabled by these primitives.

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
