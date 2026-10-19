# 原生引擎 vs TypeScript：opencode-go / deepseek-v4.1-flash（2026-10-19）

[English](README.en.md)

在同一个 `main` 提交上，用冻结任务集 suite v6 复验上一轮的结论，换用网关模型 `opencode-go/deepseek-v4.1-flash`。两臂各 45 次真实运行。

- 仓库 revision：`fa001fbff8b188361bf5848cc31358bba7e7d7bb`（两臂相同）
- suite：v6，15 类，`suiteHash = bd905b4f81f0a9412b614631a36337723067574848c5f05b50ead1cf48675091`
- 模型：`opencode-go/deepseek-v4.1-flash`（TS 走 `opencode-go/` provider；RS 走 `routes.json` 的 `openai-chat` 路由）
- 引擎二进制：`miao-engine 0.2.16`，`binarySha256 = b2c1d67f465561ad7bed58ab28ebe03658b8042e16b0bb3f75a41d65329d14fd`
- 重数：每类 3 次，共 90 次；顺序执行
- 计费：`prices.json`（catalog 列表价），金额用产品自己的 `SessionRunnerCost.ofTurn` 计算

## 网关的特殊要求（复现时必须）

`opencode.ai/inference/go` 不是普通的 OpenAI 兼容端点：

1. **必须带 `x-opencode-session` 头**，缺了会返回 400 `MissingSessionID`；
2. 必须使用非 Python 客户端 UA（`miao/0.2.16` 可用），否则 Cloudflare 返回 403/1010；
3. 网关按会话路由，因此 RS 腿必须显式选择路由（`--model-routes-config` + `--model-route`），否则请求会落到引擎的默认 provider（实测表现为 `platform.openai.com` 的 401）。这需要 #1133 的 driver 改动。

`routes.json` 里只有 endpoint、header 与 `${OPENCODE_API_KEY}` 的引用，不含凭据。

## 结果

见 [`results.md`](results.md) / [`results.csv`](results.csv)。

| 引擎       | 通过        | turns        | 计费输入 | 缓存输入  | 命中率 | 输出   | 总费用       | p50    | p95    |
| ---------- | ----------- | ------------ | -------- | --------- | ------ | ------ | ------------ | ------ | ------ |
| TypeScript | 39/45 86.7% | 239 (5.31/r) | 713,610  | 2,861,440 | 80.0%  | 28,043 | $0.13245     | 14.9 s | 47.3 s |
| 原生引擎   | 41/45 91.1% | 329 (7.31/r) | 178,929  | 2,089,472 | 92.1%  | 61,220 | **$0.06984** | 17.1 s | 71.5 s |

**结论（2026-10-20 更正后）**：原生引擎总费用低 **47.3%**（比值 0.527），成功率略高，p50/p95 慢 2.2 s / 24.2 s。输入侧便宜（计费输入 17.9 万 vs 71.4 万，命中率 92.1% vs 80.0%），输出侧贵（6.1 万 vs 2.8 万，turns 7.3 vs 5.3 per run）。

逐类比值见 `results.md`：14 类原生更省；`long-session` 为 **0.98×**（与 TS 持平），`docs-sync` 为 1.35×（唯一 TS 更便宜的类）。**去掉 `long-session`：TS $0.11518、原生 $0.05286，原生便宜 54.1%。**

**盈亏平衡**：输出单价 ≥ 输入单价的 **16.6 倍**时结论才翻转（当前 4.0 倍）。

### 更正（2026-10-20）：多输入任务的计量虚高

早先的采集把后续输入重放的历史事件重复累加，`long-session` 报出 227 attempts（实际 69），原生该类费用被高估约 2.3 倍，整体优势被低估。harness 已按 committed seq 去重（#1142），`raw/` 已换成修正后的 evidence，虚高样本保留在 `correction/`。

## 行为差异

- `permission-denial`：TS 0/3（`tool.error`，缺 `permission.denied`），原生 3/3（两种凭据都有）。
- `stream-interruption`：两臂均 0/3，协议原因不可比（断流代理面向 Responses/SSE；此路由下 TS 被 SIGINT 掉、原生没有 `provider.interrupted`）。
- 原生侧有 1 次 `create-module` 失败：provider HTTP 400，`The reasoning_content in the thinking mode must be passed back to the API`。thinking 模型要求回传 reasoning 的兼容性问题，45 次里出现 1 次，未定位为稳定复现。

## 与前两轮的关系

| 轮次 | 模型                              | 比值（原生/TS） | 去掉 long-session | 盈亏平衡 |
| ---- | --------------------------------- | --------------- | ----------------- | -------- |
| 1    | deepseek-v4-flash（直连）         | 0.881           | 0.408             | 4.98×    |
| 2    | deepseek-v4-flash（直连）         | 0.785           | 0.435             | 6.32×    |
| 3    | opencode-go / deepseek-v4.1-flash | 0.690           | 0.459             | 8.56×    |

三轮方向一致：原生总体更省，去掉长会话后省 54%–59%；具体幅度随模型与任务组合波动，单轮只能定方向。

## 证据边界

单一模型、n=3/类、目标可程序化判定的短任务、单机顺序执行，两臂合计约 $0.22。网关侧的 thinking 兼容性问题可能轻微低估原生表现（1/45）。不构成产品级或跨模型结论。

## 复现

```sh
# <env.json> = {"OPENCODE_API_KEY": "<key>"}；routes.json 见本目录
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

完整的三段命令见 `manifest.json` 的 `commands`。
