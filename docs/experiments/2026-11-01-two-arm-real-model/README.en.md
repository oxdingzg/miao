# Two-arm real-model comparison: TypeScript against the native engine

## Scope and provenance

- Baseline: `58118fc1dc` on `main`. Both arms ran from that commit.
- Native arm: `miao-engine` built at that same commit on the project's macOS
  build host (`cargo build --release --bin miao-engine`), selected through
  `MIAO_ENGINE_BIN`. It reports `protocol 2`, `routes_schema 2`, version
  `0.3.23`, which is what the host requires, so a stale artifact cannot pass as
  the baseline engine.
- TypeScript arm: `miao-dev` from the same tree, with no native placement.
- Harness: `script/engine-benchmark.ts`, unchanged. Each cell gets a fresh
  workspace and runs `miao run --format json`; cost and tokens come from the
  streamed events.
- Model: catalog-backed `deepseek/deepseek-flash`, the same model in both arms.
- Repeats: 2 per task per engine — 28 attempts in total.
- Billing: `billed-in = input + cacheRead`; cost is what the provider reported.

## Results

All 28 attempts passed their verification gates. No failed and no over-budget
sample exists to report, because none occurred.

| Task | TS billed-in | Rust billed-in | Δ | TS $ | Rust $ | TS s | Rust s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bugfix | 200,509 | 184,675 | −8% | $0.0026 | $0.0026 | 40 | 19 |
| feature | 315,811 | 315,309 | 0% | $0.0018 | $0.0024 | 24 | 27 |
| refactor | 250,484 | 289,913 | +16% | $0.0015 | $0.0016 | 25 | 22 |
| multifile | 255,993 | 223,636 | −13% | $0.0021 | $0.0020 | 24 | 22 |
| recovery | 405,874 | 293,413 | −28% | $0.0043 | $0.0022 | 47 | 36 |
| long-session | 407,565 | 344,305 | −16% | $0.0022 | $0.0018 | 46 | 39 |
| impossible | 222,097 | 123,641 | −44% | $0.0020 | $0.0016 | 28 | 24 |
| **sum of p50** | **2,058,333** | **1,774,892** | **−13.8%** | **$0.0165** | **$0.0142** | **234** | **189** |

- Aggregate billed-in: `1,774,892 / 2,058,333 = 0.862`, so the native arm read
  **13.8% fewer billed tokens**.
- Aggregate reported cost: `$0.0142 / $0.0165 = 0.861`, **13.9% lower**.
- Aggregate wall clock from submit to verified completion: `189 / 234 = 0.808`,
  **19.2% faster**.
- Quality was equal, not traded away: `7/7` tasks passed in each arm, including
  the `impossible` task where the only pass condition is refusing to fake the
  outcome.

Cost of the whole run: about **`$0.06`** of reported provider spend for 28
attempts.

## What this record does and does not support

Supports: a same-baseline, same-model, same-task-set comparison of the two
engines on cost, billed tokens and wall clock, with every attempt's gate result
reported.

Does not support:

- **Statistical confidence.** Two repeats per cell is directional; p50 equals p95
  in every row for that reason. The per-task spread (refactor is `+16%` while
  recovery is `−28%`) is larger than any aggregate claim deserves at this sample
  size.
- **A general speed claim.** These are seven short tasks on one machine with one
  model. Long-running sessions, large repositories and tool-heavy work are not
  represented.
- **Input-echo latency or startup time (PERF-01, PERF-03)**, which need their own
  harnesses, and **compaction past a trigger point (CTX-02)**: the nine-turn
  `long-session` fixture never crosses one.
- **Human-intervention accounting** (VAL-02): none occurred by construction and
  the harness does not record it.
