# 正式 0.2.26 的 long-session 重测

## 范围与来源

- 产品：已发布的 miao 0.2.26 与配套 darwin-arm64 引擎。
- 工具：`f1d07b3c8b`（#1315）的 `script/engine-benchmark.ts`，修复继承旧 `PWD`
  导致任务目录错位的问题。
- 模型：两臂均使用目录内可计价的 `deepseek/deepseek-v4-flash`。
- 任务：仓库既有三段式 `long-session` fixture（读取 mean、增加总体标准差、补测试），
  TS/native 各独立执行三次。
- 数据、配置、引擎存储隔离，只配置需要的 API 凭据；未复制或改动生产会话库及 OAuth 凭据。

## 结果

| 引擎 | 质量门槛 | 产品上报参考成本合计 | 耗时 p50 | 耗时 p95 |
| --- | --- | --- | --- | --- |
| TypeScript | 3/3 | $0.00995 | 25,444 ms | 29,577 ms |
| Native | 3/3 | $0.00708 | 30,989 ms | 31,134 ms |

本批六次通过样本的 native/TS 成本合计比为 `0.00708 / 0.00995 = 0.7116`。
这补齐了可用、目录内计价路由上的 long-session 重测，不会反向重算旧 1.27× 批次，
也不代表跨模型、工具集、平台、缓存状态或工具版本的普遍比值。

成本来自产品参考价核算，不是提供方账单。两臂 cache-read 不同，不是受控冷缓存实验；
保留原始 token 拆分，但不能单看原始 input 推导账单节省。每臂三次属于验收样本，
不是具备统计效力的性能结论。samples.json 的单次成本已四舍五入；CSV 合计是先求和再四舍五入。

## 证据

`results.csv`、两臂 samples.json 及逐次数字证据均来自已完成的修复后运行。
所有样本 `outcome: pass` 且成本非零。不包含凭据值、提供方请求体或机器私有配置。

前一批无效数据不计入：六次质量门槛均发现零测试，原因是 CLI 继承旧 `PWD`，
把文件改进父 checkout，验证器却在另一个临时目录运行。#1315 有进程级回归测试、
修复后通过证据和旧代码失败的负对照。这是环境隔离问题，不能用来评价模型质量或引擎性能。

## 复现

在包含 #1315 的 checkout 中，用隔离的 API-only 配置和正式产品/引擎二进制：

```sh
MIAO_ENGINE_BIN=/path/to/miao-engine \
  bun script/engine-benchmark.ts \
  --binary /path/to/miao --model deepseek/deepseek-v4-flash \
  --tasks long-session --engines ts,rust --repeat 3 \
  --storage /path/to/isolated/engine-storage \
  --data /path/to/results --out /path/to/report.md
```
