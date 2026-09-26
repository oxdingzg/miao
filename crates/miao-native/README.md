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
applyEdit(content, oldString, newString, replaceAll?) -> { content, additions, deletions }
diffStats(before, after) -> { additions, deletions }
unifiedPatch(before, after, filePath) -> string
```

`applyEdit` throws the same error messages as the TS `replace()`.

## PoC results (measured, same machine, release)

- Parity: 12 Rust unit tests + 18 JS parity tests (including a 400-case fuzz corpus and
  exact string match for `unifiedPatch` against jsdiff) all pass.
- Diff stats and unified patch are byte-identical to jsdiff for the sampled cases.
- Timing:
  - typical edit on a 12k-line file: parity (TS `replace` + `diffLines` ~2.9 ms vs native `applyEdit` ~2.8 ms)
  - fuzzy indent on a 12k-line file: native slightly slower (~4.0 ms vs ~3.0 ms), dominated by the stats pass
  - pathologic block-anchor with 1800-char lines: native ~10.6 ms vs TS ~30 ms (~2.8x)

Conclusion: the port is behaviourally correct; the gain is on pathologic inputs, not on the
typical case. The next decision should be driven by a memory measurement, not by latency.

## Status

Not wired into production. `packages/miao/src/tool/edit.ts` still uses the TS implementation
and jsdiff.
