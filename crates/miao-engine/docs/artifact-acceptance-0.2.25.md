# Engine artifact acceptance: 0.2.25

Collected 2026-10-23 on the published 0.2.25 engine archives. This supplements
the install, data, and rollback drills in
[artifact-acceptance-0.2.13.md](artifact-acceptance-0.2.13.md), the platform
drills in [artifact-acceptance-0.2.23.md](artifact-acceptance-0.2.23.md), and
the [rollback verification](rollback-verification.md). All provider replies are
local deterministic fixtures; no paid calls are made.

## macOS arm64: full cross-version drill

`script/engine-artifact-drill.py` ran the published 0.2.24 archive as the
previous executable and the published 0.2.25 archive as the candidate.

| Stage | Result |
| --- | --- |
| Compatibility (upgrade → downgrade → upgrade) | PASS: SQLite integrity, unchanged journal prefixes, history retained, no duplicate output, no repeated provider work (3 provider calls, 46 retained events) |
| Workspace write control | PASS, exit 0 |
| Outside-write denial | PASS, exit 1; sentinel unchanged |
| Compaction | PASS, two checkpoints, six provider calls |
| Overall | `ENGINE_ARTIFACT_DRILL=PASS` |

## Linux x64: the musl asset starts on Ubuntu 24.04

The 0.2.25 Linux x64 archive is a `static-pie linked` executable. On Ubuntu
24.04.2 (glibc 2.39) it reports `miao-engine 0.2.25` and passes the drill, so
the #1235 glibc blocker is closed in the published artifact.

The 0.2.24 Linux x64 archive still requires `GLIBC_2.43` and cannot load on
that host, so no runnable prior Linux executable exists there for a
cross-version stage. The drill therefore ran 0.2.25 as both the previous and
the candidate executable: the same-version restart, resume, journal-prefix,
and storage checks still exercise the artifact. The cross-version stage is
covered separately below on newer-glibc userspace.

| Stage | Result |
| --- | --- |
| Compatibility (same version, restart/resume) | PASS: SQLite integrity, unchanged journal prefixes, history retained, no duplicate output, no repeated provider work (3 provider calls, 46 retained events) |
| Workspace write control | PASS, exit 0 |
| Outside-write denial | PASS, exit 2; sentinel unchanged |
| Compaction | PASS, two checkpoints, six provider calls |
| Overall | `ENGINE_ARTIFACT_DRILL=PASS` |

## Linux x64: cross-version upgrade → downgrade → upgrade

The blocker above was only that the host userland was too old. The published
0.2.24 archive is a normal glibc-dynamic build needing `GLIBC_2.43`, so it
became a runnable previous executable on newer-glibc userspace: the drill ran
inside an `ubuntu:26.04` container (`glibc 2.43-2ubuntu2.4`) with the published
0.2.24 archive as the previous and the published 0.2.25 archive as the
candidate. This closes the Linux cross-version stage with no source build.

| Stage | Result |
| --- | --- |
| Compatibility (upgrade → downgrade → upgrade) | PASS: SQLite integrity, unchanged journal prefixes, history retained, no duplicate output, no repeated provider work (3 provider calls, 46 retained events) |
| Workspace write control | PASS, exit 0 |
| Outside-write denial | PASS, exit 2; sentinel unchanged |
| Compaction | PASS, two checkpoints, six provider calls |
| Overall | `ENGINE_ARTIFACT_DRILL=PASS` |

Reproduction:

```sh
docker run --rm -v "$PWD":/work -w /work ubuntu:26.04 bash -c \
  'apt-get update -qq && apt-get install -y -qq python3 && \
   python3 /work/drill.py --previous /work/v24/miao-engine \
     --binary /work/v25/miao-engine --output /work/artifact-drill-linux-cross.json'
```

## macOS x64 under Rosetta 2

The published `miao-engine-darwin-x64` 0.2.24/0.2.25 archives pass the full
cross-version drill on Apple Silicon (macOS 26.5, arm64) under Rosetta 2, so
the Intel artifacts are exercised end to end. This is translation-layer
evidence: native Intel macOS hardware remains the open acceptance item and is
not replaced by this run.

| Stage | Result |
| --- | --- |
| Compatibility (upgrade → downgrade → upgrade) | PASS: SQLite integrity, unchanged journal prefixes, history retained, no duplicate output, no repeated provider work (3 provider calls, 46 retained events) |
| Workspace write control | PASS, exit 0 |
| Outside-write denial | PASS, exit 1; sentinel unchanged |
| Compaction | PASS, two checkpoints, six provider calls |
| Overall | `ENGINE_ARTIFACT_DRILL=PASS` |

Reproduction:

```sh
python3 script/engine-artifact-drill.py \
  --previous /path/to/0.2.24/miao-engine \
  --binary /path/to/0.2.25/miao-engine \
  --output /tmp/artifact-drill-0.2.25.json
```

## Published assets

| Archive | SHA-256 |
| --- | --- |
| 0.2.25 macOS arm64 zip | `039940d2f8b0adc0ff3387fddec4617f0814a3bc38e9ff0007f73049405dcb25` |
| 0.2.24 macOS arm64 zip | `6873373c0386290d2aa200e51f7544afcd6e4b06b4df11e35320247c1725fc40` |
| 0.2.25 Linux x64 tar.gz | `3340cad4a03e052c56e014fd7501253558f594f24f1a0c28f0603b011835fafc` |
| 0.2.24 Linux x64 tar.gz | `41adea85ec846a41487106323d84110b9731a95f726d08f6ff0773b447a7fec7` |

| Executable | SHA-256 |
| --- | --- |
| Published 0.2.25 macOS arm64 | `05a18bd64c36a3ee295252b3900d75eaa837ca4dabc5e0cb803abbddb8ee42a3` |
| Published 0.2.24 macOS arm64 | `1b281880c5968e45eed7aa64b024761bea29953a3d64dab5ee8fb62e08fed73a` |
| Published 0.2.25 Linux x64 | `d25d513f290665ce6163f8dceedf90e9223c9ce94b09bcf3bbe73ff160f354c6` |
| Published 0.2.24 Linux x64 | `a2e96ca09e6dd352932cbefe566a2586f758e830739e88d7696cc45841ac16cb` |
| Published 0.2.25 macOS x64 | `5c982d44c9976e816371425ef433311b35b043faef81261522be321cb4af1ce3` |
| Published 0.2.24 macOS x64 | `40b3a14476f2f7e10def8c9b0032966574b5b171aecb182742c9e89195932795` |

## Windows x64: cross-version drill (2026-10-23 addendum)

The published 0.2.24 and 0.2.25 Windows x64 executables ran the full drill
(`script/engine-artifact-drill.py`, Python 3.12) on the Windows host:
`ENGINE_ARTIFACT_DRILL=PASS` across install, data migration, rollback and
compaction stages with the guarded-process scope (workspace write allowed,
outside denied; network/PTY not exercised by the fixture). Two independent
runs agree (one recorded `drill-0.2.25-windows.json` next to this document,
one ran the same upgrade → downgrade → upgrade stages in a local user
session); both returned the PASS table above. Archive SHA-256s verified
before extraction, with the extracted executables hashed as well:

| Artifact | SHA-256 |
| --- | --- |
| Published 0.2.25 Windows x64 zip | `f8e41934a6b7cea009ae594d5fe63604f8873b55e34445546624805abaace54d` |
| Published 0.2.25 Windows x64 executable | `7d02eec5eecbaeea65f679e907ee658cbc474b391962e14df1a99975177b164a` |
| Published 0.2.24 Windows x64 zip | `674fb37ee1a8e932b7337accf141484dd54e36137d04d17cd436bde2d7d2ba9d` |
| Published 0.2.24 Windows x64 executable | `357d9f0e5fc9c79f99bf7e8ec62ea203ead7015010686168ab17f9cef15971ac` |

The 0.2.24 executable hash matches the 0.2.23 record, so the upgrade leg ran a
genuine prior release. The same session confirmed the confined
AppContainer + ConPTY combination on real hardware: `miao-sandbox`'s
`tests/pty_windows.rs` passes there (`1 passed`), so the terminal backend's
strict no-fallback rule needs no `windows_unconfined` escape hatch.

Release-endpoint connectivity from that host is **unavailable**: three probes
of `https://github.com/oxdingzg/miao/releases/download/...` failed — twice
`schannel: failed to receive handshake, SSL/TLS connection failed`, once a
21 s connect timeout — with WinHTTP set to direct access and per-user proxying
disabled, while crates.io and python.org downloads from the same host succeed.
Release assets for drills were staged over SSH from another LAN machine; the
Windows updater path needs a proxy decision (accept a staged-asset workflow or
route the host through the LAN proxy).

## Not covered

- Native Intel macOS hardware: the x64 artifacts pass the full cross-version
  drill under Rosetta 2 (above), which is evidence about the artifacts but not
  a substitute for native Intel hardware.
- Windows direct release-endpoint connectivity: the release host is
  unreachable from the Windows build host without a proxy (three failed probes,
  see the Windows section). Accept a staged-asset workflow there or route the
  host through the LAN proxy; until then the updater path stays unverified on
  Windows.
