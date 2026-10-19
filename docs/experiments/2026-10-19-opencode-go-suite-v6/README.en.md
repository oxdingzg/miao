# Native engine vs TypeScript: opencode-go / deepseek-v4.1-flash (2026-10-19)

[简体中文](README.zh.md)

A re-run of the previous round on the same `main` commit and the same frozen suite v6, with the gateway model `opencode-go/deepseek-v4.1-flash`. 45 live runs per arm.

- Repository revision: `fa001fbff8b188361bf5848cc31358bba7e7d7bb` (identical for both arms)
- Suite: v6, 15 classes, `suiteHash = bd905b4f81f0a9412b614631a36337723067574848c5f05b50ead1cf48675091`
- Model: `opencode-go/deepseek-v4.1-flash` (TypeScript through the `opencode-go/` provider, native through the `routes.json` `openai-chat` route)
- Engine binary: `miao-engine 0.2.16`, `binarySha256 = b2c1d67f465561ad7bed58ab28ebe03658b8042e16b0bb3f75a41d65329d14fd`
- Repetitions: 3 per class, 90 runs, sequential
- Billing: `prices.json` (catalog list prices), amounts computed with the product's own `SessionRunnerCost.ofTurn`

## Gateway requirements (needed to reproduce)

`opencode.ai/inference/go` is not a plain OpenAI-compatible endpoint:

1. every request must carry `x-opencode-session`; without it the gateway returns 400 `MissingSessionID`;
2. the client must not use a Python user agent (`miao/0.2.16` works); otherwise Cloudflare answers 403/1010;
3. the gateway routes per session, so the native arm has to select the route explicitly (`--model-routes-config` plus `--model-route`). Without it the request falls to the engine's default provider, which was observable as a `platform.openai.com` 401. This needs the driver change from #1133.

`routes.json` carries only the endpoint, headers, and a `${OPENCODE_API_KEY}` reference — no credential.

## Result

See [`results.md`](results.md) / [`results.csv`](results.csv).

| Engine     | Passed      | Turns         | Billed input | Cached input | Hit rate | Output | Cost         | p50    | p95    |
| ---------- | ----------- | ------------- | ------------ | ------------ | -------- | ------ | ------------ | ------ | ------ |
| TypeScript | 39/45 86.7% | 233 (5.18/r)  | 736,655      | 2,701,184    | 78.6%    | 23,948 | $0.13297     | 14.9 s | 61.1 s |
| Native     | 41/45 91.1% | 487 (10.82/r) | 214,460      | 3,032,064    | 93.4%    | 84,199 | **$0.09178** | 17.1 s | 67.2 s |

**Conclusion**: same direction as the previous round, with a wider gap. The native engine costs **31.0% less** (ratio 0.69) and passes slightly more runs (41/45 against 39/45), at a slightly slower p50/p95. Its input is cheaper (billed input 214k against 737k, hit rate 93.4% against 78.6%) and its output is more expensive (84k against 24k, at 10.8 turns per run against 5.2).

Per-class ratios (native/TS):

| Class             | Ratio | Class         | Ratio | Class               | Ratio    |
| ----------------- | ----- | ------------- | ----- | ------------------- | -------- |
| multi-read        | 0.09  | typed-repair  | 0.45  | multi-file          | 0.65     |
| tool-error        | 0.11  | rename-symbol | 0.45  | large-file          | 0.75     |
| read-only         | 0.16  | test-repair   | 0.38  | docs-sync           | **1.35** |
| permission-denial | 0.26  | create-module | 0.41  | long-session        | **2.19** |
| multi-line-edit   | 0.32  | small-edit    | 0.33  | stream-interruption | 0.63     |

13 classes are cheaper on the native engine; `long-session` (2.19×) and `docs-sync` (1.35×) are the exceptions — the latter is the first time in three rounds that a non-long-session class favors TypeScript. **Excluding `long-session`: TS $0.11518 against native $0.05286, so native is 54.1% cheaper.**

**Break-even**: on this observation the verdict flips once output is priced at least **8.56×** input (the model is at 4.0×).

## Behavioral differences

- `permission-denial`: TypeScript 0/3 (`tool.error` without `permission.denied`), native 3/3 (both receipts present).
- `stream-interruption`: 0/3 for both arms; not comparable on this route (the interruption proxy targets Responses/SSE, so TypeScript is SIGINTed while the native engine never sees `provider.interrupted`).
- One native `create-module` run failed with provider HTTP 400, `The reasoning_content in the thinking mode must be passed back to the API` — a thinking-model replay incompatibility seen once in 45 runs, not reproducible on demand.

## Relation to earlier rounds

| Round | Model                             | Ratio (native/TS) | Excluding long-session | Break-even |
| ----- | --------------------------------- | ----------------- | ---------------------- | ---------- |
| 1     | deepseek-v4-flash (direct)        | 0.881             | 0.408                  | 4.98×      |
| 2     | deepseek-v4-flash (direct)        | 0.785             | 0.435                  | 6.32×      |
| 3     | opencode-go / deepseek-v4.1-flash | 0.690             | 0.459                  | 8.56×      |

All three agree on direction: the native engine is cheaper overall and 54%–59% cheaper once the long-session class is excluded, while the exact magnitude follows the model and task mix. One round establishes a direction, not a magnitude.

## Evidence boundary

One model, n=3 per class, short programmatically gradable tasks, sequential runs on one machine, ~$0.22 for both arms. The gateway's thinking-model incompatibility may slightly understate the native arm (1/45). Not a product-level or cross-model claim.

## Reproduction

```sh
# <env.json> = {"OPENCODE_API_KEY": "<key>"}; routes.json is in this directory
cd packages/miao

bun run src/engine/baseline-sweep-cli.ts --engine typescript --out <out> \
  --tasks read-only,multi-read,small-edit,multi-file,test-repair --repetitions 3 --pause-ms 500 \
  --model opencode-go/deepseek-v4.1-flash --entry packages/miao/src/index.ts \
  --credential-db <data>/miao.db --revision <revision>

bun run src/engine/baseline-sweep-cli.ts --engine rust --out <out> \
  --tasks read-only,multi-read,small-edit,multi-file,test-repair --repetitions 3 --pause-ms 500 \
  --model deepseek-v4.1-flash --binary <miao-engine> --provider openai-chat \
  --model-routes-config <run>/routes.json --model-route opencode-go/deepseek-v4.1-flash \
  --env-file <env.json> --revision <revision>
```

The full three-chunk commands are in `manifest.json` under `commands`.
