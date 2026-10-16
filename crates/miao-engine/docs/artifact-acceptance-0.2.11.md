# Engine artifact acceptance: 0.2.11

Evidence collected 2026-10-16 for switch-plan G4. This is the first
acceptance pass against **published release assets**; 0.2.9's report covered
Actions artifacts and left publication acceptance open. The v0.2.11 release
ships engine archives for every supported platform beside the CLI archives
(`release run 38831462439`, commit
`2ac505ad4dd0a9b65b58c9678aa8878fde1be63f`, published 2026-10-16T01:05:28Z,
not a draft).

## Published archives and integrity

Every archive below was downloaded from the published release and verified
against its sidecar SHA-256. The Linux x64 archive was re-verified on a Linux
host after transfer.

| Published asset | SHA-256 | Verified on |
| --- | --- | --- |
| `miao-engine-darwin-arm64.zip` | `4a0c1142ef545dc4135925301697c5ae71c10b524620fc52e64b36865b5cecb8` | macOS arm64 (workstation) |
| `miao-engine-darwin-x64.zip` | `46568316eb8c7cfb6abe5a37b7b257650aa8285dd0d25e50b41e860e67cf0f00` | macOS arm64 (workstation) |
| `miao-engine-linux-arm64.tar.gz` | `8eb29e94968cb5184819fda4d309e12b3a57c961b55a3b0623044fb1e277b363` | macOS arm64 (workstation) |
| `miao-engine-linux-x64.tar.gz` | `65801be1afad9d3cbd3faa7820a92e0368a73e298285a2ae5e66c7b14d158bcb` | workstation and Linux x64 host |
| `miao-engine-windows-x64.zip` | `867f49c61789d8dcc6fc8bc2b1eaa43fe7c8fa6ec1f49e6083acc8e61b35ad04` | macOS arm64 (workstation) |

## Published-executable startup per platform

| Platform | Checks | Result |
| --- | --- | --- |
| macOS arm64 | codesign: valid signature, timestamp, hardened runtime; launches with a `com.apple.quarantine` attribute set (Gatekeeper assessment passed); `doctor` reports version 0.2.11, sandbox available; `serve` answers `/version` with `engine-http-0` behind the configured token | PASS |
| macOS x64 (translated) | `doctor` under the translation runtime reports version 0.2.11, sandbox available | PASS |
| Linux x64 | sidecar checksum re-verified on the host; `doctor` reports version 0.2.11, sandbox available; `serve` answers `engine-http-0` | PASS |
| Windows x64 | archive extracted on the host; `doctor` reports version 0.2.11, sandbox available; `serve` answers `engine-http-0` under Windows PowerShell 5.1 | PASS |

## Still open

- Native Intel macOS hardware (x64 execution here used translation, as in the
  0.2.9 report).
- PowerShell 7 against an actual artifact: the Windows host used for these
  probes has no `pwsh` installation, so the drill ran under PowerShell 5.1.
- Database schema/data compatibility after upgrade and downgrade.
- Confinement behavior against these exact distributed executables remains
  owned by the engine process/sandbox tests; `doctor`'s sandbox report on the
  published binaries is supporting evidence, not a substitution.
