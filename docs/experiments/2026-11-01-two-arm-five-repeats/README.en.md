# Two-arm real-model comparison at five repeats per cell

This record **supersedes the aggregate** in
[`2026-11-01-two-arm-real-model`](../2026-11-01-two-arm-real-model/README.en.md).
That run used two repeats per cell and reported a native advantage; with five
repeats the direction reverses. The earlier aggregate must not be cited.

## Provenance

- Binary source: the worktree at `adaec24a10` — `main` plus the already-merged
  SEC-01 corpus change, which touches tests only.
- Native engine: `miao-engine` built at `58118fc1dc` on the project's macOS build
  host, selected through `MIAO_ENGINE_BIN`; it reports `protocol 2`,
  `routes_schema 2`, `0.3.23`.
- Model: catalog `deepseek/deepseek-flash`, both arms.
- Harness: `script/engine-benchmark.ts`, unchanged.
- Repeats: **5 per task per engine — 70 attempts**.
- Billing: `billed-in = input + cacheRead`; cost is provider-reported.

Launcher note, because it decides whether a run means anything: the harness
gives each cell its own workspace, so the binary must not change directory. Two
earlier attempts were discarded — one passed `--tui legacy` to `run`, the other
`cd`-ed in its wrapper — and both produced globally failing cells with zero
valid measurement. A 14-cell single-repeat run was verified green before this
one started.

## Results

**70/70 attempts passed their verification gates. No failed and no over-budget
sample exists to report.**

| Task | TS billed-in p50 | Rust p50 | TS $ p50 | Rust $ p50 | TS s p50 | Rust s p50 |
| --- | --- | --- | --- | --- | --- | --- |
| bugfix | 170,189 | 183,848 | $0.0008 | $0.0009 | 13 | 13 |
| feature | 180,775 | 250,189 | $0.0012 | $0.0014 | 16 | 18 |
| refactor | 216,983 | 252,273 | $0.0013 | $0.0015 | 17 | 17 |
| multifile | 217,900 | 220,479 | $0.0017 | $0.0016 | 16 | 17 |
| recovery | 221,029 | 268,374 | $0.0016 | $0.0027 | 28 | 37 |
| long-session | 341,031 | 316,083 | $0.0018 | $0.0018 | 36 | 30 |
| impossible | 121,655 | 155,813 | $0.0012 | $0.0015 | 21 | 22 |
| **sum of p50** | **1,469,562** | **1,647,059** | **$0.0096** | **$0.0114** | **147** | **154** |

Aggregate for this run:

- billed-in: `1,647,059 / 1,469,562 = 1.121` — the native arm read **12.1% more**.
- reported cost: `$0.0114 / $0.0096 = 1.188` — **18.8% higher**.
- wall clock: `154 / 147 = 1.048` — **4.8% slower**.

Quality again did not differ: `7/7` tasks passed in each arm, including
`impossible`.

## Why this contradicts the earlier record

The two-repeat run summed to `$0.0165` (TS) against `$0.0142` (Rust); this run
sums to `$0.0096` against `$0.0114`. The per-task direction is unstable at small
samples — `refactor` favours the native arm here and favoured TypeScript before;
`recovery` was the largest native advantage before and is the largest native
regression now. With two samples the median is effectively one of two values,
which is why the earlier document said p50 equals p95 in every row and called
itself directional.

What survives: per-task cost and token counts are reproducible within a task, and
the two arms are within roughly ±20% of each other on every axis at this task
set. What does not survive: any claim that one engine is cheaper or faster
overall.

## Limits

- Five repeats still do not give a confident aggregate; treat the ±20% band as
  the finding, not the sign of the ratio.
- One model, one machine, seven short tasks. No subagent work, no compaction past
  a trigger point, no human intervention, no input-latency or startup figures.
