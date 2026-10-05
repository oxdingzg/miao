# Native iOS client

The iPhone/iPad app lives here, independently of the TypeScript workspace packages. `MiaoCore` is a Swift package targeting iOS 17 and newer; its platform crypto and protocol code can also be tested on macOS.

The secure channel uses CryptoKit and the [shared wire contract](../../packages/remote-control/SECURITY-PROTOCOL.md). P-256 public keys use CryptoKit's **x963Representation** for the 65-byte point expected by WebCrypto. Signatures use the 64-byte raw representation. Handshake and channel sequence state is actor-isolated. An authenticated device still needs an Agent-issued, current Grant before session access.

`InteropProbe` is a test-only executable, never a production Agent. It trusts supplied test keys solely to exercise a real signed handshake and two-way encrypted messages with the TypeScript implementation.

Compile and test on an approved build host:

```sh
swift test --package-path apps/ios/MiaoCore
```

Set `MIAO_SWIFT_PROBE_COMMAND` privately to a JSON argv array that runs the remotely built probe. No shell expansion is used. Then run:

```sh
bun apps/ios/scripts/check-interop.ts
```

The client core also provides device-only, unlock-protected Keychain identity storage and an actor-owned, authorization-scoped checkpoint store. On iOS checkpoint files use complete file protection and are excluded from backup. An operation is persisted before transmission; prepared and unconfirmed entries are returned for authoritative result queries after restart, never automatically retransmitted. Session state and its replay cursor are written together. Cache keys include the device, grant and host; session addresses also include Runtime identity.

`ConnectionCoordinator` shares one connection among a Hub identity's scenes. An inactive scene retains its connection, while the last scene entering background closes transport resources without interrupting host execution. Cancelled connection epochs cannot make a background scene ready. Authorization failures stop retries until explicit restoration. A disconnected foreground transport reconnects with bounded randomized backoff.

`HubConnection` uses URLSession WebSockets and the approved host's pinned public key. It correlates typed, encrypted RPC requests, serializes encryption plus socket writes to preserve sequence order, bounds pending requests and timeouts, and reconstructs ordered response chunks before applying data. Request cancellation only cancels the local wait. Production composition must supply authoritative ledger/directory reconciliation through the mandatory synchronization callback; the transport never repeats business operations.

The `TransportProbe` executable is test-only. Its explicit local test identity/grant is supplied by the harness, and cleartext loopback access is enabled only for that test. `check-transport.ts` exercises real native URLSession → Hub → Agent traffic, encrypted large history reconstruction and stable operation IDs. Production connections require HTTPS.

`PairingInvitation.parse` accepts the TUI's `miao://pair#<base64url JSON>` invitation, validates its expiry and pinned host key, and requires a root HTTPS relay URL. Cleartext loopback access is an explicit test-only opt-in. `HubConnection.pair` creates the signed device claim and invitation HMAC, verifies the host's reply, and exposes the device fingerprint while waiting for local owner approval. No Session RPC reader starts before approval and the caller's mandatory save callback succeeds. Large grant notifications use the same bounded, ordered chunk assembly as RPC responses.

If approval is lost or saving fails, pairing reports an uncertain outcome and closes the socket. The caller must reconcile authorization before reconnecting; this API never assumes a grant or repeats a business operation. The App must provide durable host/grant storage and its recovery flow.

`PairingProbe` is test-only. `check-pairing.ts` connects real native URLSession transport to the Hub and Agent, exercises a Unicode invitation proof and explicit local approval, checks large grant reconstruction, and verifies that a failed save cannot send RPCs. Its generated test identities never come from production Keychain storage.

`Miao.xcodeproj` contains the SwiftUI iPhone/iPad application. Its local package dependency is `MiaoCore`; no TypeScript runtime is embedded. The host registry saves the public pairing trust anchor before claiming an invitation and atomically saves the approved host and device grant. Invitations and private signing keys are never written to that registry. Removing a computer clears its local cache; revocation remains an explicit owner action on the computer.

The app lists authorized projects and sessions, creates sessions in authorized directories, replays durable conversation events, sends steer or queue inputs, renames sessions, displays file changes, handles one-time permission and question replies, and interrupts the specifically observed execution. Mutating commands retain immutable operation IDs and parameters in the protected ledger. Foreground reconnection queries uncertain results; it does not resend commands. Each host shares its connection across foreground iPad windows, while drafts and timelines retain their full host/Runtime/session address.

Camera scanning and explicit link entry open the pairing flow. Speech recognition requires microphone and speech permission plus an available on-device recognizer. Recognition edits the draft only; the user confirms sending. It stops when the session view closes or its scene enters background, and stops rather than overwriting a draft edited in another window. System keyboard dictation remains available when on-device recognition is unavailable.

Build on an approved macOS build host:

```sh
sh apps/ios/scripts/build-app.sh -configuration Release -sdk iphoneos \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO
```

The script derives the marketing version from the root `package.json`. Supply signing and provisioning configuration privately for a device installation. `scripts/create-project.py` regenerates the checked-in project after source file additions.

UI smoke tests run with `sh apps/ios/scripts/test-app.sh iphone` or `ipad` on the build host. They launch the actual signed simulator app, check Keychain initialization, enter an invalid invitation and verify that no host is admitted. An unsigned compilation alone does not verify Keychain access at runtime.

`bun apps/ios/scripts/check-app.ts` starts an isolated real Runtime and Hub, creates a session through the authenticated local API, and runs the actual simulator app through pairing, session read/rename, draft background recovery, process restart and queued message admission. The harness verifies the resulting title and exactly one queued admission against the Runtime's durable history; a skipped UI test cannot pass that check. Set `MIAO_UI_TEST_FAMILY=ipad` for the iPad run. Test identities and cache partitions are unique per run, cleartext loopback access exists only in opted-in Debug simulator builds, and the fixture uses an unavailable model so admission testing never requires provider execution.

CI runs native core tests, the iOS platform source check, an unsigned universal app build, iPhone/iPad UI smoke tests, crypto interoperability, native transport and pairing integration on a macOS runner. Physical camera, speech and device installation checks require a real device. APNs registration/delivery and the complete cross-channel integration are still separate work; the current app does not claim those capabilities.

`bun apps/ios/scripts/check-account.ts` runs the native iOS account probe against
a real authenticated Hub and encrypted Agent. It also exercises device push
registration, host-authenticated notification admission through a loopback HTTP/2
provider, account/device-bound context lookup, native signature/decryption and
scope resolution, token renewal, and grant revocation. The fixture checks that
the provider receives only the generic alert, with no encrypted context or session
identity. This proves the application-level notification protocol; physical Apple
delivery, entitlement provisioning and notification-click navigation require
separate acceptance checks.

## Hub accounts

Open **登录中继** and enter the computer's configured HTTPS Hub address and account. The account screen lists registered computers and their online status. Session access still requires scanning an invitation and approving this device on the computer; directory discovery cannot replace that approval or a pinned computer key. A pending invitation resumes after account login.

The signed login is stored in the device-only Keychain; the password is cleared from the form when submitted or dismissed. WebSocket credentials remain short-lived and confined to the signed-in origin. Logging out closes transports and clears the displayed session view while host tasks continue. A failed remote revocation is shown explicitly with a retry action.

After a computer restart, reconnect refreshes its Runtime instance after matching the previously approved host public key. Session replay starts in the new Runtime cache partition, while drafts migrate within the same device/grant/host/session scope. Uncertain operations retain their original IDs and are queried, never automatically resent.

On an approved macOS host, `MIAO_UI_TEST_ACCOUNT=1 bun apps/ios/scripts/check-app.ts` runs the full native UI flow against the account-managed Hub: account entry, pairing, session operations, background draft recovery and account restoration after App restart. The default harness retains legacy private-relay coverage. Both use isolated identities and test-only loopback access.

### Notification registration

The account sheet provides an explicit notification enable/disable action. The
App asks for alert and sound permission only after that action. System token
callbacks register the current token through the authenticated Hub account;
tokens remain in memory and are not cached in preferences or checkpoint files.
Updates are serialized, account changes fence stale responses, and disabling
waits for pending updates before revoking the device registration. Unconfirmed
revocation keeps an explicit retry action across launches. Account sign-out
also removes the login-bound registration on the Hub.

Notification builds must set `MIAO_PUSH_ENVIRONMENT` to `sandbox` or `production`
and use a signing profile with the matching APNs entitlement. The default
`disabled` value preserves installations whose profile does not support APNs;
the App reports notification support as unavailable and does not request OS
permission. This value is independent of Debug/Release because development
exports of a Release archive can still require the sandbox environment. Signing
profiles, push keys and team configuration remain outside the repository.

The Hub must advertise both push registration and configured push delivery before
the native client can enable notifications. Clicking a generic notification
fetches its opaque context through the signed-in account, verifies the locally
pinned host signature and matching unexpired read grant, and decrypts the session
hint with the device key. The app then reconnects and reads the session through
the current Runtime before opening it. Stale Runtime targets, revoked grants,
foreign devices/accounts and expired hints do not authorize navigation or actions.
Notification clicks contain no executable session operations and never replay
inputs. Cold launches retain at most one pending signal until the app model loads;
only an active scene consumes the navigation request.
Enrollment confirms routing metadata only. Approved Runtime subscriptions and
working Apple provider credentials are also required before reminders can be
sent. Real Apple delivery and notification navigation must be verified with an
entitled device build; simulator account tests do not prove APNs delivery.
