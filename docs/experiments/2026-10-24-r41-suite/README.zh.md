# 2026-10-24 R4.1 代表性任务质量验收（suite-v6 全 15 类 × 3 × 双引擎，glm-5.3-flash）

所有者授权的 R4.1 验收：suite-v6 冻结任务集 15 类 × 3 次 × 双引擎（45 runs/臂），模型 `zhipuai-coding-plan/glm-5.3-flash`，基线与臂说明见 `manifest.json`。TS 臂走产品源码入口（隔离数据目录 + 最小凭据快照），RS 臂走引擎二进制显式 openai-chat 路由。

## 逐类结果

| 任务                | TS 通过   | RS 通过   | TS 时长(s) | RS 时长(s) |
| ------------------- | --------- | --------- | ---------- | ---------- |
| create-module       | 3/3       | 3/3       | 75         | 79         |
| docs-sync           | 3/3       | 3/3       | 74         | 96         |
| large-file          | 3/3       | 3/3       | 98         | 132        |
| long-session        | 3/3       | 3/3       | 269        | 506        |
| multi-file          | 3/3       | 3/3       | 94         | 115        |
| multi-line-edit     | 3/3       | 3/3       | 56         | 77         |
| multi-read          | 3/3       | 3/3       | 54         | 28         |
| permission-denial   | **0/3**   | **3/3**   | 99         | 99         |
| read-only           | 3/3       | 3/3       | 45         | 43         |
| rename-symbol       | 3/3       | 3/3       | 90         | 101        |
| small-edit          | 3/3       | 3/3       | 83         | 66         |
| stream-interruption | 0/3       | 0/3       | 42         | 12         |
| test-repair         | 3/3       | 3/3       | 76         | 85         |
| tool-error          | 3/3       | 3/3       | 50         | 59         |
| typed-repair        | 3/3       | 3/3       | 72         | 93         |
| **合计**            | **39/45** | **42/45** | 1,277      | 1,591      |

## 验收结论

1. **R4.1 达标：RS 42/45（93.3%）≥ TS 39/45（86.7%）**——原生引擎质量不低于 TypeScript，且在 permission-denial 类**完胜**（TS 0/3，RS 3/3：原生权限门对越权写入的拒绝与不落盘行为正确）。
2. `stream-interruption` 双臂 0/3：该类对 harness 中断时序敏感，历史轮次同样不稳定（10-21 双臂均未过；sol 轮双过）。作为已知 harness 敏感类单独跟踪，不影响本验收结论。
3. **时长**：RS 总时长 +25%（1591s vs 1277s），主要来自 long-session（506 vs 269）与输出更长；multi-read 类 RS 反而快一倍（28 vs 54）。
4. 与成本批结论互证：RS 轮次/输出更多（质量更完整的作答），但单步延迟与缓存行为仍是成本侧待解项（见 2026-10-23-g5-official）。

## 证据边界

- `ts/`、`rs/` 各含 `samples.json`（逐次 outcome/elapsedMs/attempts）与 `evidence/`（逐次门禁与评估记录）；`runs/`、`sweep.json` 为 sweep 原始产物。
- 凭据以最小快照（credential 表 8 行）注入，未提交任何密钥材料。
