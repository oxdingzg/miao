# CTX-03：手动 compact、recap 与定向摘要

状态：**recap 已实现（引擎侧）；定向摘要完成设计、未实现**。基线 `1291ba4c45`。
本项接续 [CTX-02 的自动压缩](context-management-reference.md)，只处理"人主动发起"
的那一半：一次 compact 让模型少读，一次 recap 让人看懂。

## 1. 今天真实发生的两条路径

**compact 是检查点，不是删除。** `Store::compact` / `Store::compact_for_run`
（`crates/miao-engine/src/history.rs:11`、`:26`）只往 `engine_compaction` 写一行，
并追加 `pre_compact` / `history.compacted` / `post_compact` 三个事件；`engine_message`
一行都不动。provider 侧的变化来自选择而不是删除：`selected_input`
（`history.rs:106`）取 `seq > through_seq` 的消息，并把
`<history-summary>` 作为前缀注入。因此"压缩释放上下文"与"原始记录仍在"同时成立，
run 内的强制压缩还额外要求活动 run、已结算的 provider turn、没有未结算工具
（`history.rs:47-80`）。

**手动 compact 的入口只有请求，没有范围。** 控制面 `session.compact`
（`packages/server/src/handlers/session.ts:575`）在原生路径上发引擎命令
`request_compact`（`packages/miao/src/engine/native-engine.ts:745`），引擎把
`compaction.requested` 记为持久事实（`crates/miao-engine/src/store.rs:856`），
在下一次已结算的 assistant 边界结算它：`compaction.settled` 带 `compacted`
（`store.rs:893`）。整条链路没有参数能指定"截到哪"或"留着什么"。

**recap 此前完全不存在。** 全仓库唯一的 `recap` 出现在一条提示词里
（`packages/core/src/session/runner/llm.ts:1496` 的 `do not apologize or recap`），没有任何实现。

## 2. 两个行为的区分（已实现）

| | compact | recap |
| --- | --- | --- |
| 谁受益 | 模型（少读） | 人（看懂） |
| provider 调用 | 有：摘要器经 diff 摘要 | 无 |
| 持久结果 | `engine_compaction` 检查点 + 三个事件 | 一个 `recap.created` 事件（审查文件） |
| 下一次请求 | 前缀被摘要替换 | 与没有 recap 时逐字节相同 |
| 失败方式 | breaker 计数、请求结算为 `compacted:false` | 只读，不会失败到改变任何状态 |

实现：`crates/miao-engine/src/recap.rs` 从持久记录构出 `Recap`（最新检查点、窗口消息、
durable state），`Store::recap` 在同一事务里读快照并追加 `recap.created`，
`Command::Recap`（`protocol.rs`）与 `Runtime::recap`（`runtime.rs`）把它变成线
上的一个命令。窗口部分的组成是确定的：消息计数、最新检查点与截断摘要、
`durable_state_block` 的目标与未完成任务、最近 3 条用户提示、最后一条有文本的
assistant 回复、工具调用计数与改动文件清单。

**证据**：`tests/recap.rs` 断言 recap 前后 `selected_history` 完全相同、摘要器调用次数
为 0、没有 `history.compacted`、窗口里的提示与文件清单正确；
`tests/stdio.rs::stdio_recap_is_a_wire_command_that_commits_no_checkpoint`
断言它在线上可达、不存在的 Session 被拒绝。

## 3. 定向摘要：保留目标与摘要范围（S3/S4 设计）

现在引擎只能"截到本次结算的边界、摘要全部选中历史"。要把"允许指定保留目标或摘要
范围"变成可验收的行为，`request_compact` 增加两个可选参数：

```rust
RequestCompact { session_id: String, through: Option<u64>, focus: Option<String> }
```

- **`through`（摘要范围）**：检查点要切在哪个消息序号。默认仍是"结算它的那次
  assistant 边界"；显式给出时，从 `selected_history` 里筛出 `seq <= through` 的消息做
  摘要，`through` 之后的消息原样保留——这就是保留目标的机械形式。
- **`focus`（保留目标）**：≤2000 字符的自然语言要求，追加到摘要器提示词
  （`Summarize this portion of the conversation` 之后）并记录在
  `compaction.requested` 的载荷里，使一次检查点可以追溯到"当时要求保留什么"。
  `durable_state_block` 无论如何都进摘要，focus 不能把它挤掉。

校验沿用 `commit_compaction` 已有的规则，且**拒绝而不是悄悄调整**：`through` 必须落在
assistant 消息上、不能切开工具调用/结果对、不能早于上一个检查点。越界、落在用户消息
上、落在工具续接中间，都以 `compaction.failed` 的理由回给客户端，并把请求结算为
`compacted:false`（一次尝试永远回答一次请求，这一点不因新参数改变）。

## 4. 新的范围策略为什么不破坏原始记录

四条不变量，前三条已经由代码保证，第四条是 S3 必须保持的：

1. **原始记录只增不改**：检查点只写 `engine_compaction`；`engine_message` 的删除只
   由 `remove` / `revert` 明确触发，压缩路径从不删除。
2. **不切开工具对**：`commit_compaction` 用 `track_tools` 在事务内验证待结算工具为空。
3. **检查点不倒退**：`through` 小于上一个检查点即拒绝。
4. **越界即拒绝**：没有"自动夹到最近的合法边界"。用户可以观察到的世界里，只有
   "按要求截断"和"明确失败"两种结果。

## 5. 落地切片

每个切片单独 PR，S1 已交付。

- **S1（已实现，本 PR）**：引擎 `recap` 命令、事件、测试与 `PROTOCOL.md`。
- **S2**：控制面与客户端。`packages/server` 增加 `session.recap` 路由，原生引擎转成
  `recap` 命令；TUI 在会话页显示 `recap.created`（只读面板，不写入对话），并提供
  `/recap` 命令。TS 一侧不新增实现（TS runner 正在退役）。
- **S3**：`request_compact` 的 `through` 参数与拒绝语义、`compaction.requested`
  载荷、`tests/compact_request.rs` 的范围用例。
- **S4**：`focus` 参数进入摘要器提示词与检查点溯源；用例断言 focus 文本出现在
  摘要请求里、`durable_state_block` 不被挤掉。
- **S5**：客户端把 S3/S4 的参数暴露成可操作命令，并补真实客户端验收记录。

## 6. 验收清单映射

| CTX-03 验收项 | 对应 |
| --- | --- |
| compact 释放上下文，recap 只帮人回顾，两个行为可区分 | §2 的逐项区分 + `tests/recap.rs` 与 `tests/stdio.rs` 的断言 |
| 允许指定保留目标或摘要范围 | §3 的 `through` / `focus` 设计（S3/S4 未实现，不得视为已验收） |
| 新范围策略独立设计且不静默抹除原始记录 | §3 的拒绝语义 + §4 的四条不变量 |
| 关联实现 PR 与客户端验收记录 | S1 已有一份实现 PR；S2/S5 的客户端验收尚未发生 |

产品验收（面板可见、`/recap` 可用）要等 S2 落地后再记，本文不声明已经完成。
