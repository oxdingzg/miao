# Recorded native component benchmarks

[简体中文](native-benchmarks.zh.md)

These are historical measurements of miao primitives against its earlier TypeScript implementation, not a comparison with other agent products. The code integration was reviewed on 2026-10-07; the measurements were not rerun. For user-facing differences, see the [agent workflow comparison](agent-comparison.en.md).

## Recorded native benchmarks

The baseline is this repository's TypeScript implementation before the native work, not today's `anomalyco/opencode`. These are recorded same-machine release-build medians for isolated operations through the Rust addon. They exclude shared orchestration, I/O, LSP, formatting, provider latency, and model reasoning. They have not been re-run as part of this documentation update, and the V1 compatibility tools that first carried these paths have since been removed — but the primitives did not go with them. The V2 `edit` and `apply_patch` tools call the same native matching and derivation whenever the addon is loaded, which it is by default. The numbers stay component measurements of the primitives, not a fresh benchmark of the current tools.

| Operation                                         | TypeScript baseline | Rust native | Speedup   | Integration scope      |
| ------------------------------------------------- | ------------------- | ----------- | --------- | ---------------------- |
| edit exact match (12k lines)                      | 0.21 ms             | 0.12 ms     | **1.7x**  | V2 tool, native default |
| edit fuzzy match (12k lines)                      | 0.76 ms             | 0.39 ms     | **1.9x**  | V2 tool, native default |
| edit match + diff stats (12k lines)               | 2.03 ms             | 1.78 ms     | 1.14x     | V2 tool, native default |
| apply_patch `deriveNewContents` exact (20k lines) | 1.67 ms             | 1.28 ms     | **1.3x**  | V2 tool, native default |
| apply_patch trim match (20k lines)                | 3.47 ms             | 1.76 ms     | **2.0x**  | V2 tool, native default |
| apply_patch unicode-normalize (20k lines)         | 13.06 ms            | 5.21 ms     | **2.5x**  | V2 tool, native default |
| git status small repo (10 files / 2 changes)      | 12.3 ms             | 1.0 ms      | **11.9x** | V2 tool, native default |
| git status large repo (2200 files / 400 changes)  | 13.6 ms             | 5.8 ms      | **2.4x**  | V2 tool, native default |

CPU-heavy matching and normalization show the clearest gains. The recorded git numbers cover the prototype's listing step only; the wired `Git.status.entries` path also derives per-entry line stats and falls back to the git CLI, so its end-to-end gain is not re-measured here (see the integration risks). Neither result establishes an end-to-end coding-task speedup.

## Native tools and sandbox: where they apply

V2 is the only session runtime. Its tools live in `packages/core/src/tool`; the V1 compatibility tools and their native edit/patch paths in `packages/miao/src/tool` have been removed.

- **Edit / patch:** the V2 tools route through `packages/core/src/tool/edit-match.ts` and `packages/core/src/patch.ts`, which call the native `matchEdit` and `deriveNewContentsV2` primitives whenever the addon is loaded — by default. `edit-fuzzy.ts` and `deriveTs` are the TypeScript reference implementations, used when the addon is missing or `MIAO_NATIVE=0` is set. Matching and derivation are pure computation: file IO, permissions, conditional writes and settlement stay in Core.
- **OS sandbox:** the V2 `bash` tool can run each command under the sandbox. macOS uses seatbelt and Linux Landlock; Windows has no backend. Enable it with `sandbox.mode: "workspace-write"` or `MIAO_SANDBOX=1`, and deny network with `MIAO_SANDBOX_DENY_NETWORK=1`. It is opt-in and off by default, and it fails open — `sandbox.on_unavailable` defaults to `"warn"`, so a host with no backend runs the command unsandboxed unless you set it to `"fail"`.
- **Native addon:** on by default. It backs the sandbox runner, the edit matching, the patch derivation and other native helpers. `MIAO_NATIVE=0` disables all of it and the TypeScript implementations take over.
- **In-process Git:** `Git.status.entries` uses the native `gitStatusAsync` primitive (`gix`) whenever the addon is loaded, returning each path with its status and line additions/deletions; `MIAO_NATIVE=0` or a native failure falls back to the `git status`/`git diff --numstat` subprocess path. The other Git operations still shell out.

Read the [guide](guide.en.md#56-kernel-level-sandbox-opt-in) and [integration risks](rust-integration-risks.en.md) before relying on the sandbox. Windows kernel sandbox parity is not implemented.
