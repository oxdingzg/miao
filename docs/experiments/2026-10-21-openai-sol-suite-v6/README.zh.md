# gpt-6.1-sol：TypeScript 与原生引擎对比（suite v6，2026-10-21）

第四轮引擎对比，模型换成订阅模型 `openai/gpt-6.1-sol`（Responses 协议，chatgpt.com 后端）。冻结
suite v6：15 类任务 × 3 次 × 双臂 = 90 次真实模型运行，两臂同一 main 提交。

## 结论

- **通过率：Rust 45/45，TypeScript 39/45。** TS 的 6 次失败：`stream-interruption` 3 次（SIGINT
  设计内终止，沿用 v6 口径计失败）与 `permission-denial` 3 次（模型在拒绝后未按判定标准收尾，原始
  evidence 已保留）。Rust 首次在 `stream-interruption` 上 3/3 通过：断流代理面向订阅
  Responses 路由，而 v6 的 openai-chat 路由两臂均不可比（0/3）。
- **成本（目录价参考）：Rust 为 TypeScript 的 0.59×**（$0.86253 vs $1.46173）。输出/输入单价比
  5.0×，盈亏平衡输出占比 83.35，即当前价格结构下原生引擎在计费口径上有约 5 倍输入用量的余量。
- **速度：p50 基本持平（18.5s vs 18.8s），p95 原生快 30%（42.7s vs 60.6s）。**
- 单价落地后（#1166）原生步骤已按目录价计费；本轮金额为目录价参考值，订阅本身不按 token 计费，
  两臂同价，比值不受影响。

## 结果总表

| Engine | Passed | Turns | Billed input | Cached input | Hit rate | Output | Cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | 39/45 | 258 (5.73/run) | 550,712 | 2,182,656 | 79.9% | 14,204 | $1.46173 | 18.8 s | 60.6 s |
| Rust | 45/45 | 282 (6.27/run) | 300,947 | 803,584 | 72.8% | 18,028 | $0.86253 | 18.5 s | 42.7 s |

Rust/TypeScript cost ratio: **0.59**；盈亏平衡输出/输入费率比 **83.35**（输出单价现为输入的 5.0×）。

## 分类明细

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

Excluding `long-session`: TS $1.26100, Rust $0.75761, ratio 0.601。

## 运行配置

| | TypeScript 臂 | Rust 臂 |
| --- | --- | --- |
| 模型 | `openai/gpt-6.1-sol`（产品订阅路由） | `gpt-6.1-sol` |
| 协议 | subscription-responses（产品内置） | `--provider subscription-responses` |
| 凭据 | 只读继承运行时凭据快照（integration `openai`，OAuth） | `--env-file`（`OPENAI_ACCESS_TOKEN`/`OPENAI_ACCOUNT_ID`，取自同一凭据行，静态注入） |
| 运行时 | main @ `fa6bac5cce` 源码（bun） | miao-engine 0.2.20，sha256 `558e1b76…` |
| 窗口 | 2026-10-21 07:57–08:13 | 2026-10-21 08:15–08:29 |

- suite hash `bd905b4f…` 与 v6 完全一致（任务、判定、夹具冻结）。
- 两臂提交口径：TS 侧 main @ `fa6bac5cce`；引擎二进制为 release CI 构建的 0.2.20（构建自
  v0.2.20 tag `d717e26ba9`，与 `fa6bac5cce` 之间仅隔一个只动 `docs/` 的提交 #1176）。
- 每次运行前有 500 ms 停顿；每次运行隔离数据目录与工作区夹具，判定用与 v6 相同的
  `judge.ts`（read-only 以断言为准，其余按夹具校验）。

## 失败明细（TypeScript 臂）

- `stream-interruption` ×3：harness 向产品进程发 SIGINT（exit 130），判定计失败。设计内行为，
  与 v6 口径一致；Rust 臂在同一任务上通过断流代理（返回 418 后按截断续跑）3/3 通过。
- `permission-denial` ×3：三轮完成但判定为 failed——模型在权限拒绝后未满足任务的收尾断言。原始
  evidence（attempts/receipts/blackbox）在 `raw/typescript/evidence/` 下逐 run 保留；Rust 臂同任务
  3/3 通过。这是模型行为差异记录，不是 harness 缺陷。

## 与既有轮次的关系

| 轮 | 目录 | 模型/路由 | 结论 |
| --- | --- | --- | --- |
| 1–2 | `2026-10-19-native-engine-suite-v6` | deepseek 直连（openai-chat） | 原生便宜，质量持平 |
| 3 | `2026-10-19-opencode-go-suite-v6` | 网关 deepseek（openai-chat + route） | 原生便宜 31%（去长会话 54%） |
| 4（本轮） | 本目录 | 订阅 gpt-6.1-sol（subscription-responses） | 原生便宜 41%、p95 快 30%、45/45 全过 |

## 复现

```sh
cd packages/miao
# TypeScript 臂（3 个 chunk，任务组见 manifest.json commands）
bun run src/engine/baseline-sweep-cli.ts --engine typescript --out <out> --tasks <T1> \
  --repetitions 3 --pause-ms 500 --model openai/gpt-6.1-sol \
  --entry packages/miao/src/index.ts --credential-db <cred.db> \
  --revision fa6bac5cce43b6110bee5d96ce3657d8567c3a3f
# Rust 臂
bun run src/engine/baseline-sweep-cli.ts --engine rust --out <out> --tasks <T1> \
  --repetitions 3 --pause-ms 500 --model gpt-6.1-sol --binary <miao-engine> \
  --provider subscription-responses --env-file <env.json> \
  --revision fa6bac5cce43b6110bee5d96ce3657d8567c3a3f
python3 ../docs/experiments/tools/collect.py  # 见 manifest.json
python3 ../docs/experiments/tools/compare.py --typescript <dir>/raw/typescript \
  --rust <dir>/raw/rust --prices <dir>/prices.json --exclude long-session \
  --csv <dir>/results.csv --markdown <dir>/results.md
```

`<cred.db>` 为运行时凭据库的最小只读快照（只含 `credential` 表的 integration 行）；`<env.json>`
为 `{"OPENAI_ACCESS_TOKEN": …, "OPENAI_ACCOUNT_ID": …}`。两者都不入库。
