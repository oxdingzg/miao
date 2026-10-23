# 实验记录

[English](README.en.md)

本目录保存**可复现的真实模型测量**：报告、对比脚本、原始 evidence 一起提交，便于复核结论或在新版本上重跑。本地草稿与临时产物放 `docs/research/`（已 gitignore），不提交到这里。

## 目录约定

```
docs/experiments/
  README.zh.md, README.en.md      索引与规则
  tools/compare.py                通用对比脚本（stdlib，无依赖）
  <YYYY-MM-DD>-<slug>/
    README.zh.md, README.en.md    结论、方法、复现命令、证据边界
    manifest.json                 版本与环境事实
    prices.json                   计费单价（per 1M tokens）
    results.csv                   机器可读的逐类与总计
    results.md                    由 compare.py 生成的表格
    raw/<engine>/
      evidence/*.json             每次运行的完整 evidence（含 attempts、phases、receipts）
      samples.json                合并后的 sample
      sweeps.json                 各 chunk 的 sweep 摘要
```

## 每次实验必须记录

- **revision**：跑测时仓库的 commit；两侧不一致时必须在 README 里说明原因，或重跑到同一 commit。
- **suiteHash**：冻结任务集的哈希。两侧 suiteHash 不同则不是同一组任务，不能合并比较。
- **模型与路由**：模型 id、provider、endpoint；**不得**记录 API key。
- **二进制身份**：引擎走 `--binary` 时记录 `binarySha256` 与 `--version`。
- **价格**：`prices.json`，并注明来源与日期；金额用产品自己的 `SessionRunnerCost.ofTurn` 复核（手算与产品函数必须一致）。
- **命令**：完整命令行（key 用 `<env>` 占位）。
- **n 与任务列表**：重数与类别；缺哪一类、哪一类不可比要写明。

## 规则

- 不提交凭据、绝对路径、个人目录名；提交前扫一遍 `raw/`。
- 原始 evidence 保留 JSON（可读、可 grep）。单个实验目录超过 25 MB 时，改为 `.json.gz` 或 release 附件，仓库只留汇总、脚本与复现命令。
- 结论必须能由 `tools/compare.py` + 原始 evidence 重新算出；README 里的数字与 `results.md` 不一致视为错误。
- 成本类结论建议同配置至少跑两轮并同时报告：实测中同一 suite 的两轮比值从 0.785 到 0.881（见 2026-10-19 实验）。
- 单次实验只回答它覆盖的问题。README 必须写“证据边界”（模型、n、任务类型、机器），不要把一次结果外推成产品级结论。

## 现有实验

| 日期       | 目录                                                                                | 内容                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-19 | [2026-10-19-native-engine-suite-v6](2026-10-19-native-engine-suite-v6/README.zh.md) | TypeScript vs 原生引擎：15 类任务 × 3 次，输入/缓存/输出/费用与盈亏平衡                                                                                                            |
| 2026-10-19 | [2026-10-19-opencode-go-suite-v6](2026-10-19-opencode-go-suite-v6/README.zh.md)     | 同上，换网关模型 `opencode-go/deepseek-v4.1-flash`（需要 route 与会话头）：原生便宜 31%，去掉长会话 54%                                                                            |
| 2026-10-21 | [2026-10-21-glm53flash-suite-v6](2026-10-21-glm53flash-suite-v6/README.zh.md)       | 同上，换 `zhipuai-coding-plan/glm-5.3-flash`（bigmodel 网关，openai-chat）：原生便宜 45%（去长会话 55%）；p95 更慢、输出更长（RS 42/45 vs TS 38/45）                               |
| 2026-10-21 | [2026-10-21-openai-sol-suite-v6](2026-10-21-openai-sol-suite-v6/README.zh.md)       | 同上，换订阅模型 `openai/gpt-6.1-sol`（subscription-responses）：原生便宜 41%、p95 快 30%；RS 45/45 全过（stream-interruption 首次可比并通过）                                     |
| 2026-10-22 | [engine-cost-benchmark.md](engine-cost-benchmark.md)                                | 7 任务族 × 双引擎 × 两个计价模型（deepseek-v4.1-flash、glm-5.3-flash），best-of-2：42 个可运行 cell 全过；原生成本 0.55–0.59×；deepseek rust 无原生路由为 N/A，glm rust 当时未计价 |
| 2026-10-23 | [mimo-engine-benchmark-2026-10-23.md](mimo-engine-benchmark-2026-10-23.md)          | 同 7 任务族 × `opencode-go/mimo-v2.6-flash`，best-of-2：TS 14/14 vs RS 9/14；RS 成本 ≈9.5×（网关前缀缓存不命中）、总时长 +90%；含 #1252 null 帧修复前后的证据                      |

## 横向汇总（统一维度）

把每一轮按同一组维度汇总，便于跨轮复核“原生 vs TypeScript”的方向性。维度：**通过** = 验证门槛通过/运行数；**轮次** = provider turns 合计；**未缓存输入 / 缓存读 / 输出** = token 合计（billed-in = 未缓存 + 缓存读）；**成本** = 同一单价表折算的 USD；**总时长** = 每次运行 `elapsedMs` 之和（wall clock）；**p50/p95** = 单次运行时延分位。

| 实验 · 模型                                                                                                | 口径                 | 引擎 | 通过  | 轮次  | 未缓存输入 | 缓存读    | 输出   | 成本 ($) | 总时长 (s) | p50/p95 (s)  |
| ---------------------------------------------------------------------------------------------------------- | -------------------- | ---- | ----- | ----- | ---------- | --------- | ------ | -------- | ---------- | ------------ |
| [10-19 native](2026-10-19-native-engine-suite-v6/README.zh.md) · `deepseek/deepseek-v4-flash` 直连         | 15 类 × 3（45 全量） | TS   | 39/45 | 231   | 604,321    | 2,859,904 | 23,375 | 0.1133   | 415        | 7.6 / 37.8   |
| 〃                                                                                                         | 〃                   | RS   | 41/45 | 334   | 111,035    | 2,163,453 | 62,040 | 0.0604   | 476        | 9.0 / 40.2   |
| [10-19 opencode-go](2026-10-19-opencode-go-suite-v6/README.zh.md) · `opencode-go/deepseek-v4.1-flash` 网关 | 同上                 | TS   | 39/45 | 239   | 713,610    | 2,861,440 | 28,043 | 0.1325   | 846        | 14.9 / 47.3  |
| 〃                                                                                                         | 〃                   | RS   | 41/45 | 329   | 178,929    | 2,089,472 | 61,220 | 0.0698   | 1,118      | 17.1 / 71.5  |
| [10-21 glm53flash](2026-10-21-glm53flash-suite-v6/README.zh.md) · `zhipuai-coding-plan/glm-5.3-flash`      | 同上                 | TS   | 38/45 | 245   | 300,761    | 3,254,848 | 23,547 | 0.1545   | 1,573      | 22.3 / 96.8  |
| 〃                                                                                                         | 〃                   | RS   | 42/45 | 265   | 100,730    | 1,445,120 | 51,915 | 0.0844   | 2,036      | 30.7 / 207.0 |
| [10-21 openai-sol](2026-10-21-openai-sol-suite-v6/README.zh.md) · `openai/gpt-6.1-sol` 订阅                | 同上                 | TS   | 39/45 | 258   | 550,712    | 2,182,656 | 14,204 | 1.4617   | 945        | 18.8 / 60.6  |
| 〃                                                                                                         | 〃                   | RS   | 45/45 | 282   | 300,947    | 803,584   | 18,028 | 0.8625   | 847        | 18.5 / 42.7  |
| [10-22 cost-batch](engine-cost-benchmark.md) · glm-5.3-flash                                               | 7 类 best-of-2       | TS   | 7/7   | n/a ¹ | n/a ¹      | n/a ¹     | n/a ¹  | 0.3159   | 234        | n/a          |
| 〃                                                                                                         | 〃                   | RS   | 7/7   | n/a ¹ | n/a ¹      | n/a ¹     | n/a ¹  | 0.0000 ² | 643        | n/a          |
| 〃 · deepseek-v4.1-flash                                                                                   | 同上                 | TS   | 7/7   | n/a ¹ | n/a ¹      | n/a ¹     | n/a ¹  | 0.0210   | 205        | n/a          |
| 〃                                                                                                         | 〃                   | RS   | —     | —     | —          | —         | —      | N/A ³    | —          | —            |
| [10-23 mimo](mimo-engine-benchmark-2026-10-23.md) · `opencode-go/mimo-v2.6-flash`                          | 7 类 best-of-2       | TS   | 14/14 | 40    | 52,784     | 554,624   | 2,854  | 0.0109   | 366        | n/a ⁴        |
| 〃                                                                                                         | 〃                   | RS   | 9/14  | 54    | 695,253    | 655,360   | 14,853 | 0.1033 ⁵ | 697        | n/a ⁴        |

1. 10-22 轮提交的汇总表只保留 billed-in 合计与逐 cell 时长，未缓存/缓存/输出/轮次的拆分与逐次 evidence 未随该轮提交（与 15 类轮次的 `results.csv` 不同）；重跑 harness 可补齐这些列。
2. 该轮 glm rust 单元当时未接价格表（引擎上报 $0.0000），成本比值以 billed-in 与 token 折算为准；#1251 已补 overlay 价格，重跑可直接得到成本列。
3. `deepseek-v4.1-flash` 在 opencode-go 订阅上无原生路由，4 个 rust cell 为 N/A（模型/凭据限制，非引擎失败）。
4. mimo 轮 n=2，harness 的 p50/p95 落在同一（较差）次上；分位数以该轮报告为准。
5. mimo rust 成本为按目录价折算；原生 placement 的 `miao run` 计价尚未接线，引擎上报 $0.0000。

**可比性提示**：成本跨模型/单价不同**不可直接横比**，同一轮内 TS/RS 比值才可比——10-19 至 10-21 三轮 RS ≈ TS 的 0.53–0.59×，10-22 best-of-2 按文档口径 0.55–0.59×，10-23 mimo 轮 ≈ 9.5×（贵，主因网关前缀缓存不命中，见该轮 follow-up）。门槛通过率：除 mimo 轮（TS 14/14 > RS 9/14）外，RS 均 ≥ TS。
