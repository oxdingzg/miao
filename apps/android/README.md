# Native Android client

The Android app lives here, independently of the TypeScript workspace packages.
`core` is a plain JVM module that mirrors `apps/ios/MiaoCore`; `app` is the
Jetpack Compose application that consumes it.

The wire contract is unchanged: [secure channel](../../packages/remote-control/SECURITY-PROTOCOL.md),
[pairing](../../packages/remote-control/PAIRING-PROTOCOL.md), [RPC](../../packages/remote-control/RPC-PROTOCOL.md),
[push](../../packages/remote-control/PUSH.md) and [device rosters](../../packages/remote-control/DEVICE-ROSTER.md).
Canonical JSON, P-256 `x963` points, 64-byte `r || s` signatures, HKDF-SHA256
and AES-256-GCM frames match the TypeScript implementation byte for byte, which
`scripts/check-interop.ts` verifies against the real server code.

## Layout

| Module | Purpose |
| --- | --- |
| `core` | Protocol core: canonical JSON, P-256 crypto, secure channel, RPC and chunk assembly, WebSocket transport, pairing, Hub account, rosters and enrollment, push context, checkpoint store, session timeline and the connection coordinator. |
| `app` | Compose UI: relay account, pairing, computer and session lists, session view, approvals and questions, providers, speech input, QR scanning. |

`core` has no Android dependency and its tests run on any JDK 17. Identity and
relay credentials live app-private, wrapped by a non-exportable AndroidKeyStore
AES key; the wrapped bytes are excluded from backup.

## Features

Aligned with the iOS app's remote-control surface: relay sign-in with token
refresh and generation fencing, QR/link pairing with the local fingerprint
approval, same-account device admission and signed roster enrollment, directory
sync, project and session lists with server-side search and archived filtering,
pin/archive/rename/delete, durable event replay with the live text projection,
steer/queue prompts with a durable operation ledger, one-time permission and
question replies, interrupt of the observed execution, file-change view,
`provider.list`-backed provider settings and default model selection, plus a
cross-session pending inbox.

Not yet ported from iOS: the phone-only local assistant mode (no computer
involved), tablet multi-window scene sharing, and FCM background notifications.
The relay currently delivers APNs alerts only, so Android registration awaits a
server-side delivery provider; the client-side registration and
device-encrypted context lookup are already implemented and interop-tested.

## Build and test

```sh
./gradlew :core:test          # protocol core unit tests
./gradlew :app:assembleDebug  # unsigned debug APK
```

Any JDK 17 works for the core. The app module needs the Android SDK; set
`sdk.dir` in the untracked `local.properties` or export `ANDROID_HOME`
(`compileSdk 35`, `minSdk 26`). CI runs both jobs on Linux with the image's
preinstalled SDK.

Interoperability against the TypeScript implementation:

```sh
./gradlew :core:installDist
MIAO_KOTLIN_PROBE_COMMAND='["apps/android/core/build/install/core/bin/core"]' \
  bun apps/android/scripts/check-interop.ts
```

The probe is test-only and trusts the keys the harness supplies. It never acts
as an Agent.

Debug builds allow cleartext loopback so the harness can run a local Hub; release
builds require HTTPS.
