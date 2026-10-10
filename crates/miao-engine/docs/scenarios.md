# M0/M1 scenario map

Every scenario runs against deterministic provider fixtures (a local TCP
endpoint), so it is reproducible without a network or a live model. File paths
are relative to `crates/miao-engine/tests/`.

## M0b gate — deterministic and fault scenarios

| # | Scenario | Test |
|---|---|---|
| 1 | Lost ack is an exact retry; conflicts do not change history | `store.rs::lost_ack_is_exact_retry_and_conflicts_do_not_change_history` |
| 2 | Turn cancel while the provider waits does not block other sessions | `runtime.rs::cancellation_is_handled_while_provider_is_waiting_and_does_not_block_other_sessions` |
| 3 | A lagging progress subscriber does not block completion | `supervision.rs::lagging_progress_subscriber_does_not_block_completion` |
| 4 | Replay to a watermark, then live, has no gap or duplicate (handoff) | `store.rs::replay_to_watermark_then_live_has_no_gap_or_duplicate` |
| 5 | Crash reconciliation keeps dispatched-unsettled work `unknown`, no replay | `supervision.rs::crash_reconciliation_preserves_unknown_running_state_without_replay` |
| 6 | A second runtime is refused by the store lease; recovery never repeats dispatch | `store.rs::lease_rejects_second_runtime_and_recovery_never_repeats_dispatch` |
| 7 | Cancel while an approval waits invalidates a late reply without dispatch | `approval.rs::cancel_while_waiting_invalidates_late_response_without_dispatch_or_unknown` |
| 8 | An admitted background job survives turn cancel | `jobs.rs::admitted_job_survives_turn_cancel_and_instruction_reads_do_not_wait_for_it` |
| 9 | Interrupted committed tool calls get `unknown` results without a rerun | `runtime.rs::interrupted_committed_tool_calls_have_unknown_results_without_rerun` |
| 10 | Exact retry repairs a pending wake but never replays promoted work | `lost_wake.rs::exact_retry_repairs_pending_wake_but_never_replays_promoted_work` |
| 11 | Headless stdio and `export` describe the same committed ledger end to end | `m0_acceptance.rs::headless_stdio_and_export_describe_the_same_ledger` |

## M1 direction — coding-workflow scenarios

The M1 gate tracks 30–50 scenarios plus a real small fix. Existing coverage that
counts toward it includes conditional writes (`mutations.rs`), V4A patch
transactions (`apply_patch.rs`), sandboxed process execution, descendant reaping
and pty allocation (`process.rs`, `guardian.rs`, `bash.rs`), approval binding and
cancellation (`approval.rs`, `permission.rs`), provider fallback with a shared
retry budget (`routing.rs`), opaque-reasoning preservation (`responses.rs`), and
MCP cancellation (`mcp.rs`). A headless end-to-end acceptance drives a small real
fix (read -> apply_patch -> bash verification) through the durable run loop
(`small_fix.rs`), inline image attachments are lowered into each provider's wire
format (`media.rs`), and the language-server tools answer diagnostics, definition
and references over an injected transport (`lsp.rs`), and a `task` tool delegates
to a child Session with lineage and resource limits (`subagent.rs`). No M1
capability gaps remain; remaining work is hardening and evaluation.

## M2 gate — compression / recovery / fork / rewind

| Scenario | Test |
|---|---|
| Compaction requires a closed assistant boundary; an open/active boundary is refused | `checkpoint.rs::active_or_open_tool_boundaries_cannot_be_compacted` |
| Snapshot and fork inherit only state at the selected checkpoint | `checkpoint.rs::snapshot_and_fork_inherit_only_state_at_the_selected_checkpoint` |
| Dynamic state survives compaction and reloads without changing the system epoch | `checkpoint.rs::dynamic_state_survives_compaction_and_reloads_without_changing_system_epoch` |
| Rewind requires an idle Session (a busy run is refused, not corrupted) | `session_rewind_faults.rs::rewind_requires_an_idle_session` |
| Rewind survives store recovery; fork excludes reverted messages; unrevert restores across recovery | `session_rewind_faults.rs::rewind_survives_recovery_and_fork_excludes_reverted` |
| Recovery closes orphaned requests without execution or messages | `supervision.rs::recovery_closes_orphaned_requests_without_execution_or_messages` |

### 双 sidecar 协议验证

`two_engines.rs` 由一个客户端测试进程启动并 attach 两个独立 Rust engine，使用相同 Session/input ID 验证 engine 维度隔离。

- 执行真实 provider HTTP fixture → `read_file` → 后续 provider turn，比较工具 catalog、工具结果和快照中的可见消息/模式/上下文。
- 提交后主动丢弃应用层 ack，重试必须返回同一 admitted cursor，只留下一个 pending input。
- 105 次状态操作强制 ledger 分页；重放订阅再续跑，通知必须逐条等于完整 durable ledger，不先去重掩盖重复。另一 engine 的状态/cursor/消息不变。
- 用 192 KiB 输入产生大通知，暂不读取 A 的 stdout。B 必须完成；只读 SQLite 观察还须证明 A 自己的 run 已持久完成，再恢复读取并核对完整 ledger。
- 每个等待有超时，stdio 错误立即失败，进程须正常关闭。

这是双 Rust sidecar 的协议级证据，不等于现有产品 TUI 已完成 TS/Rust 双后端切换。客户端投影/交互不退化仍由门面产品级 E2E 验证。
