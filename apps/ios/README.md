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

CI runs native core tests, the iOS platform source check, crypto interoperability, native transport and pairing integration on a macOS runner. The SwiftUI app, camera UI, durable host registry, Runtime-specific reconciliation and speech input remain subsequent implementation steps.
