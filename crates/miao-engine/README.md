# miao-engine（实验性 Rust M0 引擎）

独立入口，使用显式指定的独立 SQLite 数据库。当前实现提供 durable inbox、事务事件/消息投影、
受监督的 Session 执行、Anthropic Messages / OpenAI Chat / OpenAI Responses 流式 adapters、受控 `read_file` / `list_files`、审批受控的 `write_file` / `edit_file`、stdio 和 committed JSONL 导出。
这是 M0/M1 增量实现，尚未达到替代现有 miao 的完整能力门槛。

## 运行

在构建环境执行：

```sh
cargo build --manifest-path crates/miao-engine/Cargo.toml
./crates/miao-engine/target/debug/miao-engine --version
./crates/miao-engine/target/debug/miao-engine serve \
  --db ./engine-local.db --workspace ./example --model YOUR_MODEL
```

`serve` 默认选择 Anthropic，读取 `ANTHROPIC_API_KEY`，endpoint 为 `https://api.anthropic.com/v1/messages`。
使用 `--provider openai-chat` 读取 `OPENAI_API_KEY`，endpoint 为 `https://api.openai.com/v1/chat/completions`；
使用 `--provider openai-responses` 同样读取 `OPENAI_API_KEY`，默认 endpoint 为 `https://api.openai.com/v1/responses`。
公开 API profile 接受 key credential；订阅 profile 通过 subscription-responses 使用现有 OAuth snapshot 与账户路由。独立登录/refresh 暂未实现，已有 broker 保持唯一刷新写者。
`--endpoint URL` 可显式指定兼容 endpoint。provider stream 没有独立配置 Session、工具或数据库的权力。
版本读取根 `package.json`，不把 crate 内部版本用作产品版本。

## stdio 协议 v0

一行一个 JSON 对象。请求带字符串/数字 `id`，响应带同一个 `id` 与 `result` 或 `error`。
通知不带请求 id。当前只支持本地 stdio，不声明 ACP 或现有 miao HttpApi 兼容。

```jsonl
{"id":1,"method":"subscribe","params":{"session_id":"s","after":0}}
{"id":2,"method":"admit","params":{"input":{"session_id":"s","input_id":"p1","prompt":"Read README.md and summarize it","delivery":"steer"},"resume":true}}
{"id":3,"method":"events","params":{"session_id":"s","after":0}}
{"id":4,"method":"cancel","params":{"session_id":"s"}}
{"id":5,"method":"shutdown"}
```

其他方法：`resume`（显式启动既有历史的续跑）、`unsubscribe`（停止指定 Session 通知）。
`admit.resume=false` 仅 durable admission。`cancel` ack 表示已接受取消，真正停止由 `run.finished` 记录。
`events` 每页最多 100 条，使用最后 `seq` 继续分页。

- `event` 通知是 SQLite 已提交的 canonical event，包含 Session 与 cursor。
- `progress` 通知是临时 provider frame，不承诺 crash 后保留；完整消息提交后可用 events 重建。
- 慢进度消费者可能收到 `resync`；stdio 输出队列满时终止连接，重新启动/重连后读取 committed events。
- 订阅轮询 durable cursor，不依赖临时通知进行 replay→live 交接，没有双源 handoff 丢事件窗口。

## SQLite 与 JSONL

SQLite WAL/FULL 是唯一 durable authority。inbox、canonical events、message projections、执行记录、
工具 dispatch/settlement 状态在专用 SQLite worker 上写入，控制 executor 不做 blocking SQLite IO。
OS lease 由同一 worker 持有；同路径第二个 runtime 不能启动。独立 engine application ID/schema version
阻止误用现有 miao 数据库或不支持的未来 schema。

JSONL 从 committed snapshot 导出，无需 provider key，可与活跃 runtime 并行读取：

```sh
./crates/miao-engine/target/debug/miao-engine export \
  --db ./engine-local.db --session s --after 0 > session.jsonl
```

export 不创建缺失数据库、不改变执行状态、不承担第二份权威日志。read transaction 固定高水位；
非常慢的外部导出会延长 SQLite snapshot/WAL 保留，长期分析优先从导出文件读取。

## 执行不变量

- 相同 input id 按 Session、prompt、delivery 全量 exact retry；冲突不生成额外 admission。
- pending exact retry 可以修复丢失 advisory wake；promoted exact retry 不重播 provider work。
- steer 在安全 provider-turn 边界批量提升，queue 仅在执行将 idle 时提升一条；新输入重置 turn allowance。
- 同 Session 串行执行，跨 Session 可并行；M0 上限为 64 attached Sessions、8 active executions、每次输入 allowance 25 provider turns。
- actor 控制循环能在 provider 等待期间响应 cancel；tasks 在 shutdown 被取消并 join。
- 相同工具名/input/result 累计 3 次且没有新用户输入时记录 `loop.detected` 并停止；新输入重置计数。该检测不宣称识别所有语义循环。
- provider panic 仅 reconcile 当前 Session；慢临时进度消费者不阻塞执行，其他 Session 不受该故障影响。
- 完整 assistant/tool-call projection 与 planned intents 同事务；授权通过后才记录 dispatched；tool settlement 与 tool-result projection 同事务。
- Location 与 admission 同事务绑定，同 Session 不会因换启动 workspace 而静默迁移。
- pending 审批绑定 Session/run/call、Location、resource、完整 input hash、policy revision 与期限；本地 stdio controller 才可答复。
- 审批等待不占控制循环，cancel 后晚到答复失效；未派发的工具恢复为 not_executed，派发后未知结果才标 unknown。
- startup 不自动续跑；未结算 dispatch 标为 unknown，补错误 tool-result 修复历史，不重做外部操作。
- pre-response transport/429/特定 5xx 有最多 3 次、60 秒总预算的 retry；200 body 开始后不透明重播。
- provider SSE 支持 bytewise UTF-8、CRLF、多行 data；frame 1 MiB/message 8 MiB 上限。
- 半截工具 JSON、缺少 terminal、未知 hosted/thinking blocks 和不可支持的 finish reason 均明确失败，不 dispatch 不完整工具。
- Responses 以 response.completed 的完整 output 结算，并原样保留 encrypted reasoning item；opaque blocks 只回送相同协议/模型，跨协议或模型显式拒绝，不静默丢弃。

## 验证

```sh
cargo fmt --manifest-path crates/miao-engine/Cargo.toml --check
cargo test --manifest-path crates/miao-engine/Cargo.toml
cargo clippy --manifest-path crates/miao-engine/Cargo.toml --all-targets -- -D warnings
```

测试包括三种协议的真实本地 HTTP fixture→runtime→文件工具→后续模型轮次闭环，Chat usage/DONE/工具参数分片与拒绝处理，
真实本地 HTTP fixture adapter、200 断流不重试、工具参数截断、capacity retry、
workspace 越界/大文件、exact retry/lost wake、cancel/跨 Session、unknown 恢复、原子 settlement、
stdio 请求和只读导出高水位。测试不消费 live provider credentials；不把 fixture 通过称为真实模型质量验收。

## 后续能力（当前未实现）

完整 coding tools/PTY、后台进程与任务、Windows 进程 enforcement、ACP/HTTP/TUI adapters、Gemini/Bedrock 等其他 provider、
独立 OAuth refresh broker、LSP/媒体、Context Epoch/compaction、MCP/TS compatibility worker、完整黑匣子与三平台运行验收。
`read_file` 当前是 canonical containment 的只读工具，最多 32 KiB UTF-8；`list_files` 仅列立即子项，最多 500 个，不递归不跟随子项 symlink；不宣称能抵抗 workspace 内的恶意并发路径替换。
默认 read_only 不暴露写入工具；workspace 模式暴露 write_file/edit_file 并默认逐次审批，或使用显式 allow/deny 路径规则。显式开启 allow_process 后可使用前台沙箱进程；其数据库必须位于 workspace 外。


## 权限配置与条件文件提交

`serve --policy PATH` 读取限额内的 JSON 配置；模式/规则/审批期限形成 policy revision。
默认 read_only。workspace 写入默认 ask，不因工具已出现在目录里就跳过 leaf 权限。

```json
{"mode":"workspace","approval_timeout_ms":60000,"rules":[{"tool":"write_file","path":"generated/**","decision":"allow"},{"tool":"*","path":"secrets/**","decision":"deny"}]}
```

收到 `approval.requested` 后通过本地 stdio 的 `approve` 方法回复其 input_hash/policy_revision；
响应 decision 只能 allow/deny，不能提交一个自己声称的 controller role。controller capability 由 adapter 持有。

```jsonl
{"id":10,"method":"approve","params":{"session_id":"s","response":{"request_id":"REQUEST_ID","input_hash":"INPUT_HASH","policy_revision":"POLICY_REVISION","decision":"allow"}}}
```

- read_file 返回 text 与 sha256；write_file 对现存文件要求该指纹，expected_sha256=null 只创建不存在的文件。
- edit_file 需要指纹，执行精确匹配；歧义需 replace_all=true。不自动改 BOM/行尾，保留现有权限。
- 文件内容/结果最多 32 KiB；不自动创建父目录，不通过最终 symlink 写入。
- 文件发布通过 cap-std 目录 capability，暂存 fsync 后发布，创建采用原子 no-clobber。
- 当前 registry 的写入串行、读取共享；既有文件对其他 runtime/非协作外部 writer 的指纹复核是乐观检查，不宣称通用原子 CAS。
- 已开始的文件提交必须 join/settle，不会因取消丢弃；失败/取消前后的外部副作用仍以 durable dispatch/settlement 核对。
- Unix 同步父目录；Windows 文件/目录 durability 与整个平台运行仍需专门验收。


## 前台进程与沙箱

配置 `mode=workspace` 且 `allow_process=true` 才暴露 run_command；默认 ask。
`process_network=false` 默认禁止网络，不接受模型在工具参数里提权。模式/能力/规则形成同一个 policy revision。

```json
{"mode":"workspace","allow_process":true,"process_network":false,"rules":[]}
```

run_command 接受显式 argv、workspace 内 cwd、1..120000ms timeout；没有隐式 shell。
stdout/stderr 各最多 32 KiB，超限停止进程。超时/取消回收普通进程组并 join/reap 管道读者，记录终止原因。
前台工具不宣称支持脱离进程组的恶意 daemon 生命周期；后台任务/cgroup/Job ownership 后续接入。

- macOS：seatbelt workspace-write profile；路径按字符串转义，不能插入策略语法；网络策略限制通信而非要求 socket 对象创建失败。
- Linux：fresh runner 在 Tokio 初始化前应用 Landlock ABI v3 的完整 filesystem rights；禁网时附加继承的 seccomp socket filter。
- 不支持或无法应用 enforcement 时失败，不回退成裸进程。Windows 当前不暴露该能力。
- 两者目前都允许全局读取；workspace-write 不是秘密读取隔离。macOS 兼容系统 temp/dev 写许可，Linux 仅 workspace/job temp 与 /dev/null；差异按实际 profile 描述。
- launcher 清空环境，只传 PATH/HOME/locale/TERM 与 job temp，不向子命令传 provider keys。
- 开启进程时强制 authority DB 位于 workspace 外；文件工具也保护 DB/WAL/SHM/lease 路径。
- 文件已发布后若父目录同步失败，返回 applied=true、durability=unknown 的已应用结果；不伪装成无副作用失败。

验证状态：macOS arm64 与 Linux x86_64，engine 75 个测试及 sandbox 6 个测试、严格 clippy、fmt 均通过。
真实 stdio→HTTP fixture→沙箱命令验证了 argv 执行、provider key 隔离与 durable settlement；非 live 模型质量验收。


## Session 快照、分支与 Context Epoch

```jsonl
{"id":20,"method":"snapshot","params":{"session_id":"s"}}
{"id":21,"method":"fork","params":{"session_id":"s","target_session_id":"branch"}}
{"id":22,"method":"context","params":{"session_id":"s","epoch":1}}
```

snapshot 在一个事务里返回 committed cursor、Location、messages（含 seq）、pending previews、active_run、pending approvals 与当前 context metadata。
投影上限 1000 条/2 MiB、总快照 4 MiB；超限显式失败，可使用 events 分页，不默默丢历史。

fork 使用 target_session_id 对账 exact retry。活动 parent 需显式 message_seq，且不能选 unresolved tool-call 边界。
它只复制闭合 conversation prefix、Location 和对应 Context Epoch；不复制 inbox、审批、任务、外部副作用或文件，不自动唤醒。
分支目前共享同一 Location filesystem；不是独立 worktree，不提供文件回滚。

每个 provider turn 边界装配稳定 baseline 与 workspace AGENTS.md。自动加载遵守 read policy、workspace/保护资源边界与大小限制；
ask/deny 来源不会未经授权进入 system。Context Epoch 存准确的 system、source metadata 和 fingerprint；不把会变动的文件路径当成历史内容。
内容与来源未变则复用 epoch；变化追加不可变 epoch，provider.started 关联它；fork 按 message checkpoint 继承当时的 epoch。
system 不嵌入 Session/run 的易变 ID，三个 adapters 分别映射到其原生 system/instructions 输入。
当前只实现 workspace producer；祖先/用户 instructions、skills/references/persona、完整上下文选择与压缩仍待接入。


## 只读凭据兼容与订阅 profile

```sh
miao-engine credentials --credential-db /path/to/miao.db
miao-engine credentials --auth-file /path/to/auth.json
miao-engine serve --db /path/to/engine.db --workspace /path/to/project --model MODEL \
  --provider subscription-responses --credential-db /path/to/miao.db \
  --credential-id cred_ID --credential-integration openai
```

- discovery 只输出 id/integration/label/kind/expiry，不序列化 token、refresh 或账户字段。
- source 只读解析现有 credential 表或 legacy auth.json，不创建缺失库、不迁移、不写回。
- 显式 credential-id 还需匹配 integration，协议兼容服务可用 credential-integration 明确绑定；不猜测跨 provider 凭据。
- 每个 provider turn 重新读取 source，可跟随既有 broker 的 token 轮换；过期 snapshot 明确失败，不竞争刷新。
- 默认环境变量来源继续可用；订阅 profile 使用 OPENAI_ACCESS_TOKEN 与可选 OPENAI_ACCOUNT_ID。
- API-key/OAuth 类型与所选 profile 不兼容时，发请求前拒绝；redirect 关闭，不把 token 发向跳转地址。
- 凭据文件/DB 作为 protected resources 排除于 leaf 工具与自动 context；进程启用时 source 必须在 workspace 外。
- workspace-write 不提供全局秘密读取隔离；已明确批准的任意进程仍具有 profile 描述的读取能力。
- 当前只读 bridge 并非完整 credential broker：device login、独立 refresh/rotation 锁、跨 broker 迁移与 live 账户任务验收仍待完成。


## Durable 后台任务

`mode=workspace, allow_process=true, allow_background=true` 才暴露 start_job/job_status/cancel_job。
start_job 的完整 argv/cwd/timeout 仍经权限和绑定审批；返回 durable queued job_id，不等同已执行成功。
当前每 runtime 最多 32 活跃/排队 jobs、2 个执行槽，命令仍使用前台大小/120s 超时与 bounded output。

```jsonl
{"id":30,"method":"jobs","params":{"session_id":"s"}}
{"id":31,"method":"job","params":{"session_id":"s","job_id":"JOB_ID"}}
{"id":32,"method":"cancel_job","params":{"session_id":"s","job_id":"JOB_ID"}}
```

- turn cancel 不取消已受理的 background job；job cancel/runtime shutdown 才控制其生命周期。
- queued/running/terminal/result 持久化；恢复把 queued 标 interrupted、running 标 unknown，不自动重跑。
- 同一 dispatched tool intent 的 job admission exact retry 不生成第二个任务，且输入必须一致。
- model job control 绑定当前 Session，不因知道 UUID 就能查询/取消另一个 Session 的任务。
- background 是显式外部 writer，不持有 foreground registry 的全程文件锁；条件编辑对它仍是乐观指纹检查。
- guardian 保持私有 pipe lifeline；engine 硬退出关闭它，普通进程组被回收。用户命令 stdin 仍为空，不能接触控制管道。
- 恶意 setsid/独立 daemon 仍需后续 cgroup/Job ownership；当前不是全平台持久进程托管服务。
