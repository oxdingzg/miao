# 2026-10-24 §2.13 1M 窗口真实 compaction 实测（验收：未通过——压缩从未触发，实际是 elision）

所有者授权的 §2.13 实测：模型 `zhipuai-coding-plan/glm-5.3-flash`（目录标称 context = 1,000,000），run 路径（`MIAO_ENGINE_STORAGE` 原生放置），通过 `--continue` 链把 6 段 × ~600KB（≈150k token/段）的用户提示注入同一会话，目标跨越真实 compaction 触发点。魔咒标记分置于第 1/3/5/6 段中点，压缩后无工具回忆中段两条作为验收断言。

## 结果：验收未通过，但发现了更有价值的事实

1. **真实 compaction 从未触发**：填到 ~450k token（chunk3 的请求 input=160,573）时，`engine_compaction` 表 **0 行**——引擎在默认预算下的行为是 **elision（把有效窗口省略/截断到 ~160k token）**，而不是 summary-compaction。后续 verify 轮 input 159,712 与之同源。
2. **1M 窗口在 run 路径上是虚构的**：目录标称 1M，但引擎的有效窗口 ≈160k——预算既不来自模型 limit，compaction 设置（`MIAO_CONFIG_DIR` 下 `compaction.threshold=300000` 已验证能被 `compactionSettings` 正确解码）也没有到达引擎。根因与计价 $0 同源：**run 路径没有组合 NativeEngine layer**（issue #1285）。
3. **elision 的行为边界**：压缩后无工具回忆中段两条魔咒（`f03`/`f09` 等价物）失败——被省略的 prompt 中段内容无法恢复（restore note 指向文件，但内容埋在 prompt 里，无文件可重读）。会话本身稳定续跑（无崩溃、无重复消息）。
4. 填充方式本身的发现：read 工具负载**不会**触发压缩——引擎对 read 结果主动 elision（3.7MB 读取后 input 峰值仅 46k，见第一轮），只有 user prompt 体量才能推高上下文。

## 证据

- `input-curve.csv`：v6 四段 + verify 的逐请求 input token（chunk3: 160,573；verify: 159,712）。
- `engine_compaction.rows0.txt`：run 后引擎库 `engine_compaction` 表行数 = 0。
- `codes2.txt`/`codes3.txt`：两轮全部魔咒标准答案；v6 verify 回答中不含任何魔咒值（recall 失败的正面记录）。

## 复测条件（修复后）

#1285 落地（run 路径组合 NativeEngine layer）后重跑本验收，并预期：compaction 设置（threshold）与模型 limit（1M）到达引擎；`engine_compaction` 出现真实行；压缩后 restore note（#1280）注入；跨压缩记忆按 summary/重读策略验证。
