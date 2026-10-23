# 2026-10-23 engine cost batch（10-22 成本批的全维度重跑）

`docs/experiments/engine-cost-benchmark.md`（2026-10-22）当时只提交了报告表格（缺 turns、未缓存/缓存/输出拆分与逐次证据，deepseek rust 整臂 N/A）。本轮用同一任务集（7 任务族 × 2 模型 × 双引擎 × best-of-2）与新 harness（#1278 起 `--data` 落盘）重跑，按目录约定提交 `results.csv` 与 `raw/`，把汇总表需要的维度补齐。

## 结论

1. **`opencode-go/deepseek-v4.1-flash` 已可原生路由**：10-22 整臂 N/A，本轮 rust 14/14 全过（G5 的 deepseek 路由缺口已被后续修复关闭）。
2. **门槛**：TS 28/28；RS 27/28。唯一失败是 `glm/recovery/rust#2`（SIGKILL 后续跑）：`quote()` 转义多加一层、`parseRecord` 丢字段——与 mimo 轮 rust recovery 的失败签名相同，跨模型复现，指向原生续跑的系统性问题；本轮 evidence 已保留。
3. **成本**：rust 引擎上报仍为 $0.0000（原生 placement 的 `miao run` 未把价格索引传给引擎，follow-up 未闭合）。按 `prices.json` 折算：glm rust **$0.1913 ≈ TS 的 2.66×**，deepseek rust **$0.2762 ≈ TS 的 5.64×**。主因仍是前缀缓存不命中：rust 未缓存输入 1.20–1.69M vs TS 0.25–0.26M（缓存读相近），叠加输出 3.6–4.8×（10-23 mimo 轮同向）。
4. **时长**：rust 总 wall +67%（glm，1088s vs 652s）、+68%（deepseek，509s vs 302s）。

## 汇总（全量 14 次/引擎/模型）

| 模型                | 引擎 | 通过  | 轮次 | 未缓存输入 | 缓存读    | 输出   | 引擎上报成本 | 折算成本 | 总时长(s) | p50/p95(s)   |
| ------------------- | ---- | ----- | ---- | ---------- | --------- | ------ | ------------ | -------- | --------- | ------------ |
| glm-5.3-flash       | TS   | 14/14 | 88   | 260,656    | 1,022,080 | 5,570  | 0.0721       | 0.0686   | 652       | 43.5 / 71.3  |
| glm-5.3-flash       | RS   | 13/14 | 97   | 1,204,124  | 1,050,112 | 26,919 | 0.0000 ¹     | 0.1913   | 1,088     | 88.6 / 120.1 |
| deepseek-v4.1-flash | TS   | 14/14 | 83   | 249,088    | 987,904   | 7,761  | 0.0486       | 0.0450   | 302       | 20.7 / 32.9  |
| deepseek-v4.1-flash | RS   | 14/14 | 129  | 1,693,316  | 1,411,456 | 29,993 | 0.0000 ¹     | 0.2762   | 509       | 40.1 / 53.4  |

1. 原生 placement 计价未接线；逐任务与逐次明细见 `results.csv`、`raw/`。

## 方法与复现

- revision：`188fa4ab5381154bc71ccc90676ee414a3611bba`（两臂同一提交；TS 为该树源码 wrapper，RS 为该树 `crates/miao-engine` 的 release 构建，二进制 sha256 见 `manifest.json`）。
- 命令（key 用 `<env>` 占位）：

```
MIAO_ENGINE_BIN=<engine binary> bun script/engine-benchmark.ts \
  --binary <ts-source-wrapper> \
  --models zhipuai-coding-plan/glm-5.3-flash,opencode-go/deepseek-v4.1-flash \
  --engines ts,rust --repeat 2 --out <report.md> \
  --data docs/experiments/2026-10-23-engine-cost-batch
```

- 单价：`prices.json`（glm 为 overlay #1251 参考价；deepseek 为 mtty.dev 目录价）；TS 引擎上报成本与折算值一致（±四舍五入）。

## 证据边界

- `raw/<model>/<engine>/samples.json` 与 `evidence/*.json` 是 harness 的结构化逐次记录（含门槛失败原因），**不含** `miao run` 的完整事件流 journal（suite-v6 才保留）；`tools/compare.py` 面向 suite-v6 evidence，本目录从 `samples.json`/`results.csv` 重算。
- n=2：harness 的 p50/p95 落在同一（较差）次上，分位数只作方向参考。
- 与 [10-22 成本批](../../engine-cost-benchmark.md) 同任务集/模型/口径；横向对比请用本目录数据，10-22 行保留为历史记录。
