# Acceptance record — G6: paired artifact checklist, release v0.3.59

Item: REL-04 gate G6 (`specs/rust-retirement-gates.md`): the supported
platforms' published artifacts paired against the versions they answer, with
checksums verified. Checklist produced 2026-11-11 from the current **Latest**
release `v0.3.59` (published 2026-11-10, source commit `7de551004a`) — no new
release was cut for this record.

## Download and checksum verification

All four shipped archives and their `.sha256` manifests were downloaded from
the release and verified with `shasum -a 256 -c`: **4/4 OK**.

| archive | size (bytes) | archive SHA-256 (verified) |
| --- | --- | --- |
| miao-darwin-arm64.zip | 27,279,763 | `383117336213d864918ceb8a8e61a1c314012258006ab5a968c846213f25755e` |
| miao-linux-arm64.tar.gz | 30,281,687 | `d120b95b20cb938a7f01dc6c749d3835875359f2d4e9c907a7f82a9456d0665c` |
| miao-linux-x64.tar.gz | 31,424,553 | `7b6c15534ef1b9df94b9b1926b00acf99a469e51e6a66a1511189b5c45f20577` |
| miao-windows-x64.zip | 26,677,204 | `a77cc93dc56d5a6520c06fde91c09650d8bc2fe03359d8ca9c5dedf6611d16e7` |

## Extracted binary pairing

Each archive extracts to exactly `LICENSE` + the product binary (`miao` /
`miao.exe`); v0.3.59 no longer ships a `models.json` sidecar (models resolve
from the embedded catalogue). Extracted binary SHA-256 (first 16):

| platform | binary SHA-256 (first 16) | bytes |
| --- | --- | --- |
| darwin-arm64 | `2e0b2fa50b0fdebf…` | 78,641,664 |
| linux-arm64 | `f068ea417fd47b4f…` | 85,324,112 |
| linux-x64 | `0e23f90f7e7196f8…` | 89,647,168 |
| windows-x64 | `54a2b95785a94915…` | 77,731,840 |

The product is one binary carrying CLI, TUI and engine; the versions pair by
construction from the same commit, and the native leg answers for the pairing
live (below).

## Live pairing proof (darwin-arm64, native)

```
$ ./x-darwin-arm64/miao --version
miao 0.3.59
$ ./x-darwin-arm64/miao debug info
miao      0.3.59
engine    protocol 2 schema 25
```

CLI and embedded engine answer the same `0.3.59`, with the engine reporting
`protocol 2` and store `schema 25` — the pair a G6 consumer must see. The
protocol- and schema-compatibility behaviour (an incompatible peer is named
and refused, never half-driven) is pinned by the G2 record's
`unsupported_protocol` test and the store-side negotiation accepted in
RUS-06's record.

## Non-native platforms — what binds them

linux-arm64, linux-x64 and windows-x64 were checksum-verified and extracted
here, not executed (this workstation is darwin). Their execution binding is
the release workflow's own legs, which build each artifact on its target
runner and boot that exact file (#2331/#2332) — the smoke validates the same
bytes these checksums identify.

## darwin-x64

Not shipped in v0.3.59: the owner's 2026-11-10 decision defers Intel native
verification until a real Intel-user report
(`specs/rust-retirement-gates.md`, this record's predecessor documents the
Rosetta-only evidence for older candidates). The four-platform asset list is
the decision made visible in the release itself.
