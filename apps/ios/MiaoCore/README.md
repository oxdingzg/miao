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
