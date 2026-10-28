# CTX-02 验收记录：自动压缩、裁剪与原文召回（草稿）

- 板项：CTX-02「自动压缩、裁剪与原文召回」（roadmap §2.13，gates ①-⑥）
- 状态：**验收收口记录（草稿，未提交）**。结论：验收 1-3 可勾（验收 2/3 附注限定），验收 4 以本文档与下列 PR 清单为载体。
- 适用版本：**main HEAD `82e0742c14`**（记录日 2026-10-26）。除未跟踪的 `.build-artifacts/` 外工作树干净，且当前分支在本文引用的全部文件上与 main 无差异（`git diff main HEAD --stat` 为空）。文内行号以该 HEAD 为准。
- 本记录只做证据核对，不含新代码改动；未重跑 Rust/TS 测试（所列测试均已随对应 PR 的 CI 合入 main）。

## 结论总表

| 验收项 | 结论 | 依据要点 |
| --- | --- | --- |
| 1 仅在安全边界按预算裁剪并记录压缩范围 | **可勾** | 未知窗口/无锚点一律不触发；预算取 ratio 界与 headroom 的大者；只在闭合的 checkpoint 边界压缩（工具续行不裁）；范围与实测事实持久化（`history.compacted` 含 `through_message_seq`、`context.pruned` 含实测字节） |
| 2 完整工具输出经 handle 可召回；摘要保留任务/决定/未完成项/来源 | **可勾（模型路径）** | 裁剪只动出站请求、存储历史完整；elision 标记与摘要摘录都命名 `recall {"tool_use_id"}` handle；按 handle 端到端召回有测试。操作员 RPC/TUI 不能按 handle 取回（缺口 1）；TS 引擎路径 recall 为纯搜索（缺口 2） |
| 3 实测长任务越过触发点后质量与总费用（计入摘要成本） | **可勾（附语义限定）** | forced-compaction 一致性场景双引擎 PASS 且费用含摘要调用；1M 窗口九段链在 #1310/#1314 后全通（该链路由 elision+recall 承载，真实压缩由强制场景单独证明）；long-session 重测 3/3 + 成本拆分 |
| 4 关联实现 PR | **可勾** | #1280 #1294 #1302 #1310 #1314 #1404 #1414（均已在 main）+ 实测文档 #1307 |

## 验收 1：安全边界 + 预算 + 范围记录

实现（`crates/miao-engine/src/context_trigger.rs`）：

- 预算门槛：`Budget::should_compact`（:43）要求已知窗口与已知上下文锚点，`context + pending ≥ threshold` 才触发；`threshold` 取窗口 ratio 界与显式 headroom 的大者（同 `impl Budget` 块）。未知窗口、无 usage 锚点（`Store::context_anchor` :763 只认带 `context_message_seq` 标记的 usage 事件）一律不触发，不发明数字。
- 配置面：`ContextLimits`（`window/ratio/headroom/per_pass/prune_chars/prune_total_chars/protect_turns`），`from_wire` :119；`prune_chars` 缺省 = 裁剪整体关闭（操作员请求压缩用 `operator_requested()`，elision 关闭）。
- 安全边界：`maybe_compact` :162 只在 run 拥有的 checkpoint 边界（已落定的 assistant 边界、无未决工具）进入；超时（`SUMMARY_TIMEOUT` 20s）、摘要失败、落盘失败都走 breaker（:472），显式 compact 复位。
- 裁剪预算：`prune_history_with_stats` :563 —— 每 payload 预算 + 可选总预算（超出部分按最旧优先只裁到覆盖超额）、最新 `protect_turns` 个 user 消息永不裁、裁后若不缩小请求则放弃（#1414）、标记与其中的 handle 计入成本（`PRUNE_MARK` :537、recall 注记 :606）。
- 范围与事实记录：`history.compacted` 事件携带 `through_message_seq`（TUI 卡片渲染 "History through message sequence N"）；`context.pruned` 持久事件记录 `unit/scope/reason/payloads/messages/before_bytes/after_bytes/saved_bytes/context_epoch`，且在受影响 dispatch 之前提交（#1404）。

测试：

- `tests/compaction_acceptance.rs:111` 越线一次 provider 调用完成压缩、`pre_compact/history.compacted/post_compact` 生命周期齐全、下一轮从摘要开始、progress 可观测、可重复触发；:202 压缩后首个请求骑 restore budget 注记（请求级、不持久、关闭 prompt 保持在最后，#1280）；:327 工具续行只在闭合边界压缩、steer 不被提前摘要、同一 run 多 checkpoint 单调不冲突。
- `tests/context_wire.rs:75` 未越线不动会话；:107 按计划分段摘要并提交；:182 摘要失败 trips breaker 且历史完好；:250 gate② 计锚点后增量；:302 无锚点标记不触发；:346 回退估算。
- `tests/context_prune.rs:113`（gate④ 端到端）+ :210 无预算不裁 + :223 统计按消息去重/UTF-8 字节；`tests/compaction_breaker.rs:101` 显式 compact 复位；`tests/context_count.rs`（:30/:45/:60/:77/:89）provider count_tokens 路径与回退。
- 单元（`context_trigger.rs` `#[cfg(test)]`）：`prune_elides_oversized_tool_output_and_protects_recent_turns`、`threshold_prefers_the_later_bound`、`unknown_window_or_usage_never_triggers`、`summary_plans_stay_single_until_the_prefix_cannot_fit`、`wire_form_parses_camel_case_and_rejects_garbage`、`breaker_trips_after_the_threshold_and_resets_explicitly`、`tool_output_pruning_protects_recent_and_bounds_old`、`provider_count_wins_and_every_other_outcome_falls_back`、`summarizer_body_bounds_messages_and_names_archived_outputs`、`durable_state_block_carries_goal_and_open_tasks_verbatim`、`checkpoint_summary_keeps_the_durable_block_within_the_limit`、`anchor_reads_the_newest_usage_event`。

## 验收 2：handle 召回原文 + 摘要保留

持久原文与 handle：

- 裁剪只作用于出站请求，存储历史不动：`context_trigger.rs:528-530`（文档注释）、`tests/context_prune.rs:101-107`（快照含完整 payload、无 elision 标记）。
- 持久 handle 即 `tool_use_id`：elision 标记内嵌 `recall {"tool_use_id":"…"}`（`context_trigger.rs:606`）；摘要摘录把超限工具输出替换为同一 handle（`context_trigger.rs:364`，`SUMMARIZER_MESSAGE_CHARS` :337 让摘要 pass 不重复支付已归档 payload）；operator shell 截断同样命名 handle（`session_shell.rs:267`）。
- 按 handle 取回：`src/recall.rs` —— `Store::archived_output` :62（delegation 子会话经此读委托方归档）、`Store::recall` :84（搜索/handle 双模式）；`archived_window` :130（shell.ended 快路径 + 消息扫描，`SCAN_LIMIT` 1000 带游标）；`output_window` :196（32 KiB 窗口 `ARCHIVE_WINDOW` :9、`next_offset` 翻页、`is_error` 透出）。
- 模型侧工具：原生引擎 `tools.rs:1769`（描述明确 "Pass tool_use_id instead of query to restore the elided middle"），运行时分发 `runtime.rs:2402-2404`。

测试（端到端）：

- `tests/context_prune.rs:168-186`：请求含标记与 handle → 存储历史完整 → `store.recall` 按 `tool_use_id:"call"` 取回，`truncated=false`、`total_bytes=全文`、被裁中段完整返回。
- `context_trigger.rs` 单元 `summarizer_body_bounds_messages_and_names_archived_outputs`：超限输出只以 handle 进入摘要 pass，正文不重复支付。

摘要保留（任务/决定/未完成项/来源）：

- 目标与未完成项逐字进每个 checkpoint：`durable_state_block`（`context_trigger.rs:403`，goal + 未完成 todos，完成/取消项排除；溢出时截摘要保 durable 块）。
- 决定/来源由摘要指令承担：`src/roles.rs:183` 要求保留 objective、constraints、open tasks、verification commands 与结果、精确路径与标识符、decisions、以及被省略输出的 recall handles。

TS 侧（产品/桥接层）：

- 卡片：`packages/tui/src/routes/session/context-settlement.tsx`（`PruningSettlement` 展开实测字节与 payloads/messages，:24 明示 "original output remains available through recall"；`CompactionSettlement` 展示 summary + through 序号）；接线 `packages/tui/src/routes/session/index.tsx:1437-1441`。
- 模式与不伪造：`packages/schema/src/session-context-management.ts:7`（Pruning schema）+ `:25 decodePruning` 跨字段校验（`after>before`、saved 不一致、0 payloads 一律拒绝）。
- 用例：`packages/tui/test/cli/tui/context-settlement.test.tsx:11`（展开实测字节 + 拒绝不一致数据）、`:74`（压缩卡片不虚构 token 节省）；`packages/miao/test/engine/context-settlement.test.ts:50`（durable codec 重放一致）、`:76`（四种坏数据均不伪造 settlement）、`:91`（卡片入 timeline、不入 selected——provider 上下文为空）、`:106`（真实引擎端到端：请求含标记且不含哨兵、快照保留哨兵可召回、实测事实重放；需 `MIAO_ENGINE_BIN`）；`packages/miao/test/engine/native-compact-http.test.ts:8`（压缩经 HTTP 由引擎服务）、`native-context-config.test.ts`（`--context-limits` 配置到达引擎）。

## 验收 3：长任务实测（质量 + 总费用，含摘要成本）

- **真实压缩触发 + 费用（含摘要调用）**：`docs/experiments/2026-10-24-engine-conformance/results.zh.md:13` forced-compaction 双引擎 PASS，场景费用 $0.0056（TS）/ $0.0036（RS）——费用为整场景合计，含触发压缩的摘要调用；:24 RS 侧断言 `engine_compaction` 行数 = 1（`MIAO_CONTEXT_LIMITS={"window":4000,"ratio":0.6,"headroom":1000,"perPass":2}`）。0.3.7 候选复测 `2026-10-25-engine-conformance-v037/results.zh.md:13` forced-compaction 双引擎 PASS (r14)，附 `provenance.json` 与 runs。
- **1M 窗口长链路**：`docs/experiments/2026-10-24-s213-compaction/`（首轮 BLOCKED：投影 2 MiB 上限；#1302 后复测记录）+ `retest-followup.md`（终态：#1310 投影 64 MB/20k 条、#1314 开边界溢出拒绝后关闭边界重试一次，九段链端到端全通，chunk 9 input 148,067）。质量结论按设计语义改写：重读型负载由 elision+recall 承载（请求 ≤470k 未及 900k 触发点，真实压缩不在该链触发，属正确资源行为）；无重读回忆魔咒「失败属设计」——引擎交给模型 handle 而非静默丢失。
- **long-session 质量 + 成本**：`docs/experiments/2026-10-24-long-session-remeasure/README.zh.md` 双引擎各 3/3 通过，native $0.00708 vs TS $0.00995，`results.csv` 保留 billed/cached/output token 拆分（产品参考价口径，非账单）。

语义限定（记录在案，不阻断勾选）：「自然长任务在默认配置下真实越过触发点」的实测以小窗口强制场景承载；默认 1M 窗口链路上真实压缩未自然触发（触发点 900k > 可选历史上限）。如需该口径，需在更大上下文模型或更高密度负载上补测。

## 缺口清单（不阻断，供后续小步 PR）

1. **操作员路径不能按 handle 取回**：引擎 RPC `Command::Recall`（`protocol.rs:358`）只有 `query/limit/before_message_seq`，`host.rs:177-193` 固定 `tool_use_id: None, offset: 0`；`http.rs` 无 recall 路由；TUI 无恢复 UI（仅裁剪卡片文案提示）。模型路径不受影响。建议：`Command::Recall` 增加可选 `tool_use_id`/`offset` 字段（serde default，向后兼容）并在 host 透传 `Store::recall`。
2. **TS 引擎路径 recall 为纯子串搜索**：`packages/core/src/tool/recall.ts:17` 的 Input 无 `tool_use_id` 模式（原生引擎工具已支持）。原生为默认引擎；若 TS 路径保留则需要同等 handle 语义。
3. 验收 3 的语义限定见上节。

## 关联实现 PR（均已合入 main）

| PR | commit | 内容 |
| --- | --- | --- |
| #1280 | eb67c03a46 | 压缩后首个请求骑 restore budget 注记 |
| #1294 | 21b86e1b86 | native turn 用量在每条投递路径计价并持久化（费用实测的前提） |
| #1302 | ebaf9efffa | run 路径为操作员路由模型派生压缩预算 |
| #1307 | c41a54fd4d | §2.13 验收实测记录（s213 目录） |
| #1310 | bbc32b11a5 | 快照/分叉投影上限提升到 64 MB/20k 条 |
| #1314 | f4c8b7c46c | 开边界溢出拒绝后关闭边界重试一次 |
| #1404 | abafb875de | 持久化实测工具输出裁剪事实（`context.pruned`） |
| #1414 | 90449745e5 | 拒绝扩张型裁剪（裁后必须更小） |

关联 issue（背景）：#1285（run 路径组合 NativeEngine layer）、#1267（Gemini/Anthropic 实测凭据）。
