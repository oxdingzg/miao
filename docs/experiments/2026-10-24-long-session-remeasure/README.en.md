# Long-session remeasurement on released 0.2.26

## Scope and provenance

- Product: published miao 0.2.26 and its published darwin-arm64 engine.
- Harness: `script/engine-benchmark.ts` at `f1d07b3c8b` (#1315), fixing inherited
  `PWD` so both arms resolve each generated task workspace correctly.
- Model: catalog-backed `deepseek/deepseek-v4-flash`, same model in both arms.
- Task: the committed three-prompt `long-session` fixture (read mean, add
  population stddev, add tests); three independent attempts per arm.
- Isolated data/config/storage; only the needed API credential is present.
  No OAuth credential or production Session database is copied or changed.

## Results

| Arm | Quality gate | Sum of product-reported cost | p50 elapsed | p95 elapsed |
| --- | --- | --- | --- | --- |
| TypeScript | 3/3 | $0.00995 | 25,444 ms | 29,577 ms |
| Native | 3/3 | $0.00708 | 30,989 ms | 31,134 ms |

For these six passing attempts, the ratio of aggregate reported native cost
to TS cost is `0.00708 / 0.00995 = 0.7116`. This remeasures the previously
reported long-session regression on a working, catalog-priced route. It does
not retroactively reprice the old 1.27× batch or establish a universal ratio
across models, tool sets, platforms, cache states, or harness versions.

All costs are the product's reference-price accounting, not a provider invoice.
Cache reads differ between the arms, so this is not a controlled cold-cache
experiment. Raw token splits are retained; do not infer billing savings from
raw input counts alone. Three attempts per arm are an acceptance sample, not
a statistically powered performance claim. Individual costs are rounded in
samples.json; aggregate CSV totals are rounded after summation.

## Evidence

`results.csv`, both `raw/*/{ts,rust}/samples.json` files, and per-attempt
numeric evidence are copied directly from the completed fixed-harness run.
Every attempt has `outcome: pass` and a nonzero cost. No credential values,
provider request bodies, or private machine configuration are included.

The preceding batch is invalid and excluded: all six quality gates reported
zero tests because stale inherited `PWD` made the CLI edit the parent checkout
while the verifier inspected a different temporary directory. #1315 includes
a process-level regression, a passing fix, and a failing baseline control.
That failure was an environment-isolation bug, not evidence of model quality
or engine performance.

## Reproduction

Run from a checkout containing #1315, using an isolated, authenticated API-only
configuration and the published product/engine binaries:

```sh
MIAO_ENGINE_BIN=/path/to/miao-engine \
  bun script/engine-benchmark.ts \
  --binary /path/to/miao --model deepseek/deepseek-v4-flash \
  --tasks long-session --engines ts,rust --repeat 3 \
  --storage /path/to/isolated/engine-storage \
  --data /path/to/results --out /path/to/report.md
```
