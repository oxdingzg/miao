# Push delivery

`PushProvider.create` implements the APNs HTTP/2 transport for generic session
attention and completion alerts. It signs ES256 provider tokens with a private
Apple push signing key, reuses each token for at most 50 minutes, and sends to
the selected Apple sandbox or production endpoint. The topic is the native
application's bundle identifier. Keep signing keys and identifiers in private
Hub configuration outside the checkout.

The payload contains only fixed alert text and an opaque signal identifier.
Session text, project paths, permission details and commands must never be
included. Opening an alert must resolve its signal through an authenticated
connection and read current session state; the alert itself grants no authority.

A successful response means Apple accepted the request, not that the phone
received it. The provider reports unregistered tokens separately, including the
invalidation timestamp when supplied. The registration store must compare that
timestamp with the token's latest registration before removing it. Rejected,
retryable and unknown outcomes remain distinct. Transport failures and deadlines
never cause automatic replay. The caller owns bounded scheduling and must
recheck current account, device and grant authorization before every attempt.

The provider bounds concurrent requests to 32, response bodies to 4 KiB and each
request to five seconds. `stop()` rejects new submissions and terminates its
connections. Production connections use TLS 1.2 or later; a separately explicit
loopback-only HTTP endpoint exists for real HTTP/2 integration tests.

This transport is one part of background notifications. Device registration,
revocation, Runtime signal routing, notification navigation and deployment with
an Apple push signing key require their own integration. A development signing
certificate alone does not configure a push provider.

Protocol references: [Apple APNs requests](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)
and [token authentication](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).

## Device registration storage

`PushRegistry` stores device public identities, environment-specific tokens and
registration generations in the private Hub database. Its schema migration is
explicit and independent of host metadata. Registrations bind to a verified Hub
account and its current login session; queries exclude expired or deleted login
sessions, and pruning removes their tokens. An account can store up to 32 device
identities. Token replacement keeps one current row per identity, and a token
cannot be assigned to two identities in the same APNs environment.

Unregistered-token responses remove only the exact registration generation used
for that delivery. The provider timestamp, when present, must also be at least
as recent as registration. A delayed response cannot erase a replacement token
or a renewed registration of the same token. Device revocation is account scoped.
Runtime subscription approval remains a separate authority check: storing a
push token alone must never subscribe a device to a host or session.

## Hub registration API

Enable `pushRegistrations: true` in private account-mode Hub configuration and
run the explicit migration before serving the upgraded database. The authenticated
version endpoint then advertises `push-registration`. Disabled instances expose
no registration routes and do not require the push schema.

`POST /api/hub/push/register` accepts `{deviceID, token, environment}` and returns
`{registeredAt, registrationID}`. `POST /api/hub/push/revoke` accepts `{deviceID}`
and idempotently revokes that account's device registration. Both require a live
Hub access bearer, accept at most 4 KiB of JSON within five seconds, reject
foreign browser origins and return `Cache-Control: no-store`. Successful account
sign-out prunes registrations whose login was deleted; registrations belonging
to other still-active logins remain usable.

This capability advertises registration storage only. It does not indicate that
Apple delivery credentials are configured or that Runtime subscriptions have
been approved. Those checks precede actual notification dispatch.

## Dispatch lifecycle

`PushDispatch` admits bounded ephemeral notices, selects a current registration
in the configured APNs environment, and sends only the generic alert and signal
ID. The separately stored context is opaque ciphertext intended for that device;
it never enters the Apple payload. The routing caller supplies the current
Runtime/grant authorization check. Transport invokes that check again after JWT
creation and immediately before HTTP/2 submission, together with registration
and dispatch-generation checks. Revocation can cancel an admitted request that
has not yet reached transport submission.

The dispatcher deduplicates admitted signal IDs, preserves uncertain outcomes
without replay, limits concurrent dispatches to 16, and retains at most 1024
notices for ten minutes. Context lookup requires the matching account and device,
a live login-bound registration, and still-current Runtime/grant authorization.
Renewing a token on foreground return preserves lookup of an already accepted
notice within that login; ending the login blocks it.
Revocation and shutdown discard contexts. An APNs unregistered response removes
only the registration used by that attempt. Delivery already accepted by Apple
cannot be recalled by these admission checks.

The dispatcher does not itself attest Runtime grants or produce encrypted context.
The Runtime must check the current device grant and session/project scope before
sealing and submitting each hint. Native context resolution is required before
notification navigation is usable.

## Hub delivery API

Private account-mode configuration may additionally set `pushProvider` with
`teamID`, `keyID`, PKCS#8 `privateKey`, bundle-ID `topic`, and `environment`
(`sandbox` or `production`). These credentials stay in the existing owner-only
configuration file. The executable does not accept a custom provider endpoint.
Delivery requires registration storage and an explicit migration for durable
grant-revocation barriers. Configured instances advertise `push-delivery`.

`POST /api/hub/hosts/<hostID>/push/send` accepts `signalID`, `deviceID`,
`runtimeID`, `grantID`, `grantVersion`, `kind`, and device-encrypted `context`.
It requires that host's bearer credential, derives the account from the host
directory, and checks the currently connected Runtime. It admits at most 8 KiB
within five seconds. Host credential rotation, disconnect, Runtime replacement,
and grant barriers are checked again immediately before provider submission.
The Hub trusts the authenticated Runtime to attest its locally approved grant;
the Hub does not have plaintext session scopes.

`POST /api/hub/hosts/<hostID>/push/revoke` accepts `grantID` and `grantVersion`.
It durably raises the revocation barrier, discards matching retained contexts,
and fences pending sends. Lower versions cannot lower that barrier, including
after a Hub restart. Each host can retain at most 1024 grant barriers.
The Runtime must propagate every local revocation and reconcile stored
revocations on reconnection before sending notifications.

`GET /api/hub/push/context?deviceID=<deviceID>&signalID=<signalID>` requires a
live account bearer and matching login-bound device registration. It returns
only the routing binding, notification kind, and encrypted context; no host
credential is returned. Every API response disables caching. Expired, revoked,
cross-account, and disconnected contexts are unavailable. Contexts are ephemeral
and are lost on Hub restart; revocation barriers remain durable.

## Runtime event integration

The owned Runtime attaches `PushSender` to the shared EventV2 listener. It sends
attention hints for V2 permission/question requests and terminal execution
failures. Completion requires an observed process-local busy-to-idle drain
transition, so intermediate assistant steps and startup idle states do not
generate completion hints. A failed drain does not also generate completion.

Before encryption and again before HTTP admission, the sender checks the current
unexpired read grant and session/project scope. Each device receives at most one
hint for an event even when multiple eligible grants exist. Local revocation
updates grant storage and closes interactive channels before propagating the
durable Hub barrier. Stored revocations reconcile before future hints, including
after Runtime restart; a failed reconciliation suppresses delivery until a later
attempt. Hints do not retry uncertain provider submissions.

The sender admits at most four event tasks, limits one event to 32 devices and
30 seconds, bounds session status and attention deduplication state, and cancels
network work on transport replacement or shutdown. Dropped or expired hints do
not affect durable session state or execution. Device registration and OS
notification permission remain opt-in on the receiving client.
This module does not itself attest Runtime grants, produce the encrypted context,
or expose HTTP routes. The host-authenticated integration must supply those
checks and native context resolution before notification navigation is usable.

## Device-encrypted context

`PushContext` seals session/project routing hints for the granted device. Each
hint uses a fresh ephemeral P-256 ECDH key and a random 96-bit nonce. HKDF-SHA256
derives a 256-bit AES-GCM key with the routing-binding digest as salt and the
`miao.push.context.v1` domain as context. The ciphertext and header are signed
with the locally pinned host's P-256 ECDSA key. The binding covers host, Runtime,
grant ID/version, device key and signal ID, so substitution fails verification.

The base64url packet contains a version byte, uncompressed ephemeral public key,
nonce, authenticated ciphertext and a 64-byte signature. AES-GCM additional data
and the signature include the domain and canonical routing tuple. The native
client verifies the host signature before deriving a key or decrypting. Packets
are bounded to 4 KiB encoded and routing payloads expire within ten minutes.
Opening a hint only returns routing data; current Runtime grant/scope checks must
still authorize the subsequent session read or action.

The recipient's long-lived device key can decrypt retained hints if compromised;
this format does not claim forward secrecy for background hints. Foreground
interactive channels continue to use fresh two-peer agreement keys separately.
