# glm-5.3-flash：TypeScript 与原生引擎对比（suite v6，2026-10-21）

第五轮引擎对比，模型换成 `zhipuai-coding-plan/glm-5.3-flash`（智谱 Coding Plan 网关
`open.bigmodel.cn/api/coding/paas/v4`，OpenAI 兼容 chat completions）。冻结 suite v6：
15 类任务 × 3 次 × 双臂 = 90 次真实模型运行，两臂同一 main 提交。

## 结论

- **通过率：Rust 42/45，TypeScript 38/45。** Rust 的 3 次失败全部是 `stream-interruption`：
  断流代理对 bigmodel 网关返回 HTTP 421（"Direct IP access is not allowed"）——该代理面向
  订阅 Responses/SSE 路由设计，对 openai-chat 网关不可比（与 v6 第 3 轮同类口径）。TS 的 6 次
  失败中 3 次同为 `stream-interruption`（SIGINT 设计内终止，计失败口径），3 次
  `permission-denial`（模型在拒绝后未满足收尾断言，原始 evidence 保留），另有 `large-file` 1 次。
- **成本（目录价参考）：Rust 为 TypeScript 的 0.55×**（$0.08442 vs $0.15453；去长会话 0.45×）。
  输出/输入单价比 3.33×，盈亏平衡输出占比 19.81。
- **速度：原生 p50/p95 都更慢**（30.7s vs 22.3s；207.0s vs 96.8s）——原生臂输出 token 是
  TS 的 2.2×（51,915 vs 23,547），glm-5.3-flash 在引擎系统提示下的回答明显更长，p95 被个别
  长生成拖高。成本占比上输出仅 20.9%（Rust），被更低的输入用量抵消。
- plan 内含额度（目录 cost 0）；金额按目录参考价（$0.15/M 入、$0.50/M 出、cache 读 $0.03/M）
  计算，两臂同价，比值不受影响。

## 结果总表

| Engine | Passed | Turns | Billed input | Cached input | Hit rate | Output | Cost | p50 | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| TypeScript | 38/45 | 245 (5.44/run) | 300,761 | 3,254,848 | 91.5% | 23,547 | $0.15453 | 22.3 s | 96.8 s |
| Rust | 42/45 | 265 (5.89/run) | 100,730 | 1,445,120 | 93.5% | 51,915 | $0.08442 | 30.7 s | 207.0 s |

Rust/TypeScript cost ratio: **0.546**；盈亏平衡输出/输入费率比 **19.81**（输出单价现为输入的 3.33×）。

## 分类明细

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

Excluding `long-session`: TS $0.12572, Rust $0.05623, ratio 0.447。

## 运行配置

| | TypeScript 臂 | Rust 臂 |
| --- | --- | --- |
| 模型 | `zhipuai-coding-plan/glm-5.3-flash`（产品 openai-compatible 路由） | `glm-5.3-flash` |
| 协议 | openai-compatible（产品内置） | `--provider openai-chat` |
| 端点 | `https://open.bigmodel.cn/api/coding/paas/v4`（产品目录） | `--endpoint https://open.bigmodel.cn/api/coding/paas/v4/chat/completions` |
| 凭据 | 只读继承运行时凭据快照（integration `zhipuai-coding-plan`，key） | `--env-file`（`OPENAI_API_KEY`，同一 key 静态注入） |
| 运行时 | main @ `fa6bac5cce` 源码（bun） | miao-engine 0.2.20，sha256 `558e1b76…` |
| 窗口 | 2026-10-21 07:57–08:24 | 2026-10-21 08:25–08:59 |

- suite hash `bd905b4f…` 与 v6 完全一致；每次运行隔离数据目录与工作区夹具，判定与 v6 相同。
- 两臂提交口径同第 4 轮（见 `2026-10-21-openai-sol-suite-v6`）：引擎二进制 0.2.20 构建自
  v0.2.20 tag，与 TS 侧 main 仅隔一个 docs-only 提交。
- smoke：正式跑之前两臂各先以 `read-only` 单跑一次验证连通（bigmodel 网关授权
  `glm-5.3-flash`，工具调用与 cache 计量正常）。

## 失败明细

- Rust `stream-interruption` ×3：断流代理向网关转发时返回 HTTP 421。该任务的代理只适配
  订阅 Responses/SSE 断流协议，openai-chat 网关下两臂均不可比（TS 臂是被 SIGINT，Rust 臂是
  421）——沿用 v6 的"不比"口径，不把它算进原生能力短板。
- TS `permission-denial` ×3 与 `large-file` ×1：完成但判定未过；原始 evidence（attempts、
  receipts、blackbox）逐 run 保留在 `raw/typescript/evidence/`。Rust 臂 permission-denial
  3/3、large-file 3/3 通过。模型行为差异记录，非 harness 缺陷。

## 与既有轮次的关系

| 轮 | 目录 | 模型/路由 | 结论 |
| --- | --- | --- | --- |
| 1–2 | `2026-10-19-native-engine-suite-v6` | deepseek 直连（openai-chat） | 原生便宜，质量持平 |
| 3 | `2026-10-19-opencode-go-suite-v6` | 网关 deepseek（openai-chat + route） | 原生便宜 31%（去长会话 54%） |
| 4 | `2026-10-21-openai-sol-suite-v6` | 订阅 gpt-6.1-sol（subscription-responses） | 原生便宜 41%、p95 快 30%、45/45 |
| 5（本轮） | 本目录 | 智谱 Coding Plan glm-5.3-flash（openai-chat） | 原生便宜 45%（去长会话 55%）；p95 更慢、输出更长 |

## 复现

```sh
cd packages/miao
# TypeScript 臂（3 个 chunk，任务组见 manifest.json commands）
bun run src/engine/baseline-sweep-cli.ts --engine typescript --out <out> --tasks <T1> \
  --repetitions 3 --pause-ms 500 --model zhipuai-coding-plan/glm-5.3-flash \
  --entry packages/miao/src/index.ts --credential-db <cred.db> \
  --revision fa6bac5cce43b6110bee5d96ce3657d8567c3a3f
# Rust 臂
bun run src/engine/baseline-sweep-cli.ts --engine rust --out <out> --tasks <T1> \
  --repetitions 3 --pause-ms 500 --model glm-5.3-flash --binary <miao-engine> \
  --provider openai-chat \
  --endpoint https://open.bigmodel.cn/api/coding/paas/v4/chat/completions \
  --env-file <env.json> \
  --revision fa6bac5cce43b6110bee5d96ce3657d8567c3a3f
python3 ../docs/experiments/tools/collect.py  # 见 manifest.json
python3 ../docs/experiments/tools/compare.py --typescript <dir>/raw/typescript \
  --rust <dir>/raw/rust --prices <dir>/prices.json --exclude long-session \
  --csv <dir>/results.csv --markdown <dir>/results.md
```

`<cred.db>` 为运行时凭据库的最小只读快照（只含 `credential` 表的 integration 行）；`<env.json>`
为 `{"OPENAI_API_KEY": …}`。两者都不入库。
