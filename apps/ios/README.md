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

CI runs native core tests and this interoperability exchange on a macOS runner. The SwiftUI app, pairing UI, protected identity/cache storage, scene lifecycle and speech input are subsequent implementation steps; this initial package is the native protocol foundation.
