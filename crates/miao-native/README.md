# miao-native (PoC)

Rust PoC for the plan in `docs/rust-rewrite-feasibility.en.md` / `.zh.md`. It covers the pieces
that are pure computation (edit matching, patch application, diff), one subprocess-free capability
(git status via `gix`), and one platform capability JS cannot provide (a macOS seatbelt sandbox).

## Layout

- `src/lib.rs`: nine edit replacers, `replace()`, `diffStats`, `unifiedPatch`, `deriveNewContents`,
  `gitStatus`, and Rust unit tests.
- `src/bin/miao-run.rs`: `miao-run`, a macOS seatbelt sandbox wrapper.
- `build.ts`: builds the cdylib with cargo and copies it to `miao-native.node`.
- `../../packages/miao/test/tool/edit-native.test.ts`: parity tests against the TS implementations.

## Build

```sh
bun run build.ts            # cargo build --release + copy cdylib to miao-native.node
cargo build --release       # also builds target/release/miao-run (the sandbox bin)
```

## Test

```sh
cargo test --release        # 17 lib + 4 bin Rust unit tests
bun test test/tool/edit-native.test.ts   # from packages/miao/, parity vs the TS implementations
```

Both JS suites skip themselves when the artifact is missing, so they do not break the normal
`packages/miao` suite.

## API

```ts
replaceOnly(content, oldString, newString, replaceAll?) -> string
applyEdit(content, oldString, newString, replaceAll?) -> { content, additions, deletions }
diffStats(before, after) -> { additions, deletions }
unifiedPatch(before, after, filePath) -> string
deriveNewContents(chunks, filePath, originalText) -> { content, unifiedDiff, bom }
gitStatus(path) -> Array<{ path, status }>
```

`replaceOnly` throws the same error messages as the TS `replace()`; `applyEdit` is `replaceOnly`
plus diff statistics. `deriveNewContents` ports `deriveNewContentsFromChunks` from
`packages/miao/src/patch/index.ts`. `gitStatus` uses `gix` and returns worktree-vs-index changes
(`added` / `modified` / `deleted` / `renamed` / `copied`).

`miao-run`:

```sh
miao-run --workdir <dir> [--allow-path <dir>]... [--allow-network] [--compat] [--print-profile] -- <command> [args...]
```

- Strict mode (default): deny-by-default. Reads everywhere and process execution are allowed,
  writes are limited to the workdirs plus temp/dev, and network is denied unless `--allow-network`.
- `--allow-path <dir>` adds extra writable directories (tool caches, package managers, etc.) without
  opening up everything.
- `--compat`: compatibility-first. Allow default, then deny writes only to credential paths
  (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.docker/config.json`, `~/.config/gh`) and deny
  network unless `--allow-network`. Far fewer false denials, weaker isolation.
- `--print-profile` prints the generated seatbelt profile and exits; the command's stderr names the
  path a denial blocked, which is the fastest way to find what to allow next.
- On non-macOS it runs the command unsandboxed.

## PoC results (measured, same machine, release)

Edit / patch:

- Matching only, 12k-line file: exact native `replaceOnly` ~0.16 ms vs TS `replace` ~0.23 ms (1.4x);
  fuzzy indent ~0.41 ms vs ~0.82 ms (2.0x).
- Full pipeline (match + diff stats): native `applyEdit` ~1.9-2.2 ms vs TS `replace` + `diffLines`
  ~2.0-2.6 ms. The diff pass dominates (`similar` is about the same as jsdiff).
- Pathologic block-anchor with 1800-char lines: native ~10 ms vs TS ~21-30 ms (~2-3x).
- `apply_patch` `deriveNewContents` on a 20k-line file: exact at parity (~1.8 ms); trim pass
  native ~2.3 ms vs TS ~3.6 ms (1.6x); unicode-normalize pass ~5.7 ms vs ~13.5 ms (2.4x).

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
no `to_vec()` clone of the whole line vector and no per-line `format!` temporary.

## Status

Not wired into production. `packages/miao` still uses the TS implementations, subprocess `git`,
and rule-based permissions.
