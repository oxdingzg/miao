# 2026-10-23 engine cost batch (full-dimension rerun of the 10-22 batch)

`engine-cost-benchmark.md` (2026-10-22) committed only its report table — no turns, no uncached/cached/output split, no per-run evidence, and the entire deepseek rust arm was N/A. This round re-runs the same batch (seven task families × two priced models × both engines × best-of-2) with the evidence-writing harness (the `--data` flag landed as #1278) and commits `results.csv` plus `raw/` per the directory convention, filling every dimension the cross-round summary needs.

## Findings

1. **`opencode-go/deepseek-v4.1-flash` is now natively routable**: the 10-22 rust arm was N/A; here rust passes 14/14 (later fixes closed the G5 deepseek routing gap).
2. **Gates**: TS 28/28; RS 27/28. The single failure is `glm/recovery/rust#2` (resume after SIGKILL): `quote()` double-escapes and `parseRecord` drops a field — the same signature as the mimo round's rust recovery failure, reproduced across models, pointing at a systematic native resume issue; evidence retained in this directory.
3. **Cost**: rust still reports $0.0000 (native-placement `miao run` does not pass the price index to the engine — the follow-up remains open). At `prices.json` rates: glm rust **$0.1913 ≈ 2.66× TS**, deepseek rust **$0.2762 ≈ 5.64× TS**. Driver is again prefix-cache misses: rust carries 1.20–1.69M uncached input vs TS 0.25–0.26M (similar cache reads), plus 3.6–4.8× output (same direction as the mimo round).
4. **Wall clock**: rust +67% (glm, 1088s vs 652s) and +68% (deepseek, 509s vs 302s).

## Totals (all 14 runs per engine/model)

| model               | engine | gates | turns | uncached in | cached read | output | engine cost | computed cost | wall (s) | p50/p95 (s)  |
| ------------------- | ------ | ----- | ----- | ----------- | ----------- | ------ | ----------- | ------------- | -------- | ------------ |
| glm-5.3-flash       | TS     | 14/14 | 88    | 260,656     | 1,022,080   | 5,570  | 0.0721      | 0.0686        | 652      | 43.5 / 71.3  |
| glm-5.3-flash       | RS     | 13/14 | 97    | 1,204,124   | 1,050,112   | 26,919 | 0.0000 ¹    | 0.1913        | 1,088    | 88.6 / 120.1 |
| deepseek-v4.1-flash | TS     | 14/14 | 83    | 249,088     | 987,904     | 7,761  | 0.0486      | 0.0450        | 302      | 20.7 / 32.9  |
| deepseek-v4.1-flash | RS     | 14/14 | 129   | 1,693,316   | 1,411,456   | 29,993 | 0.0000 ¹    | 0.2762        | 509      | 40.1 / 53.4  |

1. Native-placement pricing is unwired; per-task and per-attempt detail lives in `results.csv` and `raw/`.

## Method and reproduction

- revision: `188fa4ab5381154bc71ccc90676ee414a3611bba` (both arms on the same tree; TS is a source wrapper for it, RS is the release build of `crates/miao-engine` from it — binary sha256 in `manifest.json`).
- Command (keys as `<env>`):

```
MIAO_ENGINE_BIN=<engine binary> bun script/engine-benchmark.ts \
  --binary <ts-source-wrapper> \
  --models zhipuai-coding-plan/glm-5.3-flash,opencode-go/deepseek-v4.1-flash \
  --engines ts,rust --repeat 2 --out <report.md> \
  --data docs/experiments/2026-10-23-engine-cost-batch
```

- Prices: `prices.json` (glm = overlay #1251 reference rates; deepseek = mtty.dev catalog). TS engine-reported cost matches the computed rates (± rounding).

## Evidence boundary

- `raw/<model>/<engine>/samples.json` and `evidence/*.json` are the harness's structured per-attempt records (including gate-failure reasons); they do NOT contain full `miao run` event journals (only the suite-v6 rounds keep those). `tools/compare.py` targets suite-v6 evidence; this directory recomputes from `samples.json`/`results.csv`.
- n=2: the harness's p50/p95 resolve to the same (worse) attempt — directional only.
- Same task set, models, and basis as the [10-22 cost batch](../../engine-cost-benchmark.md); use this directory for cross-round comparison, and keep the 10-22 rows as history.
