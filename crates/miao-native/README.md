# miao-native (PoC)

Rust PoC for the plan in `docs/rust-rewrite-feasibility.en.md` / `.zh.md`. It covers the pieces
that are pure computation (edit matching, patch application, diff), one subprocess-free capability
(git status via `gix`), and one platform capability JS cannot provide (the macOS seatbelt and
Linux Landlock sandbox).

## Layout

- `src/lib.rs`: the restored edit strategies behind one safe matcher (`matchEdit`),
  `replace()`/`replaceOnly`/`applyEdit`, `diffStats`, `unifiedPatch`, `deriveNewContents` +
  `deriveNewContentsV2`, `gitStatus`, and Rust unit tests.
- `src/bin/miao-run.rs`: `miao-run`, an OS sandbox wrapper (macOS seatbelt / Linux Landlock).
- `build.ts`: builds the cdylib with cargo and copies it to `miao-native.node`.

## Build

```sh
bun run build.ts            # cargo build --release + copy cdylib to miao-native.node
cargo build --release       # also builds target/release/miao-run (the sandbox bin)
```

## Test

```sh
cargo test --release        # lib + bin Rust unit tests
```

The JS parity suites compare the Rust matchers against the TypeScript references across fixtures and a
generated corpus (`packages/core/test/tool-edit-native.test.ts`, `packages/core/test/patch-native.test.ts`);
they skip when the addon is absent.

## API

```ts
matchEdit(content, oldString, replaceAll?) -> { kind: "none" | "ambiguous" | "disproportionate" | "match", find?, count? }
replaceOnly(content, oldString, newString, replaceAll?) -> string
applyEdit(content, oldString, newString, replaceAll?) -> { content, additions, deletions }
diffStats(before, after) -> { additions, deletions }
unifiedPatch(before, after, filePath) -> string
deriveNewContents(chunks, filePath, originalText) -> { content, unifiedDiff, bom }
deriveNewContentsV2(chunks, filePath, originalText) -> { content, unifiedDiff, bom }
gitStatus(path) -> Array<{ path, status }>
```

`matchEdit` is the shared contract with `packages/core/src/tool/edit-match.ts`: an exact occurrence
wins, otherwise the restored V1 strategies run in order, each gated by line-anchor, disproportionate
span and uniqueness safety. `replaceOnly`/`applyEdit` build on it; an older addon without `matchEdit`
falls back to the TypeScript reference. `deriveNewContentsV2` is the shared contract with
`packages/core/src/patch.ts`'s `deriveTs`, used by the V2 apply_patch path; `deriveNewContents` keeps
the legacy insertion point for `packages/miao/src/patch/index.ts`, and an older addon without
`deriveNewContentsV2` falls back to the TypeScript reference. `gitStatus` uses `gix` and returns
worktree-vs-index changes (`added` / `modified` / `deleted` / `renamed` / `copied`).

`miao-run`:

```sh
miao-run --workdir <dir> [--allow-path <dir>]... [--allow-network] [--compat] [--deny-report <file>] [--print-profile] -- <command> [args...]
```

- Strict mode (default): deny-by-default. Reads everywhere and process execution are allowed,
  writes are limited to the workdirs plus temp/dev, and network is denied unless `--allow-network`.
- `--allow-path <dir>` adds extra writable directories (tool caches, package managers, etc.) without
  opening up everything.
- `--compat`: compatibility-first. Allow default, then deny writes only to credential paths
  (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`, `~/.config/gh`) and deny
  network unless `--allow-network`. Far fewer false denials, weaker isolation.
- `--deny-report <file>` writes `{"denied":[...],"exitCode":n}` so the caller can escalate a denial.
- `--print-profile` prints the generated seatbelt profile and exits; the command's stderr names the
  path a denial blocked, which is the fastest way to find what to allow next.
- On platforms without a backend (Windows) it runs the command unsandboxed.

### Escalating denials

`packages/core/src/sandbox.ts` and `packages/core/src/sandbox/runner.ts` are the integration seam:
`Sandbox.wrap` runs the command, reads `--deny-report`, and the V2 `bash` tool requests
`external_directory` approval for the blocked directories, then retries with them writable. It is
wired into the V2 `bash` tool.


## PoC results (historical, measured against the removed V1 TS tools)

These numbers predate the V2 matcher and are kept as history only; they are not a measurement of the
current `matchEdit` contract.

Edit / patch:

- Matching only, 12k-line file: exact native `replaceOnly` ~0.12 ms vs TS `replace` ~0.21 ms (1.7x);
  fuzzy indent ~0.39 ms vs ~0.76 ms (1.9x).
- Full pipeline (match + diff stats): native `applyEdit` ~1.9-2.2 ms vs TS `replace` + `diffLines`
  ~2.0-2.6 ms. The diff pass dominates (`similar` is about the same as jsdiff).
- Pathologic block-anchor with 1800-char lines: native ~10 ms vs TS ~21-30 ms (~2-3x).
- `apply_patch` `deriveNewContents` on a 20k-line file: exact native ~1.3 ms vs TS ~1.7 ms (1.3x);
  trim pass ~1.8 ms vs ~3.5 ms (2.0x); unicode-normalize pass ~5.2 ms vs ~13 ms (2.5x).

Git (repo with 2200 files, 400 changes):

- native `gitStatus` in-process ~5.6 ms
- `git diff-files --name-only` + `git ls-files --others --exclude-standard` (what the snapshot
  module does today, two subprocesses) ~13.5 ms
- `git status --porcelain` (one subprocess) ~8.1 ms

So `gix` is ~2.4x faster than the two-subprocess snapshot approach and ~1.4x faster than
`git status`, before accounting for not spawning a process at all.

Sandbox (`macOS 26.5`, `sandbox-exec`):

- write inside `--workdir` works; write outside it is denied ("Operation not permitted")
- network denied by default (`curl` fails to resolve); `--allow-network` returns HTTP 200
- a normal command (`git status`) still runs correctly under the sandbox

## Optimization notes

The first version of the edit port was **slower** than TS on the typical case. The cause was not the
language, and not the NAPI boundary (an `echo` of a 597 KB string costs ~0.08 ms):

- `str::find`/`str::rfind` (std two-way) were slower than the JS engines' SIMD `indexOf`
  (0.38 ms / 0.45 ms vs ~0.05 ms for memchr).
- `slice_span` rebuilt the whole file with `lines.join("\n")` just to slice one small block.

Fixes: `memchr::memmem` for substring search, a forward uniqueness check from `index + 1` instead
of `rfind`, and slicing the original content directly. `deriveNewContents` got the same treatment:
its original lines are kept as `&str` (no per-line `String` allocation), replacements are pushed
straight into the output, the unified diff buffer is preallocated, and there is no per-line
`format!` temporary. After this, every measured case is faster in Rust than in TS.

## Status

The V2 edit tool uses the `matchEdit` contract through `packages/core/src/tool/edit-match.ts` when the
addon exposes it, and falls back to the TypeScript reference otherwise. The V2 apply_patch path uses
`deriveNewContentsV2` through `packages/core/src/patch.ts` with the same fallback; the legacy
`deriveNewContents` stays wired through `packages/miao/src/patch`. The sandbox runner is wired into
the V2 `bash` tool through `@miao/core/sandbox`. In-process `gitStatus` remains a prototype; the
default Git path is still subprocess-based.
