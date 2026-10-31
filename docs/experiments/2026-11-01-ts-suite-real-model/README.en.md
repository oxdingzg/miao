# Real-model TypeScript suite: cost and time per completed task

## Scope and provenance

- Product: `miao-dev`, run from source in the working tree. The checkout advanced
  during the run between branch heads `8b3854080b`, `3a08e281cb` and
  `b6323b36af`; the only differences between them are one line of config
  diagnostics and one specification document, so no session-execution code
  differed between cells. Their common base is `origin/main` at `58118fc1dc`.
  A re-run from a single pinned checkout is the rigorous form of this record.
- Harness: `script/engine-benchmark.ts` (unchanged across the whole run). Each
  cell gets a fresh workspace, runs `miao run --format json`, and reads cost and
  token counts from the streamed events, never from a database.
- Model: catalog-backed `deepseek/deepseek-flash`, the only model used.
- Tasks: the seven committed fixtures the harness carries — `bugfix`,
  `feature`, `refactor`, `multifile`, `recovery` (mid-run interrupt + resume),
  `long-session` (multi-turn), and `impossible` (a contradictory request whose
  correct outcome is a refusal).
- Repeats: 2 per task per engine, so 14 attempts in total.
- Billing: `billed-in = input + cacheRead`, because provider cache hits make raw
  `input` incomparable; the reported cost is what the provider reported.

## Results

Every attempt passed its verification gate. No attempt failed and none exceeded
its budget, so the report carries no failed or over-budget samples to show.

| Task | TypeScript billed-in p50 | $ p50 | s p50 | passed |
| --- | --- | --- | --- | --- |
| bugfix | 239,235 | $0.0026 | 32 | 2/2 |
| feature | 282,868 | $0.0018 | 31 | 2/2 |
| refactor | 244,261 | $0.0013 | 31 | 2/2 |
| multifile | 218,822 | $0.0018 | 87 | 2/2 |
| recovery | 182,143 | $0.0013 | 44 | 2/2 |
| long-session | 341,531 | $0.0019 | 49 | 2/2 |
| impossible | 181,966 | $0.0017 | 26 | 2/2 |

Aggregate for this run: 14/14 verified tasks, about **$0.025** of reported
provider cost in total, and the distribution above. Per-task wall clock is the
harness's submit-to-verified-completion time; it excludes human intervention,
which this run had none of by construction.

Raw output: [`raw/deepseek-deepseek-flash.md`](raw/deepseek-deepseek-flash.md).

## What this record does and does not support

Supports:

- A frozen task set, model, verifier and repeat count for a real-model run
  (VAL-01's first two boxes), with the cost and wall-clock figures VAL-02 asks
  for on a per-completed-task basis and the cache-dimension split COST-01 asks
  for.

Does not support, and must not be read as:

- **Any Rust-versus-TypeScript comparison.** Only the TypeScript arm ran. The
  native arm needs a freshly built engine binary; the only engine artifact on the
  machine predates the baseline, so running it would have produced a misleading
  comparison.
- **Statistical confidence.** Two repeats per task is directional. p50 equals p95
  for every row because there are only two samples.
- **Input-echo latency (PERF-01) or startup time (PERF-03).** Those are separate
  measurements with their own harnesses; this run measures model turns only.
- **Compaction on a long task past the trigger point (CTX-02).** The
  `long-session` fixture is nine turns; it does not cross a compaction trigger.
- **Human-intervention accounting**, which VAL-02 also asks for.
