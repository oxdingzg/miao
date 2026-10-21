# gpt-6.1-sol: TypeScript vs native engine (suite v6, 2026-10-21)

Fourth engine-comparison round, this time on the subscription model
`openai/gpt-6.1-sol` (Responses protocol, chatgpt.com backend). The frozen
suite v6 ran unchanged: 15 task classes × 3 repetitions × both arms = 90 real
model runs, both arms on the same main commit.

## Conclusions

- **Pass rate: Rust 45/45, TypeScript 39/45.** The 6 TypeScript failures:
  `stream-interruption` ×3 (the harness SIGINT, counted as failed per the v6
  convention) and `permission-denial` ×3 (the model did not satisfy the
  task's closing assertions after the denial; raw evidence retained). Rust
  passed `stream-interruption` 3/3 for the first time: the broken-stream proxy
  targets the subscription Responses route, while the v6 openai-chat routes
  were not comparable for either arm (0/3).
- **Cost (catalog list-price reference): Rust is 0.59× of TypeScript**
  ($0.86253 vs $1.46173). The output/input rate ratio is 5.0× and break-even
  sits at 83.35, i.e. at current rates the native engine has roughly 5× of
  headroom in billed input usage.
- **Speed: p50 effectively tied (18.5s vs 18.8s); native p95 is 30% faster
  (42.7s vs 60.6s).**
- Since #1166 the engine prices native steps at catalog rates. Amounts here
  are a list-price reference only — the subscription is not billed per token,
  and both arms use the same rates, so ratios are unaffected.

## Summary

| Engine | Passed | Turns | Billed input | Cached input | Hit rate | Output | Cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | 39/45 | 258 (5.73/run) | 550,712 | 2,182,656 | 79.9% | 14,204 | $1.46173 | 18.8 s | 60.6 s |
| Rust | 45/45 | 282 (6.27/run) | 300,947 | 803,584 | 72.8% | 18,028 | $0.86253 | 18.5 s | 42.7 s |

Rust/TypeScript cost ratio: **0.59**; break-even output/input rate ratio:
**83.35** (output rate currently 5.0× input).

## Per class

| Class | TS cost | Rust cost | Rust/TS |
| --- | --- | --- | --- |
| create-module | $0.05402 | $0.05331 | 0.987 |
| docs-sync | $0.12586 | $0.11853 | 0.942 |
| large-file | $0.10521 | $0.09583 | 0.911 |
| long-session | $0.20073 | $0.10493 | 0.523 |
| multi-file | $0.11838 | $0.06389 | 0.54 |
| multi-line-edit | $0.10180 | $0.03577 | 0.351 |
| multi-read | $0.06842 | $0.02546 | 0.372 |
| permission-denial | $0.04568 | $0.02811 | 0.615 |
| read-only | $0.10156 | $0.03696 | 0.364 |
| rename-symbol | $0.12523 | $0.06747 | 0.539 |
| small-edit | $0.11240 | $0.05874 | 0.523 |
| stream-interruption | $0.02200 | $0.03281 | 1.491 |
| test-repair | $0.09942 | $0.05828 | 0.586 |
| tool-error | $0.05617 | $0.02516 | 0.448 |
| typed-repair | $0.12484 | $0.05728 | 0.459 |

Excluding `long-session`: TS $1.26100, Rust $0.75761, ratio 0.601.

## Run configuration

| | TypeScript arm | Rust arm |
| --- | --- | --- |
| Model | `openai/gpt-6.1-sol` (product subscription route) | `gpt-6.1-sol` |
| Protocol | subscription-responses (built in) | `--provider subscription-responses` |
| Credentials | read-only runtime credential snapshot (integration `openai`, OAuth) | `--env-file` (`OPENAI_ACCESS_TOKEN`/`OPENAI_ACCOUNT_ID` from the same credential row, static injection) |
| Runtime | main @ `fa6bac5cce` from source (bun) | miao-engine 0.2.20, sha256 `558e1b76…` |
| Window | 2026-10-21 07:57–08:13 | 2026-10-21 08:15–08:29 |

- Suite hash `bd905b4f…` is identical to v6 (tasks, judging, and fixtures
  frozen).
- Commit alignment: the TypeScript side ran main @ `fa6bac5cce`; the engine
  binary is the release-CI 0.2.20 artifact (built from the v0.2.20 tag
  `d717e26ba9`; the only commit between them, #1176, touches `docs/` only).
- 500 ms pause between runs; every run gets an isolated data directory and
  workspace fixture; judging is the same `judge.ts` as v6.

## Failure detail (TypeScript arm)

- `stream-interruption` ×3: the harness SIGINTs the product process
  (exit 130) and the judge counts a failure. By design, consistent with v6;
  the Rust arm passed 3/3 on the same task via the broken-stream proxy
  (418 then truncated-stream continuation).
- `permission-denial` ×3: three completed runs judged failed — the model did
  not satisfy the task's closing assertions after the permission denial. Raw
  evidence (attempts/receipts/blackbox) is retained per run under
  `raw/typescript/evidence/`; the Rust arm passed 3/3. Recorded as a model
  behavior difference, not a harness defect.

## Relation to previous rounds

| Round | Directory | Model / route | Result |
| --- | --- | --- | --- |
| 1–2 | `2026-10-19-native-engine-suite-v6` | deepseek direct (openai-chat) | native cheaper, equal quality |
| 3 | `2026-10-19-opencode-go-suite-v6` | gateway deepseek (openai-chat + route) | native 31% cheaper (54% ex long-session) |
| 4 (this) | this directory | subscription gpt-6.1-sol (subscription-responses) | native 41% cheaper, p95 30% faster, 45/45 |

## Reproduce

```sh
cd packages/miao
# TypeScript arm (3 chunks; task groups in manifest.json commands)
bun run src/engine/baseline-sweep-cli.ts --engine typescript --out <out> --tasks <T1> \
  --repetitions 3 --pause-ms 500 --model openai/gpt-6.1-sol \
  --entry packages/miao/src/index.ts --credential-db <cred.db> \
  --revision fa6bac5cce43b6110bee5d96ce3657d8567c3a3f
# Rust arm
bun run src/engine/baseline-sweep-cli.ts --engine rust --out <out> --tasks <T1> \
  --repetitions 3 --pause-ms 500 --model gpt-6.1-sol --binary <miao-engine> \
  --provider subscription-responses --env-file <env.json> \
  --revision fa6bac5cce43b6110bee5d96ce3657d8567c3a3f
python3 ../docs/experiments/tools/collect.py  # see manifest.json
python3 ../docs/experiments/tools/compare.py --typescript <dir>/raw/typescript \
  --rust <dir>/raw/rust --prices <dir>/prices.json --exclude long-session \
  --csv <dir>/results.csv --markdown <dir>/results.md
```

`<cred.db>` is a minimal read-only snapshot of the runtime credential store
(only the `credential` integration rows); `<env.json>` is
`{"OPENAI_ACCESS_TOKEN": …, "OPENAI_ACCOUNT_ID": …}`. Neither is committed.
