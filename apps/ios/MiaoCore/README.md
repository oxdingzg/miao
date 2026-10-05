# Native Remote Control client

`HubAccount` signs into an account-mode Hub, stores the signed login session in
device-only Keychain storage, and refreshes a short-lived access token in memory.
Passwords are never persisted. Account storage is partitioned by the normalized
Hub origin. HTTP requests reject redirects, disable cookie persistence, and bound
response sizes and request durations.

Call `restore()` after creating the account client, `signIn(email:password:)` for
an explicit login, `hosts()` for the account's host directory, and `bearer()` for
the relay's Authorization header. Directory records contain stable host identity,
the public key, online status, and the current Runtime ID. They do not replace
the locally approved device grant or the pinned Agent identity.

`signOut()` removes local credentials immediately and requests server revocation.
A network failure is reported; the same client retains an in-memory revocation
retry until another `signOut()` succeeds. An application must show that remote
revocation remains unconfirmed when offline. This retry does not survive closing
the client or terminating the application.
`close()` cancels the client's HTTP transport without logging out; it fences
in-flight results and leaves the Keychain login available for a new client.

Run `swift test --package-path apps/ios/MiaoCore` on an approved macOS build host.
`bun apps/ios/scripts/check-account.ts` additionally builds an isolated simulator
probe against a real account Hub, registers a host, checks its Unicode directory
record, restores a real Keychain login, and verifies logout invalidation. It owns
and deletes its simulator and keeps credentials out of command arguments and logs.

Authenticated relay connections
------------------------------

Pass the signed-in `HubAccount` to `HubConnection.open` or `HubConnection.pair` for an account-managed Hub. The account supplies a cached short-lived bearer on each new socket, validates the exact origin (including its port), and owns a separate ephemeral, redirect-rejecting WebSocket session. Credentials remain in headers rather than URLs. Pairing still requires local owner approval; an account login never substitutes for an Agent device grant.

Signing out closes this account instance's sockets immediately, including when remote revocation fails. A successful server sign-out also invalidates sockets using a restored copy of the same login. New connections retrieve a fresh bearer after its cache deadline; failed or uncertain RPC operations are never retried by this layer. On reconnect, the account directory supplies the current Runtime instance only after the stored host public key matches; a missing, revoked or changed identity blocks authorization, while an offline host remains offline. The grant ID/version and local trust anchor stay intact. The legacy no-account transport is retained for private integration fixtures.

The native account integration probe exercises a real Hub and Agent, rejects an unapproved device even with a valid account, reads an encrypted session with the approved device, and checks both local socket closure and server-side logout invalidation.
