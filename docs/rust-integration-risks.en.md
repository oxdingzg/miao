# Risks of wiring miao-native into production

**Language:** [English](rust-integration-risks.en.md) | [中文](rust-integration-risks.zh.md)

This page is only about the pitfalls of actually wiring `crates/miao-native` and `miao-run` into the
`packages/miao` production paths. For the upside, see [native component benchmarks](native-benchmarks.en.md).

## 1. Blockers (cannot integrate without solving these)

### R1. Packaging and distribution (solved) (High)
- Evidence: `packages/miao/script/build.ts` uses `bun build --compile` to produce a **single-file** binary; native dependencies (`@ff-labs/fff-bun`, etc.) are embedded from node_modules.
- Addon: added `packages/native` (`@miao/native`), which loads the addon with a **literal** `require("./miao-native.node")` that `--compile` embeds (verified). A release uses `--single`, so each platform runner builds the **host** addon (`packages/native/build.ts`) and hides it for non-host targets so a wrong-platform `.node` is not embedded.
- Sandbox sidecar: no separate `miao-run` needs to ship. The sandbox logic moved to `crates/miao-sandbox`, exposed by the addon as `sandboxProfile` (macOS profile) and `sandboxRestrict` (Linux Landlock); the compiled binary runs sandboxed children by **self-executing** through the hidden `__sandbox-run` command (`build.ts` defines `MIAO_PACKAGED`, and `SandboxRunner.resolve()` returns `process.execPath` + `__sandbox-run`). Single file, naturally per-platform, one signature/notarization. `miao-run` stays only for dev/tests and `MIAO_RUN` overrides.
- Verified: `miao-preview __sandbox-run --print-profile`, a write inside the workdir succeeds, a write outside is denied, and the deny-report is written.

### R2. CI is currently passing falsely (High)
- Evidence: when this was written, the JS native suites in `packages/miao/test/tool/*-native.test.ts`
  used `withNative = native ? describe : describe.skip` (and `withMiaoRun` likewise), so an absent
  `.node` / `miao-run` skipped the whole suite. Those suites were removed with the V1 tools; the
  current native coverage is the Rust unit tests plus `packages/core/test/sandbox-policy.test.ts`
  and `packages/core/test/tool-bash-sandbox.test.ts`.
- Consequence: CI that does not build Rust goes "green" while running zero native cases; any Rust
  regression goes unnoticed.
- Mitigation: the `native` and `sandbox-linux` jobs in `.github/workflows/native.yml` build Rust and
  run the sandbox tests as a hard gate.

### R3. Synchronous calls block the event loop (High)
- Evidence: git in `core/git.ts` / `snapshot` goes through `ChildProcess` (async Effect), while our
  `gitStatus` is a **synchronous napi call**. JS is single-threaded, so rendering, other sessions'
  fibers, and SSE all stop during the call.
- Magnitude: ~1 ms on a small repo is unnoticeable; 5.6 ms on a large repo; a chromium-scale checkout
  could be tens to hundreds of ms and visibly stall the UI/concurrency.
- Mitigation: git calls must go through a napi async task / worker. `gitStatusAsync` is implemented (napi `AsyncTask`, runs on the libuv threadpool); the sync `gitStatus` is kept only for tests/benchmarks.

## 2. Correctness

### R4. JS vs Rust string semantics (Medium-High)
Current parity is mostly ASCII; the following produce **different results**, not errors:
- Length: JS `.length` is UTF-16 code units, Rust `chars()`/bytes differ, so `is_disproportionate_match`
  and similarity thresholds diverge on emoji/astral characters.
- `trim()` whitespace sets differ (JS includes `\uFEFF`, etc.; Rust `char::is_whitespace` does not),
  affecting LineTrimmed/BlockAnchor.
- Regex: `normalize_whitespace` uses `\s+`; Rust regex and JS `\s` do not cover identical code points.
- Mitigation: add emoji/CJK/mixed-line-ending parity corpora; explicitly align or document the
  unsupported range.

### R5. A panic takes down the process (Medium-High)
- Evidence: napi-rs's own source notes that panics can `abort` the process. Our code still has
  `unwrap` and indexing paths.
- Mitigation: wrap the napi boundary in `catch_unwind`, remove `unwrap`/out-of-range access, and fuzz.

### R6. Error semantics and Effect integration (Medium)
- On the TS side, `core/tool/edit.ts` maps `FileMutation.StaleContentError` to a specific `ToolFailure`,
  and `apply_patch` throws `Error` with fixed text. The native side throws a napi `Error`; the message
  matches but the **type is lost** (no longer a specific Error class), so mapping must be rewritten,
  without breaking Effect interruption/defect semantics.
- `deriveNewContents`'s `unified_diff` is the simplified diff; production only uses `content`/`bom`. Do
  not silently swap it for `similar`'s unified diff when integrating.

## 3. Scope and overstated gains

### R7. The git gain is overstated (Medium)
- Evidence: the snapshot hot path, after the `diff-files`+`ls-files` pair we benchmarked, still runs
  `git add --all` (`snapshot/index.ts:149`) and `write-tree` (`:341`) as subprocesses, and on large
  repos those dominate.
- Conclusion: `gitStatus` only replaces the listing step; **the end-to-end snapshot step gains little** unless add/write-tree are also implemented with gix (complex; gix's index write support is limited).
- Measured (3300 files / 600 changes): listing 18.2 ms to native `gitStatus` 9.4 ms; `git add --all` 6.4 ms; `write-tree` 8.3 ms. The whole step goes ~32.9 ms to ~24.0 ms (~27%), with add/write-tree still ~44%.

### R8. gix lifecycle and resources (Medium)
- Every call runs `gix::open` (part of the 5.6 ms). Caching a `Repository` drags in mmap'd packs, fds,
  and thread pools, with fd/memory-leak and thread-safety concerns across multiple
  workspaces/sessions.
- Windows features (sha1 must be enabled) and path handling are unverified.

## 4. Sandbox

### R9. Platform and deprecation (High)
- Backends today: macOS seatbelt (`sandbox-exec`) and Linux Landlock (TCP denied, ABI v4 BestEffort);
  there is still no Windows backend, so **behavior is inconsistent across platforms**, and
  `sandbox-exec` is deprecated by Apple and may be removed in a future macOS.
- Mitigation: the Windows backend (AppContainer + Job object) is specced in
  [windows-sandbox](windows-sandbox.en.md) and remains to be implemented; `SandboxRunner.available()` returns
  false where there is no backend and callers fall back.

### R10. Blocking legitimate workflows (High)
- Network denied by default directly breaks `npm install`, `git fetch`, and any model calls a child
  command makes; deny-by-default blocks toolchain/cache writes.
- Escalation relies on parsing stderr: macOS seatbelt says `Operation not permitted`, Linux Landlock
  says `Permission denied` (verified on a real host), and shell prefixes vary
  (`sh: /path: ...` vs `sh: 1: cannot create /path: ...`). The parser now matches both markers and
  takes the path from the first `/`, but it stays heuristic: relative paths without `/`, or denials
  silent inside a program's own syscalls, are missed and the user sees an unexplained failure. It must
  not be the only escalation signal.

### R11. Semantic change and product decision (Medium)
- Wired as **opt-in** (`MIAO_SANDBOX=1` or `sandbox.mode: "workspace-write"`): the V2 `bash` tool
  seeds the sandbox writable roots from the active Location, the command's working directory, temp
  directories, and configured `writable_roots`, so "approved but denied by the kernel" is minimized;
  paths the kernel still denies go through an `external_directory` prompt and the command is rerun
  with them allowed. Network is allowed by default (`MIAO_SANDBOX_DENY_NETWORK=1` denies it).
  Default-on vs opt-in **remains a product decision**.

## 5. Engineering and supply chain

### R12. Dependencies and size (Medium)
- `gix` pulls ~130 crates, increasing build time, audit surface, and binary size (already a 110 MB
  single file).

### R13. Two implementations to maintain (Medium)
- TS and native coexist behind a feature flag; interface changes must be mirrored and the test matrix
  doubles. The fallback path must stay viable long term.

### R14. Observability (Low-Medium)
- Native errors lack JS stack traces; logs/telemetry need work or production issues are hard to debug.

## 6. Recommended order and gates

1. ~~Solve R1/R2 first~~ -> **solved**: per-platform addon build plus sandbox self-exec (R1), and the
   `native`/`sandbox-linux` CI jobs forcing a Rust build and running the sandbox tests (R2).
2. ~~Integrate the lowest-risk pieces first~~ -> **taken differently**: the plan rested on the
   assumption that native `edit`/`apply_patch` were consumed only by the V1 tools. That assumption did
   not hold — `packages/core/src/tool/edit-match.ts` and `packages/core/src/patch.ts` call the same
   `matchEdit` and `deriveNewContentsV2` primitives from the V2 tools, gated on `MIAO_NATIVE` (on by
   default). The V1 removal took the tools, not the primitives.
3. **Defer git**: build the async/worker wrapper first (R3) and add a snapshot **full-path** benchmark
   (including add/write-tree); only integrate when it covers the dominant cost.
4. **Sandbox as an optional capability**: now wired opt-in into the V2 `bash` tool (`MIAO_SANDBOX=1` or
   `sandbox.mode`) with a fallback; the Linux backend is in; default-on is still open. Do not rely on
   stderr parsing as the only escalation signal.
5. Every step gates on "existing tests green + new parity not skipped + a memory/RSS baseline".

## Conclusion

**R1 packaging** (per-platform addon build plus sandbox self-exec) and **R2 the false-green CI** are
solved; **R3 synchronous blocking** already has async variants, and wiring must use Async. The real
remaining risks are **R4 string semantics**, **R5/R6 correctness** (panic/error types), and the
sandbox's **R9 (platform inconsistency) / R10 (false denials, unreliable stderr escalation)** — which
mean the sandbox can only be opt-in short term. The pure-function pieces (edit/apply_patch) are
manageable and can go first; git and the sandbox carry higher engineering cost and their gains must be
re-measured end to end.
