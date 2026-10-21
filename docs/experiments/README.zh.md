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

| 日期       | 目录                                                                                | 内容                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 2026-10-19 | [2026-10-19-native-engine-suite-v6](2026-10-19-native-engine-suite-v6/README.zh.md) | TypeScript vs 原生引擎：15 类任务 × 3 次，输入/缓存/输出/费用与盈亏平衡                                 |
| 2026-10-19 | [2026-10-19-opencode-go-suite-v6](2026-10-19-opencode-go-suite-v6/README.zh.md)     | 同上，换网关模型 `opencode-go/deepseek-v4.1-flash`（需要 route 与会话头）：原生便宜 31%，去掉长会话 54% |
| 2026-10-21 | [2026-10-21-glm53flash-suite-v6](2026-10-21-glm53flash-suite-v6/README.zh.md)       | 同上，换 `zhipuai-coding-plan/glm-5.3-flash`（bigmodel 网关，openai-chat）：原生便宜 45%（去长会话 55%）；p95 更慢、输出更长（RS 42/45 vs TS 38/45）                              |
| 2026-10-21 | [2026-10-21-openai-sol-suite-v6](2026-10-21-openai-sol-suite-v6/README.zh.md)       | 同上，换订阅模型 `openai/gpt-6.1-sol`（subscription-responses）：原生便宜 41%、p95 快 30%；RS 45/45 全过（stream-interruption 首次可比并通过）                                          |
