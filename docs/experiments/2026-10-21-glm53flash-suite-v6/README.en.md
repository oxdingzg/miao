# glm-5.3-flash: TypeScript vs native engine (suite v6, 2026-10-21)

Fifth engine-comparison round, this time on `zhipuai-coding-plan/glm-5.3-flash`
(Zhipu Coding Plan gateway `open.bigmodel.cn/api/coding/paas/v4`,
OpenAI-compatible chat completions). The frozen suite v6 ran unchanged: 15 task
classes × 3 repetitions × both arms = 90 real model runs, both arms on the same
main commit.

## Conclusions

- **Pass rate: Rust 42/45, TypeScript 38/45.** All 3 Rust failures are
  `stream-interruption`: the broken-stream proxy gets HTTP 421 from the
  bigmodel gateway ("Direct IP access is not allowed") — the proxy targets the
  subscription Responses/SSE route and is not comparable over an openai-chat
  gateway (same convention as v6 round 3). Of the TypeScript failures, 3 are
  the same `stream-interruption` (harness SIGINT, counted as failed), 3 are
  `permission-denial` (the model did not satisfy the closing assertions after
  the denial; raw evidence retained), and 1 is `large-file`.
- **Cost (catalog list-price reference): Rust is 0.55× of TypeScript**
  ($0.08442 vs $0.15453; 0.45× excluding long-session). The output/input rate
  ratio is 3.33× and break-even sits at 19.81.
- **Speed: the native arm is slower on both percentiles** (30.7s vs 22.3s p50;
  207.0s vs 96.8s p95) — the native arm emits 2.2× the output tokens
  (51,915 vs 23,547); glm-5.3-flash answers noticeably longer under the
  engine's system prompt, and a few long generations pull p95 up. Output is
  only 20.9% of the native arm's cost, offset by much lower billed input.
- The coding plan includes the model at cost 0; amounts here use the reference
  list price ($0.15/M input, $0.50/M output, $0.03/M cache read). Both arms
  share the rates, so ratios are unaffected.

## Summary

| Engine | Passed | Turns | Billed input | Cached input | Hit rate | Output | Cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | 38/45 | 245 (5.44/run) | 300,761 | 3,254,848 | 91.5% | 23,547 | $0.15453 | 22.3 s | 96.8 s |
| Rust | 42/45 | 265 (5.89/run) | 100,730 | 1,445,120 | 93.5% | 51,915 | $0.08442 | 30.7 s | 207.0 s |

Rust/TypeScript cost ratio: **0.546**; break-even output/input rate ratio:
**19.81** (output rate currently 3.33× input).

## Per class

| Class | TS cost | Rust cost | Rust/TS |
| --- | --- | --- | --- |
| create-module | $0.00926 | $0.00470 | 0.508 |
| docs-sync | $0.01355 | $0.00537 | 0.396 |
| large-file | $0.01356 | $0.00680 | 0.501 |
| long-session | $0.02881 | $0.02819 | 0.978 |
| multi-file | $0.00830 | $0.00482 | 0.581 |
| multi-line-edit | $0.00965 | $0.00344 | 0.356 |
| multi-read | $0.00354 | $0.00123 | 0.347 |
| permission-denial | $0.00625 | $0.00458 | 0.733 |
| read-only | $0.00450 | $0.00226 | 0.502 |
| rename-symbol | $0.01233 | $0.00570 | 0.462 |
| small-edit | $0.00824 | $0.00394 | 0.478 |
| stream-interruption | $0.00315 | $0.00075 | 0.238 |
| test-repair | $0.00984 | $0.00620 | 0.63 |
| tool-error | $0.00807 | $0.00182 | 0.226 |
| typed-repair | $0.01547 | $0.00462 | 0.299 |

Excluding `long-session`: TS $0.12572, Rust $0.05623, ratio 0.447.

## Run configuration

| | TypeScript arm | Rust arm |
| --- | --- | --- |
| Model | `zhipuai-coding-plan/glm-5.3-flash` (product openai-compatible route) | `glm-5.3-flash` |
| Protocol | openai-compatible (built in) | `--provider openai-chat` |
| Endpoint | `https://open.bigmodel.cn/api/coding/paas/v4` (product catalog) | `--endpoint https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` |
| Credentials | read-only runtime credential snapshot (integration `zhipuai-coding-plan`, key) | `--env-file` (`OPENAI_API_KEY`, same key, static injection) |
| Runtime | main @ `fa6bac5cce` from source (bun) | miao-engine 0.2.20, sha256 `558e1b76…` |
| Window | 2026-10-21 07:57–08:24 | 2026-10-21 08:25–08:59 |

- Suite hash `bd905b4f…` is identical to v6; every run gets an isolated data
  directory and workspace fixture; judging is the same as v6.
- Commit alignment matches round 4 (see `2026-10-21-openai-sol-suite-v6`):
  the engine binary is the 0.2.20 release artifact, one docs-only commit away
  from the TypeScript side's main.
- Smoke: before the full suite each arm ran `read-only` once to verify the
  gateway (the plan authorizes `glm-5.3-flash`; tool calls and cache usage
  metering both work).

## Failure detail

- Rust `stream-interruption` ×3: the proxy's forwarded request gets HTTP 421.
  The task's proxy only speaks the subscription Responses/SSE break-stream
  protocol; over an openai-chat gateway neither arm is comparable (TS is
  SIGINTed, Rust gets 421) — recorded under the v6 "not comparable"
  convention, not as a native capability gap.
- TS `permission-denial` ×3 and `large-file` ×1: completed runs judged failed;
  raw evidence (attempts, receipts, blackbox) is retained per run under
  `raw/typescript/evidence/`. The Rust arm passed permission-denial 3/3 and
  large-file 3/3. Recorded as a model behavior difference, not a harness
  defect.

## Relation to previous rounds

| Round | Directory | Model / route | Result |
| --- | --- | --- | --- |
| 1–2 | `2026-10-19-native-engine-suite-v6` | deepseek direct (openai-chat) | native cheaper, equal quality |
| 3 | `2026-10-19-opencode-go-suite-v6` | gateway deepseek (openai-chat + route) | native 31% cheaper (54% ex long-session) |
| 4 | `2026-10-21-openai-sol-suite-v6` | subscription gpt-6.1-sol (subscription-responses) | native 41% cheaper, p95 30% faster, 45/45 |
| 5 (this) | this directory | Zhipu Coding Plan glm-5.3-flash (openai-chat) | native 45% cheaper (55% ex long-session); slower p95, longer outputs |

## Reproduce

```sh
cd packages/miao
# TypeScript arm (3 chunks; task groups in manifest.json commands)
bun run src/engine/baseline-sweep-cli.ts --engine typescript --out <out> --tasks <T1> \
  --repetitions 3 --pause-ms 500 --model zhipuai-coding-plan/glm-5.3-flash \
  --entry packages/miao/src/index.ts --credential-db <cred.db> \
  --revision fa6bac5cce43b6110bee5d96ce3657d8567c3a3f
# Rust arm
bun run src/engine/baseline-sweep-cli.ts --engine rust --out <out> --tasks <T1> \
  --repetitions 3 --pause-ms 500 --model glm-5.3-flash --binary <miao-engine> \
  --provider openai-chat \
  --endpoint https://open.bigmodel.cn/api/coding/paas/v4/chat/completions \
  --env-file <env.json> \
  --revision fa6bac5cce43b6110bee5d96ce3657d8567c3a3f
python3 ../docs/experiments/tools/collect.py  # see manifest.json
python3 ../docs/experiments/tools/compare.py --typescript <dir>/raw/typescript \
  --rust <dir>/raw/rust --prices <dir>/prices.json --exclude long-session \
  --csv <dir>/results.csv --markdown <dir>/results.md
```

`<cred.db>` is a minimal read-only snapshot of the runtime credential store
(only the `credential` integration rows); `<env.json>` is
`{"OPENAI_API_KEY": …}`. Neither is committed.
