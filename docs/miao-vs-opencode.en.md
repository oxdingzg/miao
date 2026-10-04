# miao and its opencode baseline: differences, evidence, and availability

**Language:** [English](miao-vs-opencode.en.md) | [中文](miao-vs-opencode.zh.md)

miao builds on opencode's open-source coding workflow and invests in context efficiency, session control, and measurable operating cost. This page describes the fork's engineering work and its recorded baseline measurements. It is **not an audit of the current upstream product**, and shared capabilities such as model selection, MCP, and subagents are not claimed as exclusive to miao.

**Status as of 2026-10-04:** the latest official release is **v0.1.4**. This page separates released
behavior from newer changes merged into `main`. A source or preview build may still print the same
version number; its commit and build provenance determine which fixes it contains.

## What changes the daily workflow

| Area                      | miao's implementation                                                                        | Practical value                                                             | Availability                         |
| ------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------ |
| Input during execution    | Durable admission; steer at safe provider-turn boundaries; explicit queue at idle boundaries | Add constraints while work continues, with a recorded pending input         | V2                                   |
| Session collaboration     | `task`, resumable child sessions, project-scoped `list_sessions` / `send_message`            | Delegate focused work and exchange findings across conversations            | V2; messaging subject to permissions |
| Context stability         | Immutable Context Epoch baseline; chronological context updates                              | Reduce unnecessary changes to a reusable provider-cache prefix              | V2                                   |
| Cost and cache visibility | Per-turn usage, estimated cost, TTFT, cache-hit ratio and cache-state classification         | Diagnose expensive or slow turns with measurements                          | Implemented                          |
| Context controls          | Output bounding, optional pruning, compaction settings and cache TTL                         | Keep large tool results and long histories from consuming context unchecked | V2; advanced settings opt-in         |
| Long-task continuation    | Todo-driven loop with iteration / stall guards and optional cost budget                      | Continue multi-step work without a new prompt after every idle boundary     | V2, opt-in                           |
| Durable history           | Stored inbox and event-backed history; fork and export                                       | Keep inspectable conversations beyond a terminal's lifetime                 | V2; no automatic crash continuation  |
| Independent distribution  | Own release source and versioning; separate release, source, and preview commands            | Validate development builds while keeping the daily command usable          | Implemented                          |

| Transcript updates | Incremental durable-event application and viewport-windowed rendering | Reduce full-history reloads and off-screen rendering work | Released in v0.1.4 |
| Pending-input recovery | Read durable queued inputs even when another process admitted them without a live event | Recover visible pending work across processes | Released; v0.1.4 binary verified on Linux |
| Provider failure visibility | Visible final errors and bounded retry status | Distinguish a failed request from an apparently idle agent | Released in v0.1.4 |

Estimated costs depend on configured model rates and currency metadata. Budget checks stop further scheduling once the threshold is reached; they do not cap a request already in flight or replace provider billing. Prompt caching depends on the provider and workload, so there is no guaranteed task-level savings percentage.

## Newer source changes and planned work

The following are merged into `main` **after v0.1.4**, but are not yet part of an official release:

| Area                 | Merged implementation                                                                                                                                  | Evidence and boundary                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Stream consistency   | Reconcile queued stream text with history snapshots; protect live todos from stale full-sync snapshots                                                 | Regression coverage for duplicate text and reverted live updates (#45, #42)                |
| Session lifecycle    | Release deleted Sessions' history caches and older TUI transcript state                                                                                | Regression coverage for cleanup (#31, #32); not a general memory-leak claim                |
| Request recovery     | Classify transient connection and timeout failures for bounded retry                                                                                   | Real dropped-TCP-connection regression (#47); published output is not replayed             |
| Repetitive output    | Stop high-confidence short-prose loops in text/reasoning; neutralize their provider-facing history without deleting durable records or completed tools | Per-stream isolation and no-replay regressions (#53); not a proven provider/model root fix |
| Read-path efficiency | Cache immutable blob encodings, skip no-op projection writes and legacy reads for fully projected Sessions, page durable event tails                   | Focused implementation and regressions (#48–#52); no new end-to-end speedup percentage     |
| Project architecture | Core-owned project persistence and removal of the old miao Project facade                                                                              | Completed migration and lifecycle regressions (#35, #36, #46)                              |

The repetitive-output investigation found simultaneous normal sessions on the same provider/model,
including sessions with larger reported input sizes. Length alone does not explain that failure.
The initial guard recognizes short newline-delimited prose loops; it does not detect every form of
repetition. See the [investigation and limits](provider-output-repetition.en.md).

Background jobs integrated with V2 tools, post-crash automatic continuation, MCP progressive tool
discovery, blob garbage collection, and sandbox coverage beyond bash remain planned or incomplete.
They are not advertised as available features. Track current work in the [roadmap](roadmap.md).

The recent transcript, cache, and read-path improvements have regression evidence, but there is no
controlled before/after result proving a task-level speedup over current upstream opencode or a
specific memory reduction. The benchmarks below are historical measurements of a different scope.

## Recorded native benchmarks

The baseline is this repository's TypeScript implementation before the native work, not today's `anomalyco/opencode`. These are recorded same-machine release-build medians for isolated operations through the Rust addon. They exclude shared orchestration, I/O, LSP, formatting, provider latency, and model reasoning. They have not been re-run as part of this documentation update. The native edit/patch paths were part of the V1 compatibility tools and have since been removed; the numbers are kept as historical component measurements.

| Operation                                         | TypeScript baseline | Rust native | Speedup   | Integration scope      |
| ------------------------------------------------- | ------------------- | ----------- | --------- | ---------------------- |
| edit exact match (12k lines)                      | 0.21 ms             | 0.12 ms     | **1.7x**  | Removed V1 path        |
| edit fuzzy match (12k lines)                      | 0.76 ms             | 0.39 ms     | **1.9x**  | Removed V1 path        |
| edit match + diff stats (12k lines)               | 2.03 ms             | 1.78 ms     | 1.14x     | Removed V1 path        |
| apply_patch `deriveNewContents` exact (20k lines) | 1.67 ms             | 1.28 ms     | **1.3x**  | Removed V1 path        |
| apply_patch trim match (20k lines)                | 3.47 ms             | 1.76 ms     | **2.0x**  | Removed V1 path        |
| apply_patch unicode-normalize (20k lines)         | 13.06 ms            | 5.21 ms     | **2.5x**  | Removed V1 path        |
| git status small repo (10 files / 2 changes)      | 12.3 ms             | 1.0 ms      | **11.9x** | Prototype; not default |
| git status large repo (2200 files / 400 changes)  | 13.6 ms             | 5.8 ms      | **2.4x**  | Prototype; not default |

CPU-heavy matching and normalization show the clearest gains. In-process Git avoids subprocess startup overhead in the prototype. Neither result establishes an end-to-end coding-task speedup.

## Native tools and sandbox: where they apply

V2 is the only session runtime. Its tools live in `packages/core/src/tool`; the V1 compatibility tools and their native edit/patch paths in `packages/miao/src/tool` have been removed.

- **Edit / patch:** the V2 tools are TypeScript (`edit-fuzzy.ts` and related code). The native edit/patch accelerators benchmarked above are no longer wired into any shipped tool.
- **OS sandbox:** the V2 `bash` tool can run each command under the sandbox. macOS uses seatbelt and Linux Landlock; Windows has no backend. Enable it with `sandbox.mode: "workspace-write"` or `MIAO_SANDBOX=1`, and deny network with `MIAO_SANDBOX_DENY_NETWORK=1`. It is opt-in and off by default.
- **Native addon:** `MIAO_NATIVE=0` disables the addon. It backs the sandbox runner and other native helpers; it is not used for V2 edit/patch.
- **In-process Git:** the `gix` implementation and benchmarks exist, but it is not the default Git path.

Read the [guide](guide.en.md#56-kernel-level-sandbox-opt-in) and [integration risks](rust-integration-risks.en.md) before relying on the sandbox. Windows kernel sandbox parity is not implemented.

## Boundaries and ongoing work

- The V1 session runtime and its `/session/*` routes have been removed; all shipped clients run V2. Legacy database/configuration readers remain for compatibility; unprefixed non-session legacy routes have also been removed.
- Durable history and exact prompt retry reconciliation do not mean automatic recovery of interrupted provider execution or exactly-once shell side effects.
- Session execution and messaging wakes remain process-local; no cross-machine agent cluster is advertised.
- Code Mode is experimental. Generated clients and the embedded host are private workspace packages with evolving contracts.
- Per-target messaging policy persistence and receiving-drain loop accounting still have open design work; see [session messaging](../specs/v2/session-messaging.md).

See [README](../README.md) for the product overview, [the guide](guide.en.md) for usage, and [CONTEXT.md](../CONTEXT.md) for runtime contracts.
