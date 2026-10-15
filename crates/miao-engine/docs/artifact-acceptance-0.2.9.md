# Engine artifact acceptance: 0.2.9

Evidence collected 2026-10-15 for switch-plan G4. These are **Actions
artifacts**, not published release assets. This report closes the binary
installation/upgrade/rollback drill only; it does not close the whole G4 gate.

## Inputs and integrity

- Build: workflow run `38719684562`, commit
  `93ea2f3360314cd77ced37a86d3f5b8c3f077d5c`, root version `0.2.9`.
- Each binary was verified against both the workflow manifest and its sidecar
  SHA-256 before executing it.
- Real old-version baselines were built from `v0.2.8`, commit
  `6cb890d2dcdb428595f546c80d9386a297bbf9e6`, on the corresponding build
  platform. No native compilation ran on the workstation.

| Target artifact | SHA-256 | Smoke |
| --- | --- | --- |
| `miao-engine-aarch64-apple-darwin` | `97ad776e7c39d1de0895e207f002cd4c625f6b71d9dbb1c0a85e9ac6602dba34` | version 0.2.9, macOS arm64 |
| `miao-engine-x86_64-apple-darwin` | `6c615ac9625ddc694d861b549e55926d143cdd9ccf00cf6b3147e007c89451b1` | version 0.2.9 under the available macOS translation runtime |
| `miao-engine-x86_64-unknown-linux-musl` | `a2954e59898f06d46e2fba81a43024428759672f8c0bb7520ff4ead22f029447` | version 0.2.9, Linux x64 |
| `miao-engine-x86_64-pc-windows-msvc.exe` | `031f15c6ea77a8488f95ba29fd9716251a64ce6a9499a7cd9ec878840a2d86e8` | version 0.2.9, Windows x64 |

## Actual executable upgrade/rollback

All drills used isolated installation directories, not the daily `miao`
command or its database.

1. Install the real tag-built 0.2.8 baseline with the platform engine installer.
2. Install the verified Actions 0.2.9 binary.
3. Run the installed executable's `--version` and verify its installed hash
   still equals the manifest.
4. Verify the previous slot points to or contains the old executable.
5. Execute the documented rollback and verify both version 0.2.8 and the old
   executable hash.

| Platform | Old baseline SHA-256 | Result |
| --- | --- | --- |
| macOS arm64 | `e4a568925ac16a8d2fccc575cf5716bede803017a57e11c6e21f9834d23b114f` | PASS install / upgrade / previous slot / rollback |
| Linux x64 | `6e76aee591be157076882a2611a63ca2dcaa389ca41270fa2b311c589ab8e591` | PASS install / upgrade / previous slot / rollback |
| Windows x64 | `f515ee92115f25b66d3cd7cdc5e7e0c3e2a5893ab5c65f7fec44540e685b5ea2` | PASS install / atomic replacement / previous slot / rollback |

Windows used Windows PowerShell 5.1 for this actual artifact drill. The separate
installer fixture CI passed under PowerShell 5.1 and 7 (#864); that does not
substitute for an actual artifact PowerShell 7 drill.

## Still open

- Published archive download and checksum verification on all platforms.
- macOS notarization/quarantine/Gatekeeper behavior on a downloaded release.
- Native Intel macOS hardware (x64 execution here used translation).
- Database schema/data compatibility after upgrade and downgrade: these were
  executable-pointer drills and did not mutate an existing Session database.
- Confinement behavior against these exact distributed executables.

The v0.2.9 release was a draft without engine assets at inspection time. Do not
promote this report into a claim that a formal engine release was published.
