# Engine artifact acceptance: 0.2.23

Collected 2026-10-22 on the published engine archives. This supplements the
installer and data drills in
[artifact-acceptance-0.2.13.md](artifact-acceptance-0.2.13.md) and the
[rollback verification](rollback-verification.md). All provider replies are
local deterministic fixtures; no paid calls are made.

The v0.2.24 release carries the 0.2.23 engine archives, so the asset version
reported by `--version` is `miao-engine 0.2.23` on macOS and Linux. The
Windows x64 archive reports `miao-engine 0.2.24`.

## macOS arm64

`script/engine-artifact-drill.py` ran the published 0.2.22 archive as the
previous executable and the published 0.2.23 archive as the candidate.

| Stage | Result |
| --- | --- |
| Compatibility (upgrade → downgrade → upgrade) | PASS: SQLite integrity, unchanged journal prefixes, history retained, no duplicate output, three provider calls |
| Workspace write control | PASS, exit 0 |
| Outside-write denial | PASS, exit 1; sentinel unchanged |
| Compaction | PASS, two checkpoints, six provider calls |
| Overall | `ENGINE_ARTIFACT_DRILL=PASS` |

| Executable | SHA-256 |
| --- | --- |
| Published 0.2.22 macOS arm64 | `2cbc19cc6cfc6a91e197cc87a26d55eab01b6a3028ed5c683e21d538dd8e7aa6` |
| Published 0.2.23 macOS arm64 | `124582c4944ff4e8f281f5e505befea3f82b2e5047ac9102805f7eeecfe11682` |

## Linux x64: published archive cannot start on Ubuntu 24.04

The published 0.2.23 Linux x64 engine is dynamically linked against the build
runner's glibc and requires `GLIBC_2.43`. Ubuntu 24.04 ships 2.39, so the
executable does not load:

```
/tmp/miao-drill/cur/miao-engine: /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.43' not found
```

The CLI archive from the same release starts normally on the same host, so the
defect is specific to the engine archive. The release workflow built the engine
with its default GNU target while the engine CI already cross-builds musl.

The fix (#1235) builds the Linux engine for
`x86_64-unknown-linux-musl`/`aarch64-unknown-linux-musl` and installs
`musl-tools` plus the matching Rust target in the release workflow.

### Source build of the fix

Built from the fix commit on Ubuntu 24.04 x64 with
`CC_x86_64_unknown_linux_musl=musl-gcc` and
`CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=musl-gcc`:

- `file` reports `ELF 64-bit LSB pie executable … static-pie linked`; `ldd`
  reports `statically linked`.
- `--version` reports `miao-engine 0.2.24`.
- The artifact drill against that build reports compatibility PASS,
  workspace-write control PASS (exit 0), outside-write denied PASS (exit 2),
  compaction PASS, and `ENGINE_ARTIFACT_DRILL=PASS`.
- Source-build SHA-256:
  `0207ea03c9282616e6133fac2060384752540d3e11385d22df75de0f3b5f0056`.

This validates the build change, not a published archive: the next release must
repeat the drill against its own Linux asset to close the distribution gate.

## Windows x64

The published 0.2.22 and 0.2.24 Windows x64 executables ran the same drill
through a Python 3.12 embeddable distribution on Windows 10 (build 22621).

| Stage | Result |
| --- | --- |
| Compatibility (0.2.22 → 0.2.24 → 0.2.22) | PASS: SQLite integrity, unchanged journal prefixes, history retained, no duplicate output, three provider calls |
| Workspace write control | PASS, exit 0 |
| Outside-write denial | PASS, exit 1; sentinel unchanged |
| Compaction | PASS, two checkpoints, six provider calls |
| Overall | `ENGINE_ARTIFACT_DRILL=PASS` |

This repeats the 0.2.13 drill that failed its positive write control (#919) and
closes the post-release Windows confinement repetition.

| Executable | SHA-256 |
| --- | --- |
| Published 0.2.22 Windows x64 | `5ddc9eecb64009b8be7a15399408ad2d0673ec561c3654e5fce4c6298d6ccca6` |
| Published 0.2.24 Windows x64 | `357d9f0e5fc9c79f99bf7e8ec62ea203ead7015010686168ab17f9cef15971ac` |

## Still open

- Repetition against the next published Linux engine archive (blocked on the
  release that carries #1235).
- Native Intel macOS hardware, network/PTY isolation, and schema compatibility
  outside the exercised version pair.
