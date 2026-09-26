# miao-native (PoC)

Rust port of the pure edit-matching pipeline in `packages/miao/src/tool/edit.ts`,
plus diff statistics and unified patch generation. This is a proof of concept for
the plan in `docs/rust-rewrite-feasibility.en.md` / `.zh.md`.

Scope: pure functions only. No file IO, no Effect, no session state.

## Layout

- `src/lib.rs`: port of the nine replacers and `replace()`, `diffStats`, `unifiedPatch`, and Rust unit tests.
- `build.ts`: builds the cdylib with cargo and copies it to `miao-native.node`.
- `../../packages/miao/test/tool/edit-native.test.ts`: parity tests against the real TS `replace()` and jsdiff.

## Build

```sh
bun run build.ts            # cargo build --release + copy artifact to miao-native.node
```

## Test

```sh
cargo test --release        # Rust unit tests (behaviour from packages/miao/test/tool/edit.test.ts)
bun test test/tool/edit-native.test.ts   # from packages/miao/, parity vs the TS implementation
```

The parity test skips itself when `miao-native.node` has not been built, so it does not
break the normal `packages/miao` suite.

## API

```ts
replaceOnly(content, oldString, newString, replaceAll?) -> string
applyEdit(content, oldString, newString, replaceAll?) -> { content, additions, deletions }
diffStats(before, after) -> { additions, deletions }
unifiedPatch(before, after, filePath) -> string
deriveNewContents(chunks, filePath, originalText) -> { content, unifiedDiff, bom }
```

`replaceOnly` throws the same error messages as the TS `replace()`; `applyEdit` is `replaceOnly`
plus diff statistics. `deriveNewContents` ports `deriveNewContentsFromChunks` from
`packages/miao/src/patch/index.ts` (the `apply_patch` chunk-application pass).

## PoC results (measured, same machine, release)

- Parity: 12 Rust unit tests + 18 JS parity tests (including a 400-case fuzz corpus and
  byte-identical `unifiedPatch` against jsdiff) all pass.
- Matching only, 12k-line file:
  - exact: native `replaceOnly` ~0.16 ms vs TS `replace` ~0.23 ms (1.4x)
  - fuzzy indent: native `replaceOnly` ~0.41 ms vs TS `replace` ~0.82 ms (2.0x)
- Full pipeline (match + diff stats): native `applyEdit` ~1.9-2.2 ms vs TS `replace` + `diffLines`
  ~2.0-2.6 ms. The diff pass dominates (`similar` is about the same as jsdiff).
- Pathologic block-anchor with 1800-char lines: native ~10 ms vs TS ~21-30 ms (~2-3x).
- `apply_patch` `deriveNewContents` on a 20k-line file (match near the end, so the 4-pass seek runs):
  - exact: parity (~1.8 ms each)
  - trim pass: native ~2.3 ms vs TS ~3.6 ms (1.6x)
  - unicode-normalize pass: native ~5.7 ms vs TS ~13.5 ms (2.4x)

The first version of the port was **slower** than TS on the typical case. The cause was not the
language, and not the NAPI boundary (an `echo` of a 597 KB string costs ~0.08 ms):

- `str::find`/`str::rfind` (std two-way) were slower than the JS engines' SIMD `indexOf`
  (0.38 ms / 0.45 ms vs ~0.05 ms for memchr).
- `slice_span` rebuilt the whole file with `lines.join("\n")` just to slice one small block.

Fixes: `memchr::memmem` for substring search, a forward uniqueness check from `index + 1` instead
of `rfind`, and slicing the original content directly. Matching is now faster than TS on every case
measured.

## Status

Not wired into production. `packages/miao/src/tool/edit.ts` still uses the TS implementation
and jsdiff.
