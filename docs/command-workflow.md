# Slash-command execution / 斜杠命令执行

## English

`Session.command` snapshots the configured command template and its selected agent/model into one durable Session input. The optional message `id` reconciles an exact retry of the same Session, command name and arguments; conflicting reuse fails. Admission does not execute template shell substitutions or read referenced files. `resume: false` admits only.

At a safe runner boundary, the promoted user message receives a durable command-started receipt before preparation. The runner expands `!` followed by a backtick-delimited shell command through the same authorized shell executor as the Bash tool, including configured shell, `shell.env`, timeout, cancellation, sandbox and capture limits. Shell results are recorded as visible Shell messages; they are not fabricated model tool calls. Their output is included in the prepared prompt, so these auxiliary records are not sent to the provider twice.

`@file` references use Location path containment, external-directory approval and read permission before content ingestion. Regular files are read through a scoped, bounded handle; each file is limited to 1 MiB and prepared text plus file bytes to 4 MiB. Directory previews show at most 200 entries. Known `@agent` names become agent mentions. A command accepts at most 32 shell substitutions and 32 references. Preparation failures are explicit and retain the original command receipt.

Commands targeting a subagent run as subtasks unless `subtask: false` is configured; `subtask: true` also requests a subtask explicitly. Delegation requires the parent's task permission. The child receives the prepared prompt and attachments, and its result is recorded back on the parent's command message. The parent's agent/model are not switched. Nested command subtasks are refused. Ordinary commands apply their configured agent/model at preparation's safe boundary.

Completed preparation is not repeated on continuation or exact retry. A started receipt without a completed result is ambiguous after interruption/crash: explicit resume records failure rather than replaying its side effects. This is not general automatic provider/tool crash recovery or an exactly-once guarantee for external effects.

App and TUI update the existing promoted message as receipts arrive; they do not append duplicate user prompts. The durable original admitted input remains available for retry reconciliation.

## 简体中文

`Session.command` 将配置中的命令模板及所选 agent/model 快照保存为一条持久化会话输入。可选消息 `id` 用于核对同一会话、命令名和参数的精确重试；冲突复用会失败。准入时不执行模板中的 shell，也不读取引用文件。`resume: false` 仅准入。

runner 在安全边界提升输入后，先写入持久化的命令开始记录，再准备命令。以 `!` 和反引号包裹的 shell 命令复用 Bash 工具的授权执行边界，包括配置 shell、`shell.env`、超时、取消、沙箱和输出捕获限制。shell 结果作为可见 Shell 消息记录，不伪造模型工具调用。输出已进入准备后的 prompt，因此这些辅助记录不会重复发送给模型。

`@file` 引用遵守 Location 路径限制，并在内容读取前完成外部目录授权和 read 权限检查。普通文件通过有界、作用域化的句柄读取；单文件上限为 1 MiB，准备后的文本与文件字节总量上限为 4 MiB。目录预览最多显示 200 项。已知 `@agent` 名称转为代理引用。单个命令最多包含 32 个 shell 替换和 32 个引用。准备失败会明确记录，并保留原命令事实。

指向 subagent 的命令默认作为子任务运行，除非配置 `subtask: false`；`subtask: true` 也可显式请求子任务。派发需要父会话的 task 权限。子会话接收准备后的 prompt 和附件，结果写回父会话原命令消息；父会话的 agent/model 保持不变。嵌套命令子任务会被拒绝。普通命令在准备阶段的安全边界应用配置的 agent/model。

准备成功后，续跑或精确重试不会再次执行准备副作用。中断或崩溃后若只有开始记录、没有完成结果，其结果视为未知；显式恢复会记录失败，不自动重放副作用。这不代表通用的 provider/tool 崩溃自动恢复，也不承诺外部副作用严格只执行一次。

App 和 TUI 根据记录更新原已提升的消息，不追加重复用户 prompt。原始持久化准入输入保留，用于重试核对。
