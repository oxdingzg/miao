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

`ConnectionCoordinator` shares one connection among a Hub identity's scenes. An inactive scene retains its connection, while the last scene entering background closes transport resources without interrupting host execution. Cancelled connection epochs cannot make a background scene ready. Authorization failures stop retries until explicit restoration. Production transport supplies authorization validation and ledger reconciliation through `ClientConnection.synchronize()`.

CI runs native core tests, the iOS platform source check and the interoperability exchange on a macOS runner. The SwiftUI app, pairing UI, production transport and speech input remain subsequent implementation steps.
