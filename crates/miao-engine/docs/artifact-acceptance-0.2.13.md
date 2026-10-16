# Engine artifact acceptance: 0.2.13

Evidence collected 2026-10-16 for switch-plan G4. Release workflow run
`38893327998` succeeded; v0.2.13 is published, not a draft. The release contains
CLI assets and all five engine archives with SHA-256 sidecars.

## Published archive integrity

All five engine archives were downloaded from the release and checked against
their published sidecars. These are archive hashes, not executable hashes.

| Published asset | SHA-256 |
| --- | --- |
| `miao-engine-darwin-arm64.zip` | `b217b04b694d25f0bd94c57cbc4d107213e29a06a1c72af43f96c0f8451b1204` |
| `miao-engine-darwin-x64.zip` | `7609c8907260405d473f4681af24f14ff50b5c37d79f75394e6a24457e12e8b0` |
| `miao-engine-linux-arm64.tar.gz` | `0da61edd92a2a5c25d3bda7b93ab5d6e62958b816f5a4f46e2289f91d5c5e030` |
| `miao-engine-linux-x64.tar.gz` | `5059424f39cf5fbacbf39bfa09e77e634c93a712f2b8ba1fb915693eb8b852bc` |
| `miao-engine-windows-x64.zip` | `cd2b3bbe37c45b5811afa4c37937111145b680375edc45a6b7952f639cacfa79` |

The macOS arm64 executable reports version 0.2.13 and sandbox availability via
`doctor`; its authenticated `serve` endpoint answers `/version` with
`{"protocol":"engine-http-0"}`.

## Windows PowerShell 7 actual-artifact drill

PowerShell 7.6.7 ran the repository's `script/install-engine.ps1` against actual
published Windows x64 executables, in an isolated temporary installation:

1. Verify the v0.2.12 and v0.2.13 ZIPs against their sidecars on Windows, then
   extract them. The v0.2.12 archive hash is
   `5bd37aa43cd2f8f7fa1216b48cabdc995a20c3ef84246b8680d9f665fcd36f0e`.
2. Install the extracted v0.2.12 executable with `-Binary`.
3. Install v0.2.13 with `-Binary`; verify the version and that the previous slot
   retains the exact v0.2.12 executable.
4. Run v0.2.13 `doctor`; verify the version and sandbox availability.
5. Invoke `-Rollback`; verify v0.2.12 is current byte-for-byte and v0.2.13 is
   retained in the previous slot.
6. Remove the isolated installation.

| Executable | SHA-256 |
| --- | --- |
| v0.2.12 Windows x64 | `a02dcc8632ed53d5d49c532007f7e9f854487b85fcfb72ea4ace45ab31ab4896` |
| v0.2.13 Windows x64 | `4d4c565befe52fe273c99b1c8e8c8b3d0e6f8ee9d345f9e78c44aebffe9d8ef1` |

Result: **PASS** (`PS7_PUBLISHED_DRILL=PASS`). The portable PowerShell package
was verified against its release SHA-256 before use. Archives and sidecars
were downloaded on another machine and transferred to Windows because the
initial direct-download attempt did not finish. Thus this proves the PS7
installer and rollback behavior with real published bytes, not Windows direct
release-endpoint connectivity or the installer's `-Release` download path.
No system-wide PowerShell installation or execution-policy change was made.

## Follow-up behavior drill

The [state and file-write confinement report](artifact-state-acceptance-0.2.13.md)
exercises the same ledger through 0.2.12→0.2.13→0.2.12 and real guarded process
writes. macOS/Linux published binaries pass those bounded checks; the Windows
published binary fails its positive write control and the #919 source build
passes. This is additional scoped evidence, not closure of all gates below.

## Still open

- Native Intel macOS hardware, as recorded in the prior acceptance reports.
- Engine database/schema compatibility when rolling data back across versions;
  this executable-slot drill does not prove data downgrade compatibility.
- Confinement behavior against the exact distributed executables. A successful
  `doctor` sandbox availability check is supporting evidence, not a behavioral
  confinement test.
