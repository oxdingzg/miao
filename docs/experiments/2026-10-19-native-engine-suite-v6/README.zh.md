# 原生引擎 vs TypeScript：suite v6 实测（2026-10-19）

[English](README.en.md)

在同一个 `main` 提交上，用冻结任务集 suite v6 的两个引擎各跑 45 次真实模型运行，比较成功率、turns、计费输入、缓存输入、输出与折算费用。

- 仓库 revision：`83f7c4f935295946d46d1e802cb81ea382f0893c`（两臂相同）
- suite：v6，15 类任务，`suiteHash = bd905b4f81f0a9412b614631a36337723067574848c5f05b50ead1cf48675091`
- 模型：`deepseek-v4-flash`（TS 经 `deepseek/` provider，RS 经 `openai-chat` 协议直连 `https://api.deepseek.com/chat/completions`）
- 引擎二进制：`miao-engine 0.2.16`，`binarySha256 = b2c1d67f465561ad7bed58ab28ebe03658b8042e16b0bb3f75a41d65329d14fd`
- 重数：每类 3 次，共 90 次；顺序执行（两臂不并发，避免 provider 竞争）
- 计费口径与单价：见 `prices.json`，金额用产品自己的 `SessionRunnerCost.ofTurn` 计算

## 结果

见 [`results.md`](results.md)（由 `../tools/compare.py` 生成）与 [`results.csv`](results.csv)。

| 引擎       | 通过        | turns        | 计费输入 | 缓存输入  | 命中率 | 输出   | 总费用       | p50   | p95    |
| ---------- | ----------- | ------------ | -------- | --------- | ------ | ------ | ------------ | ----- | ------ |
| TypeScript | 39/45 86.7% | 231 (5.13/r) | 604,321  | 2,859,904 | 82.6%  | 23,375 | $0.11325     | 7.6 s | 37.8 s |
| 原生引擎   | 41/45 91.1% | 334 (7.42/r) | 111,035  | 2,163,453 | 95.1%  | 62,040 | **$0.06037** | 9.0 s | 40.2 s |

**结论（2026-10-20 更正后）**：原生引擎总费用低 **46.7%**（比值 0.533），成功率略高，p50 慢 1.4 s、p95 慢 2.4 s。输入侧便宜（计费输入 11.1 万 vs 60.4 万，命中率 95.1% vs 82.6%），输出侧贵（6.2 万 vs 2.3 万，turns 7.4 vs 5.1 per run）。

逐类比值见 `results.md`：14 类原生更省；`long-session` 为 **1.27×**（早先记录的 3.43× 是计量缺陷，见下）。**去掉该类：TS $0.10003、原生 $0.04356，原生便宜 56.5%。**

**盈亏平衡**：输出单价 ≥ 输入单价的 **13.1 倍**时结论才翻转；当前模型是 4.0 倍。

### 更正（2026-10-20）：多输入任务的计量虚高

早先的采集把每个后续输入重放的历史事件又累加了一遍，`long-session` 因此报出 98 attempts / 326 phases（实际 23 / 115），原生该类费用被高估 3–4 倍，整体优势也被低估。harness 已按 committed seq 去重（#1142），本目录 `raw/` 已换成修正后的该类 evidence，早先的虚高样本保留在 `correction/`。

修正后该类：TS $0.01322、原生 $0.01681（1.27×）；原生 rep0 以 `tool.error` 收尾，故通过数为 41/45。

## 重复运行与波动

另一个网关模型（`opencode-go/deepseek-v4.1-flash`）在同一 suite 上给出比值 **0.527**、盈亏平衡 **16.6×**、去掉 `long-session` 后 **0.459**（见 [第二份实验](../2026-10-19-opencode-go-suite-v6/README.zh.md)）。两轮更正后的优势在 46.7%–47.3%，方向一致。因此：

- 单轮数字只能给出方向，不宜当作精确幅度；
- 要给出成本结论，建议同一配置至少跑两轮并同时报告两轮（见 `../README.zh.md` 的规则）。

## 行为差异

- `permission-denial`：TS 0/3（终止为 completed、只留下 `tool.error`，缺少任务要求的 `permission.denied`）；原生 3/3（`permission.denied` + `tool.error` 都有）。
- `stream-interruption`：两臂均 0/3。原因与协议相关，不是引擎能力差异：断流代理是为 Responses/SSE 设计的，在 `openai-chat` 路由下 TS 被 SIGINT 掉（exit 130、无 `provider.interrupted`），原生直接收到 provider HTTP 418。该类在当前路由下不可比。

## 证据边界

单一模型、n=3/类、只有目标可程序化判定的短任务、单机顺序执行；绝对金额很小（两臂合计约 $0.20）。这些数字不构成产品级或跨模型结论。

## 复现

```sh
# 先准备 key（不提交）：<env.json> = {"OPENAI_API_KEY": "<deepseek key>"}
cd packages/miao

# TypeScript 臂（每块 5 类；<data> 是产品数据目录）
bun run src/engine/baseline-sweep-cli.ts --engine typescript -out <out> \
  --tasks read-only,multi-read,small-edit,multi-file,test-repair --repetitions 3 --pause-ms 500 \
  --model deepseek/deepseek-v4-flash --entry packages/miao/src/index.ts --credential-db <data>/miao.db \
  --revision <revision>

# 原生引擎臂（同一模型，走 openai-chat 协议）
bun run src/engine/baseline-sweep-cli.ts --engine rust -out <out> \
  --tasks read-only,multi-read,small-edit,multi-file,test-repair --repetitions 3 --pause-ms 500 \
  --model deepseek-v4-flash --binary <miao-engine> --provider openai-chat \
  --endpoint https://api.deepseek.com/chat/completions --env-file <env.json> --revision <revision>

# 采集与对比
python3 ../tools/collect.py --out <run dir> --engine typescript --chunk <out>...
python3 ../tools/compare.py --typescript <run>/raw/typescript --rust <run>/raw/rust \
  --prices <run>/prices.json --exclude long-session --csv <run>/results.csv --markdown <run>/results.md
```

完整的三段命令见 `manifest.json` 的 `commands`。任务列表、重数、suiteHash 也在 `manifest.json`。

## 文件

| 路径                           | 内容                                                                       |
| ------------------------------ | -------------------------------------------------------------------------- |
| `manifest.json`                | 两臂的 revision、模型、suiteHash、binarySha256、任务、重数、命令、起止时间 |
| `prices.json`                  | 计费单价与来源                                                             |
| `results.md` / `results.csv`   | 汇总与逐类结果                                                             |
| `raw/<engine>/evidence/*.json` | 每次运行的完整 evidence（attempts、phases、receipts、assessment）          |
| `raw/<engine>/samples.json`    | 合并后的 sample（含 outcome、profile、receiptHash）                        |
| `raw/<engine>/sweeps.json`     | 各 chunk 的 sweep 摘要（binary 路径已剔除，仅保留 sha256）                 |
