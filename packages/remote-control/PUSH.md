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
