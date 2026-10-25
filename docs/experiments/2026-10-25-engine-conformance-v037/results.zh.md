# 0.3.7 候选版本双引擎一致性验证（2026-10-25）

完整 R14 在同一份未变更、包含完整 Web UI 的 CLI／引擎配对候选产物上通过 **23/24**，失败 1、跳过 0。results.json 选择全部最新单元结果。

最新未通过项：permission-deny / rust: deleteme.txt was deleted despite the deny rule。

| Scenario | TypeScript | Rust |
| --- | --- | --- |
| tool-recall | PASS (r14) | PASS (r14) |
| file-edit | PASS (r14) | PASS (r14) |
| apply-patch | PASS (r14) | PASS (r14) |
| multi-turn-retention | PASS (r14) | PASS (r14) |
| forced-compaction | PASS (r14) | PASS (r14) |
| interrupt-recovery | PASS (r14) | PASS (r14) |
| background-job | PASS (r14) | PASS (r14) |
| mcp-fixture | PASS (r14) | PASS (r14) |
| permission-deny | PASS (r14) | FAIL (r14) |
| usage-priced | PASS (r14) | PASS (r14) |
| session-title | PASS (r14) | PASS (r14) |
| image-input | PASS (r14) | PASS (r14) |

R14 的 Rust 权限单元中，两次 rm 均被正确拒绝；模型随后使用该测试策略允许的 apply_patch 删除文件。保留此次失败。此处测试指令应明确要求拒绝后停止，才能单独验证命令级规则；现有记录不能证明权限匹配被绕过。

每个单元显式指定 --engine、--dir，隔离产品数据库和原生存储。原生完成状态、用量与标题读取实际持久化记录，不能因中断命令退出码为零而判通过。Rust 强制压缩还要求 engine_compaction 记录；TS 压力场景只验证完成，不证明发生 TS 压缩。主模型是 zhipuai-coding-plan/glm-5.3-flash，图片场景使用 glm-4.6v。

源码检查点为 599f279a785833d2b8bf152fcff7067a526ecf21。相较 R7，本次产物加入原生路由兼容检查、协议日志修复、MCP 原始身份保留、间接工具调用审批绑定、生命周期钩子取消、等待标题完整写回的协调修复，以及最终紧凑排队状态布局。provenance.json 记录产物摘要与修复提交；凭据只通过进程内存传递，公开证据中的私有测试路径已归一化。

完整 R13 仍为 **23/24**：原生命令正常退出后标题仍是默认值，促成 #1438 的标题生成／写回协调修复。完整 R14 之前，同一新产物的原生标题单项复验通过，单独保留，没有替换进完整矩阵。

此前完整 R7 仍为 **23/24**：TS 工具调用单元直接回答提示中已有的 token，未执行要求的 bash 命令。同一冻结产物的单项重试通过，但没有替换最初失败。R2–R6 与各自限制也继续保留。本次是一次新的完整运行，没有拼接较早通过项。

R14 主模型轮次参考成本为 $0.05058853966，不含辅助标题调用，也不是订阅实付费用；视觉模型目录缺价记零，不代表免费。

同一 R14 产物的真实原生 TUI 已验证 120／42 列：常规运行与排队保持三行、空闲两行，阶段及排队计时持续更新，一次 Esc 移除待处理输入，再次 Esc 取消请求并持久化 interrupted。此前 R13 的两个原会话隔离副本在 200／42 列正常显示标题与未发送输入，原始及副本事件／运行数量保持 2158／9、1955／10，没有隐式执行旧任务。这些界面验证独立于模型矩阵。另有编译 R12 的严格 ACP 协议验证，以及 R11 实际编辑器接受、拒绝、取消的[完整记录](../2026-10-25-codecompanion-acp/results.json)。

这仍是候选集成产物。最终 main 产物、App UI、最终跨平台升级、外部服务商／额度／自然到期凭据，以及后续 Rust 迁移仍是独立关口。本次验证没有发布版本。
