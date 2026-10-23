# 2026-10-23 G5 official rerun (cost-batch official rerun)

Owner-authorized G5 official rerun: seven task families × `zhipuai-coding-plan/glm-5.3-flash` + `opencode-go/deepseek-v4.1-flash` × both engines × best-of-2 (56 runs), baseline `ed524903ae` (includes #1251/#1264/#1283/#1284). This directory supersedes the 2026-10-22 report table as the official G5 cost data; method and evidence boundary match [2026-10-23-engine-cost-batch](../2026-10-23-engine-cost-batch/README.en.md).

## Totals (all 14 runs per engine/model)

| model               | engine | gates | turns | uncached in | cached read | output | engine cost | computed cost | wall (s) | p50/p95 (s)  |
| ------------------- | ------ | ----- | ----- | ----------- | ----------- | ------ | ----------- | ------------- | -------- | ------------ |
| glm-5.3-flash       | TS     | 14/14 | 87    | 280,017     | 1,028,096   | 5,837  | 0.0792      | 0.0712        | 754      | 37.7 / 172.9 |
| glm-5.3-flash       | RS     | 14/14 | 107   | 1,361,668   | 1,263,296   | 42,482 | 0.0000 ¹    | 0.2239        | 1,354    | 82.0 / 201.3 |
| deepseek-v4.1-flash | TS     | 14/14 | 82    | 221,475     | 1,014,400   | 8,037  | 0.0458      | 0.0411        | 336      | 21.6 / 45.6  |
| deepseek-v4.1-flash | RS     | 14/14 | 124   | 1,658,010   | 1,570,432   | 32,134 | 0.0000 ¹    | 0.2727        | 527      | 37.9 / 58.9  |

1. Native-placement pricing is unwired (issue #1285).

## Findings

1. **Gates 56/56**: both models, both engines, including recovery/long-session; deepseek rust is 14/14 for the second consecutive round — the G5 deepseek routing gap is officially closed.
2. **Cost ratios match the same-day rerun**: computed RS = **2.83× (glm)** and **5.96× (deepseek)** of TS; the uncached-input gap persists (RS 97–118k/run vs TS 16–20k/run) even though #1283's cross-session byte stability is verified — the dominant factor points to **within-run cache expiry and longer step gaps (RS output 4–5.5×, turns +23–51%)**, not request-key divergence; per-request cache-read telemetry (response-side dump) is the next diagnostic step.
3. **Wall clock**: RS +80% (glm) / +57% (deepseek).
4. Directionally identical to the [10-23 cost batch](../2026-10-23-engine-cost-batch/README.en.md) and its [post-1283 verification](../2026-10-23-engine-cost-batch/post-1283-verification/); the three rounds can be referenced together.
