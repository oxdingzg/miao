# Rewriting miao in Rust: My Assessment and Plan

**Language:** [English](rust-rewrite-feasibility.en.md) | [中文](rust-rewrite-feasibility.zh.md)

## Background

I have been thinking about rewriting part of miao in Rust. The motivation is not the vague "Rust is faster", but three concrete things:

1. **Resident memory**: a Bun process easily grows to hundreds of MB under long sessions and large repos.
2. **Sandboxing**: bash and tool permissions are currently enforced only by rules; real isolation requires process-level controls (seccomp/landlock).
3. **Single-file distribution**: already solved by Bun's `--compile`, so this is not a motivation.

This document is my judgment and plan, not an evaluation report.

## My conclusion

**No full rewrite.** Not because it is technically impossible, but because the return on investment does not hold.

The engine (`miao + core + tui + llm + server + schema + protocol + client + plugin`) is roughly 176k lines of TS, and about 70% of it is network IO or tightly bound to the JS ecosystem, where moving to Rust yields near-zero or negative benefit.

What genuinely deserves Rust is four kinds of modules with clean boundaries and no ecosystem coupling: **text processing, process/sandbox, search, and Git**. I will build those four into a standalone native library and keep the rest in TS.

## I went through the repo

Measure the size first, then talk about language.

| Area | Size | Disposition |
|---|---|---|
| Engine `miao/core/tui/llm/server/schema/protocol/client/plugin` | ~176k lines | Under consideration here |
| `app`(Solid/Vite), `ui`, `console`, `stats`, `web/docs` | ~300k lines | Frontend, untouched |
| `desktop`(Electron) | 124 files | Untouched |
| Tests | miao 300 + core 160 + tui 53 files | Kept and reused |

Engine side: `miao/src` has 98 runtime dependencies, **528 files import `effect`**, 25 tools, 26 CLI commands, 21 HttpApi groups.

One fact reshaped my priorities: **many hot paths are already native bindings**. Search uses `@ff-labs/fff-*`, file watching uses `@parcel/watcher`, PTY uses `node-pty`, images use `photon-node`, SQLite uses `bun:sqlite`. So Rust's incremental benefit only exists where "those libraries do not cover it, the JS layer is CPU-bound, or a sandbox is required". Elsewhere, switching languages just changes the syntax.

## Why a full rewrite does not work

**1. Effect is the backbone, not a library.** The whole engine is built on Effect v4 beta: Layer/DI, Fiber, Stream, Schema, structured concurrency. Rust only has tokio + serde, so the framework would have to be redesigned first. That is not translating code; it is re-architecting.

**2. The AI SDK is JS-exclusive.** 19 `@ai-sdk/*` providers plus openrouter/gateway/gitlab/venice. Reimplementing streaming tool-calls, reasoning fields, images, usage, and OAuth device code in Rust is the heaviest part of the project and the most likely to lag forever.

**3. The TUI is a bespoke renderer.** `@opentui/core + @opentui/solid` with shimmer animations and a plugin API. Switching to ratatui loses both visual fidelity and plugin compatibility.

**4. Plugins must run user JS/TS.** A Rust host still needs an embedded JS runtime (deno_core/quickjs) or must keep Node, so nothing is saved.

On cost, the Rust side would be roughly 150k–250k lines and 6–18 engineer-months to reach parity, with providers/TUI forever in catch-up. I do not think that is worth it.

## What I will do

Three steps; the first two are conditional, the third is only a direction.

### Step 1: extract `miao-native`, move only the four modules

Ordered by priority, where the criterion is net benefit (performance/memory plus strategic value, minus migration cost and ecosystem loss):

| Order | Module | Target files | Why first |
|---|---|---|---|
| 1 | Text: diff/patch/edit/format | `core/tool/{edit,apply-patch}`, `miao/src/format`, `miao/tool/{edit,apply_patch}`, `session/revert-diff` | Pure CPU text algorithms, ecosystem-free, verifiable by the existing tests |
| 2 | Process/sandbox | `core/pty`, `AppProcess`, `miao/tool/{shell,bash}` | seccomp/landlock is something JS cannot do; Rust is required here |
| 3 | Search/walk/ignore | `core/filesystem/*`, `core/tool/{grep,glob,read}` | One stack of ripgrep+ignore+globset; but fff is already native, so measure the delta first |
| 4 | Git/worktree/snapshot | `core/git.ts`, `worktree`, `snapshot` | On large repos and high-frequency diffs, `gix` clearly beats the JS layer; text-heavy like #1 |

What these four share: no dependency on Effect, the AI SDK, or the UI; they can stand alone as a library and be tested independently.

### Step 1 first pick: rework the edit/diff pipeline (current vs Rust)

Of the four modules I start with this one, not because it is the fastest, but because it satisfies all of: it runs on every edit, it is pure logic that touches no IO or Effect, the existing tests can verify equivalence, and it is the smallest surface.

**Current implementation**

- Matching: `replace()` in `packages/miao/src/tool/edit.ts` runs nine replacers in sequence (Simple / LineTrimmed / BlockAnchor / WhitespaceNormalized / IndentationFlexible / EscapeNormalized / TrimmedBoundary / ContextAware / MultiOccurrence). `BlockAnchor` measures similarity with a full-matrix Levenshtein.
- Diff generation: `diffLines` and `createTwoFilesPatch` from `diff` (jsdiff 8.0.2), called repeatedly in `miao/src/tool/{edit,apply_patch}.ts`, `core/src/tool/{edit,apply-patch}.ts`, `snapshot/index.ts`, and `project/vcs.ts`.
- A single edit calls `createTwoFilesPatch` several times: once before formatting, once after, and again on the core side.

**Measurements (same machine, release/optimized; synthetic samples)**

Diff generation, 200 changes:

| Lines | Current jsdiff | Rust `similar` | Speedup |
|---|---|---|---|
| 12k | 16.3 / 18.6 ms | 4.5 / 3.9 ms | ~3.5–4.7x |
| 60k | 24.3 / 27.3 ms | 15.7 / 12.4 ms | ~1.5–2.2x |
| 150k | 40.1 / 48.2 ms | 33.2 / 32.8 ms | ~1.2–1.5x |

Edit matching (12k-line file) and Levenshtein:

| Case | Current |
|---|---|
| Exact match | 0.24 ms |
| Fuzzy match (indent / whitespace) | 0.77–0.88 ms |
| Levenshtein on a long line (1900 chars) | 36.8 ms (full matrix) / 12.7 ms (rolling row) |

Rust `strsim` Levenshtein at the same size: **3.1 ms**, about 12x faster than the full matrix and 4x faster than the rolling row.

**My conclusion**

- Edit matching on a typical small file is already sub-millisecond, so Rust brings no perceptible gain here. Do not count on this.
- The real wins are two: **large-file diff (3–5x)**, and **flattening the 36 ms Levenshtein cliff on pathological inputs (long lines / minified files) by ~12x**.
- One more thing not in the numbers: jsdiff allocates a JS object and string per change, which is steady memory pressure and GC in long sessions; the Rust side is O(N) bytes. That contributes more reliably to the "lower resident memory" goal.

**Interface**: expose via napi-rs `applyEdit(content, oldString, newString, replaceAll) -> { content, additions, deletions } | error` and `diffLines / unifiedPatch(before, after) -> { patch, additions, deletions }`, keeping the current return shape. The native side does pure functions only; it touches no file IO and no Effect.

**Acceptance**: the existing miao/core edit/apply_patch tests stay green; on 12k/150k-line samples the diff is no worse and peak memory drops; the long-line case costs no more than today.

**PoC result (implemented, with one optimization pass)**

The code is in `crates/miao-native/`: `src/lib.rs` ports the nine replacers, `replace()`, `diffStats`, and `unifiedPatch`, exposed via napi-rs; `bun run build.ts` produces `miao-native.node`. Pure functions, no IO or Effect.

- Parity: 12 Rust unit tests + 18 JS parity tests pass, including a 400-case fuzz corpus; `unifiedPatch` matches jsdiff byte for byte.
- Matching (12k-line file): exact native ~0.16 ms vs TS ~0.23 ms (1.4x); fuzzy indent ~0.41 ms vs ~0.82 ms (2.0x).
- Full pipeline (match + diff stats): native ~1.9-2.2 ms vs TS ~2.0-2.6 ms, dominated by the diff (`similar` is about the same as jsdiff).
- Pathologic long lines: ~10 ms vs ~21-30 ms (2-3x).
- `apply_patch` `deriveNewContents` (20k-line file, match near the end, so the 4-pass seek runs): exact native ~1.3 ms vs TS ~1.7 ms (1.3x); trim pass ~1.8 ms vs ~3.5 ms (2.0x); unicode-normalize pass ~5.2 ms vs ~13 ms (2.5x).
- git status (repo with 2200 files, 400 changes): `gix` native `gitStatus` in-process ~5.6 ms; the `git diff-files` + `git ls-files` pair the snapshot module uses today ~13.5 ms (~2.4x); `git status --porcelain` ~8.1 ms (~1.4x).
- Sandbox (macOS seatbelt, `miao-run`): writes inside `--workdir` succeed, writes outside are denied ("Operation not permitted"); network denied by default and restored with `--allow-network` (HTTP 200); a normal command such as `git status` still runs. This is process-level isolation the rule-based permissions cannot provide. False denials are handled with `--allow-path` or the `--compat` fallback (allow default, deny only credential paths and network); for integration, `--deny-report` returns the blocked paths and `runSandboxed` asks the user, then retries with more `--allow-path` entries.
- `search` is not done separately: `grep/glob` already go through the `rg` binary and fuzzy find through the native `@ff-labs/fff-*` library, so the incremental gain is small.

**One optimization pass worth recording**: the first version was slower than TS on the typical case. The cause was neither the language nor the NAPI boundary (an `echo` of a 597 KB string costs ~0.08 ms); it was `str::find`/`str::rfind` (std two-way) being slower than the JS engines' SIMD `indexOf` (0.38 / 0.45 ms vs ~0.05 ms), plus `slice_span` rebuilding the whole file with `lines.join("\n")` just to slice one block. After switching to `memchr::memmem`, replacing `rfind` with a forward uniqueness check from `index + 1`, and slicing the original content directly, native is faster than TS on every measured case. `deriveNewContents` got the same treatment: no `to_vec()` clone of the whole line vector, no per-line `format!` temporary, just direct pushes into the output.

Conclusion: behaviour is correct and, after optimization, the typical and pathologic paths both lead; but the full pipeline is dominated by the diff, so the end-to-end gain is still limited. Not wired into production; `tool/edit.ts` still uses TS and jsdiff.

### Native modules landed (PoC; pure functions, `MIAO_NATIVE`-gated with a TS fallback)

Each function ships with Rust unit tests plus a JS parity test; parity is not allowed to skip (`MIAO_NATIVE_REQUIRED=1`).

| Area | Functions | Parity target |
|---|---|---|
| Text | `replaceOnly` / `applyEdit` / `diffStats` / `unifiedPatch` / `deriveNewContents` | JS `edit` / `jsdiff` (byte-exact) |
| Text | `detectLineEnding` / `normalizeLineEndings` | TS reference |
| Text | `countTokens` (o200k / cl100k) | `gpt-tokenizer` |
| Text | `sha256Hex` / `blake3Hex` | Node crypto / BLAKE3 known vector |
| Git | `gitStatus` / `gitRevParse` / `gitBlob` / `gitWorktreeChanges` / `gitMergeBase` (all async variants) | `git status` / `rev-parse` / `show` / `diff --name-only` / `merge-base` |
| Walk | `walkFiles` (`ignore` + `globset`, honors `.gitignore`) | recursive listing + gitignore behavior |
| Sandbox | `miao-run` (macOS seatbelt) | behavior tests (write allowlist / network denied) |

Performance: `git rev-parse` native ~0.2-0.5 ms vs subprocess ~5-9 ms (~20x). None of it is wired into production.

### Modules not landed, and why

- **#2 sandbox cross-platform (Linux landlock/seccomp, Windows)**: the `landlock` dependency is present, but it can only be built and verified on the matching platform; the current machine is macOS, so no trustworthy test is possible here. Left to Linux/Windows runners.
- **#3 diff algorithm upgrade (`imara-diff` over `similar`)**: changes hunk boundaries and breaks byte-exact parity with jsdiff; conflicts with the lossless principle, so **not done**.
- **#6 native tree-sitter**: new capability with an unclear parity target and heavy dependencies; deferred.

### Step 2: decide based on metrics

- SQLite session storage/migrations/retrieval (real benefit, but the data model is bound to Effect-Schema/Drizzle; start with a read-only index instead of replacing the storage layer)
- Native tree-sitter parsing (removes WASM overhead; small scope)
- Token counting, image processing (limited benefit)

Touch these only when clearly bottlenecked on memory or large-repo performance.

### Step 3: a protocol-first headless engine (long-term direction)

The repo already has a clean `Schema → Protocol → Server` layering with HttpApi/SSE. Long term, define a versioned core protocol and let a Rust headless engine implement the same protocol, so the TS shell shrinks over time. This is the only realistic path to full Rust, but the protocol comes first, then the language. Not now.

## How Step 1 lands

**Interface shape**: default to `napi-rs` (Bun supports NAPI); fall back to a narrow `bun:ffi` + `cdylib` C ABI when needed, to avoid Node ABI rebuilds.

**Sandbox as a sidecar**: seccomp/landlock must wrap the child process, not the host. So build a small `miao-run` executable and route `AppProcess` exec through it.

**Crate choices** (draft):

| Module | Crates |
|---|---|
| diff/patch | `similar`, `imara-diff`, `diffy` |
| pty | `portable-pty` |
| sandbox | `landlock`, `seccompiler` |
| search | `grep`, `ignore`, `globset`, `walkdir` |
| git | `gix` |
| tree-sitter | `tree-sitter` + grammars |

**Boundary rule**: the native library does only pure computation and process primitives. It does not orchestrate IO, touch Effect, or hold session state. Every call passes inputs in and returns outputs explicitly from the TS side.

## Acceptance criteria

Before each step merges:

- Behavior equivalence: the existing miao/core test suites stay green, especially the edit/apply-patch cases.
- Memory: RSS in long sessions drops meaningfully versus baseline (measure the baseline first, then set the threshold).
- Latency: search and diff are no worse than the current implementation on a real large repo.
- Crash isolation: a panic on the native side must not take down the main process.
- Distribution: builds on macOS/Linux/Windows without introducing runtime dependencies.

If it fails these, it does not merge; the TS implementation stays as the fallback.

## What I am explicitly not doing

- Provider / AI SDK (`llm/protocols`, `miao/provider`, `core/github-copilot`)
- TUI rendering (`tui`)
- Plugin host / SDK / codemode
- Server / HttpApi / SSE / routing, MCP/ACP/LSP transport
- Effect runtime, DI, observability, CLI framework

These are either network IO, a JS-ecosystem monopoly, or tightly framework-coupled. Almost all of the "not worth it" in a full rewrite comes from this layer.

## Risks

- **Two stacks**: the native library and the TS fallback coexist, so any interface change must be mirrored. Behavior-equivalence tests are the safety net.
- **Build complexity**: prebuilt native artifacts for three platforms add CI weight; caching and release design are required.
- **fff is already native**: the search delta may be smaller than expected; benchmark first, and drop it if it is not there.
- **Effect dependency**: every native boundary must bypass Effect, or framework semantics leak into Rust.

## Next step

Pin the four Step-1 modules down to specific files, functions, crates, interface signatures, and estimated lines as an executable PoC checklist, starting with diff/patch, because it is the easiest to verify with the existing tests.
