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

This module does not itself attest Runtime grants, produce the encrypted context,
or expose HTTP routes. The host-authenticated integration must supply those
checks and native context resolution before notification navigation is usable.
