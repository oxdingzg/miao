# Artifact state and file-write confinement — 0.2.13

Collected 2026-10-16. This supplements the archive/startup/installer evidence in
[artifact-acceptance-0.2.13.md](artifact-acceptance-0.2.13.md) with behavior of
real engine executables. Only throwaway workspaces and ledgers are used. All
provider replies come from a local deterministic fixture; no paid model calls
are made.

## Reproduction

```sh
python3 script/engine-artifact-drill.py \
  --previous /absolute/path/to/0.2.12/miao-engine \
  --binary /absolute/path/to/0.2.13/miao-engine \
  --output /tmp/engine-artifact-report.json
```

The script uses the executables' ACP stdio interface, not imported engine
internals. It fails nonzero on any broken oracle. The optional output contains
platform, executable version/hash, and the measured checks. Compilation is not
part of the drill.

### Data stage

Three consecutive processes open the same ledger: previous, candidate,
previous again. Each appends one prompt/answer. After each replacement the
script checks SQLite integrity, byte-for-byte preservation of prior journal
rows, retained prompt/answer context in the next provider request, no duplicate
assistant output from resume, and exactly three provider calls for three
prompts. This is a compatibility measurement for these versions and workload,
not a guarantee for arbitrary future migrations.

### Process stage

An explicit workspace/allow-process policy grants the operation. The fixture
requests a real `run_command`, then the script checks native `tool.dispatched`
and `tool.completed` evidence. The positive control must write a relative file
inside the workspace with exit code zero. The negative control attempts to
replace a sentinel outside the workspace: its exit must be nonzero and the
sentinel must remain unchanged. This prevents mistaking a process that never
started, or an unusable workspace, for successful confinement.

## Outcomes

| Platform and candidate | Data stage | Workspace write | Outside write | Overall |
| --- | --- | --- | --- | --- |
| macOS arm64, published 0.2.13 | PASS | PASS, exit 0 | Denied, exit 1; sentinel unchanged | PASS |
| Linux x64, published 0.2.13 | PASS | PASS, exit 0 | Denied, exit 2; sentinel unchanged | PASS |
| Windows x64, published 0.2.13 | Data stage completed before process failure | FAIL, exit 1: cmd.exe rejects verbatim cwd and falls back to Windows directory | Not credited after failed positive control | FAIL |
| Windows x64, #919 source build | PASS | PASS, exit 0 | Denied, exit 1; sentinel unchanged | PASS (not a published artifact) |

All successful data stages retained 46 events and used exactly three provider
calls. Source builds and release-managed binaries must not be conflated just
because they report the same development version.

### Executable SHA-256

| Platform | Published 0.2.12 | Published 0.2.13 |
| --- | --- | --- |
| macOS arm64 | `a47e060dde9d41c71fa7e58f5a6c1643617e04166b3366a64b6fadbda592e88c` | `82a3610761d75c2c00afe51cc6ec65ce5ddcedbd4e95117bfdd3df867c130096` |
| Linux x64 | `ce282864fad169ec006b9b75aa8ea8c0b947b279100bbe79a6f9d8c8305e8b7f` | `9c69c6cc6095b4fd80de3dfca762a414766458d67c0d1049d251ac478b088749` |
| Windows x64 | `a02dcc8632ed53d5d49c532007f7e9f854487b85fcfb72ea4ace45ab31ab4896` | `4d4c565befe52fe273c99b1c8e8c8b3d0e6f8ee9d345f9e78c44aebffe9d8ef1` |

The Windows #919 source-build SHA-256 is
`5659b71c46e64e47733e314785b818fdeef20b925e5ec5852d02bba62d484466`.

## Defect found and remaining scope

The Windows positive control revealed two cwd problems: `cmd.exe` rejects a
normal DOS path written in canonical verbatim form (`\\?\C:\...`), and the
backend chose the first writable root instead of the requested subdirectory.
#919 separates cwd placement from writable ACL roots and losslessly simplifies
representable paths at the process boundary. Its regression fails with the old
source and passes with the fix on Windows. A post-release repetition against
the newly published Windows binary remains required.

This drill does not prove network/PTY isolation, all sandbox escape boundaries,
compatibility of pending tools/schedules/delegation across migrations, native
Intel macOS behavior, or compatibility of versions outside this pair. Those
remain separate G4/G6 acceptance gates.
