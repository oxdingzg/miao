# CodeCompanion ACP 编辑器验收（2026-10-25）

第二个实际编辑器已有候选产物通过记录：Neovim 0.12.6 + CodeCompanion 20.0.1 连接产品 `miao acp`，后端使用 Rust 引擎。同一份未变更的 0.3.7 集成产物上，三项顺序 UI 操作通过。测试使用实际审批界面与普通模式按键，没有用 ACP SDK 测试客户端替代编辑器，也没有直接伪造审批回复。

| 场景 | 实际界面操作 | 结构验证 | ACP／持久化结果 |
| --- | --- | --- | --- |
| 允许一次 | 出现 Approval Required 后按 `g2` Accept | 审批前没有 `allowed.txt`，之后内容恰为 `approved` | selected `once`；`end_turn`；原生运行 `completed` |
| 拒绝 | 出现审批后按 `g3` Reject | 未产生 `denied.txt` | selected `reject`；`end_turn`；原生运行 `completed` |
| 取消 | 开放流式响应中按 `q` | 上游流收到取消 | 实际发出 `session/cancel`；返回 `cancelled`；原生运行 `interrupted` |

通过 CodeCompanion 的 chat API 创建对话，再使用其真实 UI 键位操作。模型是受控本地服务，分别请求工作区命令或保持流不结束，没有使用真实服务商凭据。HOME／XDG、产品数据库、原生存储和工作区均隔离。

实际执行 `:qa!` 后，该测试的编辑器、产品代理和引擎进程全部退出，没有运行中的原生任务。随后核对 PID 与工作目录并关闭测试模型服务；没有清理其他会话或进程。

[结果与产物摘要](../../../docs/experiments/2026-10-25-codecompanion-acp/results.json)、[界面记录](../../../docs/experiments/2026-10-25-codecompanion-acp/ui/allow-before.txt)、[协议记录](../../../docs/experiments/2026-10-25-codecompanion-acp/raw/allow.agent.jsonl)及[退出核对](../../../docs/experiments/2026-10-25-codecompanion-acp/teardown.json)均保留，测试路径已归一化。源码检查点为 `95fc78a62a`；CodeCompanion 与 plenary 的精确提交记录在结果文件中。

较早失败另行保留：一次混用 V1 权限字段与 V2 provider，导致默认模型选择失败，已改为纯 V2 测试配置；另一次超过现有 60 秒审批期限才操作，命令未执行。这两次没有算作通过。选定的三项运行验证了及时接受、拒绝和取消。

这是实际编辑器上的自动化交互与候选集成产物验收，不替代最终合并产物、真实服务商／额度／自然到期凭据验收，也没有完成后续 Rust 迁移。没有宣称新增一次人工点击验收，没有发布版本。

较早 R10 产物的三项 UI 操作虽完成，但严格协议验证失败：后台标题日志混入 ACP stdout。原始字节作为 `.stdout.txt` 保留，没有伪装成有效 JSONL。选定的 R11 产物包含 PR #1431 的日志边界修复，重跑三项操作的全部 25 个 agent 帧均为有效 JSON-RPC，退出后再次确认没有该测试遗留的进程或运行中任务。
