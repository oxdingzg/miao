# Risks of wiring miao-native into production

**Language:** [English](rust-integration-risks.en.md) | [中文](rust-integration-risks.zh.md)

This page is only about the pitfalls of actually wiring `crates/miao-native` and `miao-run` into the
`packages/miao` production paths. For the upside, see [miao vs opencode](miao-vs-opencode.en.md).

## 1. Blockers (cannot integrate without solving these)

### R1. Packaging and distribution (current platform solved / cross-platform pending) (High)
- Evidence: `packages/miao/script/build.ts` uses `bun build --compile` to produce a **single-file** binary; native dependencies (`@ff-labs/fff-bun`, etc.) are embedded from node_modules.
- Current state: added `packages/native` (`@miao/native`), which loads the addon with a **literal** `require("./miao-native.node")` that `--compile` embeds (verified: the compiled binary prints `addon: loaded`). `packages/miao` references it statically through `@miao/native` and falls back to TS when absent.
- Remaining: a multi-platform release needs the addon **built per target** (`--single` on the host platform already works; `packages/miao/script/build.ts` now builds the host addon and hides it for non-host targets so a wrong-platform `.node` is not embedded). `miao-run` is now discovered from `MIAO_RUN` or next to the executable (`resolveMiaoRun()`); when absent the sandbox is unavailable and callers fall back. A release still needs to ship `miao-run` alongside the binary.
- Mitigation: the release pipeline runs `packages/native/build.ts` for each target before packaging.

### R2. CI is currently passing falsely (High)
- Evidence: `packages/miao/test/tool/edit-native.test.ts` uses `withNative = native ? describe : describe.skip`
  and likewise `withMiaoRun`; when the `.node` / `miao-run` is absent the whole suite is skipped.
- Consequence: CI that does not build Rust goes "green" while running zero native cases; any Rust
  regression goes unnoticed.
- Mitigation: before integrating, add "build Rust + run parity, **no skipping allowed**" to CI as a hard gate.

### R3. Synchronous calls block the event loop (High)
- Evidence: git in `core/git.ts` / `snapshot` goes through `ChildProcess` (async Effect), while our
  `gitStatus` is a **synchronous napi call**. JS is single-threaded, so rendering, other sessions'
  fibers, and SSE all stop during the call.
- Magnitude: ~1 ms on a small repo is unnoticeable; 5.6 ms on a large repo; a chromium-scale checkout
  could be tens to hundreds of ms and visibly stall the UI/concurrency.
- Mitigation: git calls must go through a napi async task / worker, or stay a sidecar process; do not
  call them synchronously from Effect.

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
- Conclusion: `gitStatus` only replaces the listing step (~13 ms to 1-5 ms); **the end-to-end snapshot
  step gains little** unless add/write-tree are also implemented with gix (complex; gix's index write
  support is limited).

### R8. gix lifecycle and resources (Medium)
- Every call runs `gix::open` (part of the 5.6 ms). Caching a `Repository` drags in mmap'd packs, fds,
  and thread pools, with fd/memory-leak and thread-safety concerns across multiple
  workspaces/sessions.
- Windows features (sha1 must be enabled) and path handling are unverified.

## 4. Sandbox

### R9. Platform and deprecation (High)
- macOS only, and `sandbox-exec` is deprecated by Apple and may be removed in a future macOS; there is
  no Linux (landlock/seccomp) or Windows backend, so **behavior is inconsistent**.

### R10. Blocking legitimate workflows (High)
- Network denied by default directly breaks `npm install`, `git fetch`, and any model calls a child
  command makes; deny-by-default blocks toolchain/cache writes.
- Escalation relies on parsing `Operation not permitted` from stderr: denials inside a program's own
  syscalls **may omit the path or be silent**, so it misses them and the user sees an unexplained failure.

### R11. Semantic change and product decision (Medium)
- Sandboxing bash wholesale **stacks** on the existing rule-based permissions, producing a
  "approved but still denied by the kernel" double experience. Default-on vs opt-in is a product
  decision, not a detail.

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

1. **Solve R1/R2 first**: platform subpackages + CI-enforced parity (no skipping). Otherwise do not integrate.
2. **Integrate the lowest-risk pieces first**: `edit` matching and `apply_patch` (pure, synchronous,
  fully comparable, parity already exists), behind a feature flag with fallback.
3. **Defer git**: build the async/worker wrapper first (R3) and add a snapshot **full-path** benchmark
   (including add/write-tree); only integrate when it covers the dominant cost.
4. **Sandbox as an optional capability**: opt-in, with an explicit fallback, Linux backend first, before
   any default-on; do not rely on stderr parsing as the only escalation signal.
5. Every step gates on "existing tests green + new parity not skipped + a memory/RSS baseline".

## Conclusion

The real blockers are **R1 packaging** and **R2 the false-green CI**, followed by **R3 synchronous
blocking**; for the sandbox, **R9/R10** mean it can only be opt-in short term. The pure-function pieces
(edit/apply_patch) are manageable and can go first; git and the sandbox carry higher engineering cost
and their gains must be re-measured end to end.
