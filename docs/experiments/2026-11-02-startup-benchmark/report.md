# Startup benchmark

Harness: `script/startup-benchmark.ts`; every figure below is reproducible from it.
Artifact: `/private/tmp/miao-test-db03/crates/miao-cli/target/release/miao` reporting `miao 0.0.1`
Environment: Darwin 25.5.0 arm64 · Apple M4 · 2026-11-02T14:19:58.124Z
Samples: 10 per startup cell, one 5s serve window; medians shown, raw numbers in `/tmp/startup-evidence.json`.

| cell | wall ms | user ms | sys ms | peak RSS KB | failures |
|---|---|---|---|---|---|
| `--version (cold)` | 8 | 0 | 0 | 8384 | 0 |
| `--version (warm)` | 7 | 0 | 0 | 8592 | 0 |
| `db path (cold)` | 6 | 0 | 0 | 8544 | 0 |
| `db path (warm)` | 6 | 0 | 0 | 8752 | 0 |
| `session list (cold)` | 10 | 0 | 0 | 12896 | 0 |
| `session list (warm)` | 7 | 0 | 0 | 12400 | 0 |
| `models (cold)` | 5 | 0 | 0 | 8352 | 10 |
| `models (warm)` | 5 | 0 | 0 | 8576 | 10 |

## Serve window (5s)

RSS / tree RSS / FDs sampled every 500 ms:
- RSS min · median · max KB: 16096 · 16144 · 16144
- FDs min · median · max: 20 · 20 · 20
- processes in tree: 1 at the final sample

A single faster or cheaper run is not a completion claim; quality evidence lives with the engine cost benchmark.
