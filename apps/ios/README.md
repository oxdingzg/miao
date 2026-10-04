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

CI runs native core tests, the iOS platform source check, crypto interoperability and native transport integration on a macOS runner. The SwiftUI app, pairing UI, Runtime-specific reconciliation and speech input remain subsequent implementation steps.
