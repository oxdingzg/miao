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

使用 `--http 127.0.0.1:PORT` 启用 loopback HTTP 控制面，复用同一命令表（`POST /rpc` 与 `GET /events` SSE 事件流，revision `engine-http-0`）；认证用 bearer token，取自 `--http-token` 或 `MIAO_ENGINE_HTTP_TOKEN`，缺省时启动生成并打印到 stderr。非 loopback 地址被拒绝，TLS 交给本地反代。

`acp` 模式在 stdio 上提供 ACP（newline-delimited JSON-RPC 2.0），供编辑器直接对接：`miao-engine acp --db PATH --workspace PATH --model MODEL [--provider ...] [--endpoint URL] [--policy PATH]`。当前实现 `initialize`/`authenticate`/`session/new`/`session/prompt`/`session/cancel`，把引擎审批映射为 `session/request_permission` 往返，把已提交的工具调用流式推送为 `tool_call`/`tool_call_update`，支持 `session/load`（历史回放）/`session/fork`/`session/resume`/`session/close`/`session/set_mode`，并把已提交的 todos 推送为 `plan`，支持 `session/list`；config/usage 更新为后续切片。

本地安装（不触碰 release 管理的 `miao` 与 `miao-preview`）：在构建机编译后 `./script/install-engine.sh --binary /path/to/miao-engine`。安装到 `~/.local/bin/miao-engine`（版本化于 `~/.local/share/miao-engine/bin`），保留一次旧版本用于一步回滚，并以 `--version` 冒烟。

## stdio 协议 v0

一行一个 JSON 对象。请求带字符串/数字 `id`，响应带同一个 `id` 与 `result` 或 `error`。
通知不带请求 id。当前支持本地 stdio、loopback HTTP 控制面（含 SSE 事件流），以及 ACP stdio adapter（核心会话生命周期，见 PROTOCOL.md）；不声明与现有 miao HttpApi 兼容。

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

完整 coding tools/PTY、后台进程与任务、Windows 进程 enforcement、ACP session/list 与 config/usage 更新、TUI adapters、Gemini/Bedrock 等其他 provider、
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

验证状态：macOS arm64 与 Linux x86_64，engine 127 个测试及 sandbox 6 个测试、严格 clippy、fmt 均通过。
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


## 历史选择与显式压缩 checkpoint

```jsonl
{"id":40,"method":"history","params":{"session_id":"s","selected":true}}
{"id":41,"method":"compact","params":{"session_id":"s","compaction_id":"CHECKPOINT_ID","through_message_seq":42,"summary":"已完成的工作、约束与后续目标摘要。"}}
```

compact 是本地 controller 的显式投影操作：Session 必须 idle，边界必须是闭合的完成 assistant message。
相同 checkpoint id 对账 Session/cutoff/summary；冲突失败，不向后倒退。raw messages/events 不删除。
provider 使用 summary+tail 的 selected_history，仍保留 opaque/tool records 的完整未压缩 tail；过大窗口显式报 budget 错误。
验证通过流式检查，允许把已超过选择预算的旧前缀压成 checkpoint；摘要最多 32 KiB。
default fork 继承当前有效 checkpoint 并映射 message cursor；显式历史 fork 只继承该点已经存在的 checkpoint。
这不是自动 LLM 摘要或任务质量承诺；自动策略、模型角色路由与上下文质量评测仍需后续实现。


## MCP stdio client（显式外部 authority）

通过 `--mcp-config /absolute/path/servers.json` 指定 workspace 之外的 host 配置：

```json
[{"name":"local_service","argv":["/absolute/path/to/server","--stdio"],"env":{}}]
```

permission policy 必须设置 `mode: "workspace"`、`allow_mcp: true`。启动 server 是 host 配置行为；
MCP server 是拥有自身 filesystem/network authority 的可信外部服务，不适用 `run_command` 的 workspace sandbox。
每次工具调用仍经过已有 durable intent 与绑定审批；默认 ask，可用 `mcp_*` tool matcher 和
`@mcp/local_service/**` resource matcher 配置规则。`readOnlyHint` 不授予权限。

- catalog 在初始化时固定：最多 8 servers、每 server 4 页/128 tools；alias 稳定、限 64 字符且包含原名指纹。
- schema 最多 32 KiB，JSON Schema 校验在授权及派发之前完成；description 最多 4 KiB。
- 初始化/catalog 每请求 15 秒，call 60 秒，wire frame 256 KiB，返回结果 64 KiB。
- input/task continuation 显式失败；断连/超时不自动重放，不能断言外部副作用未发生。
- cancel 停止本地等待，已派发调用可能仍在 server 执行；Session 恢复沿用 unknown intent 边界。
- 正常 shutdown 关闭 transport 并 kill/reap 配置的直接子进程。引擎硬退出、server 派生/daemon 进程
  尚无完整跨进程归属保证。

目前未实现远程 HTTP transport、动态 catalog notifications、resources/prompts、MCP OAuth 或 TS plugin compatibility。


## 显式 workspace Context Sources

`--context-config /absolute/path/context.json` 选择附加 instruction/persona 文件：

```json
[{"label":"persona","path":"docs/persona.md"},{"label":"team-rules","path":"docs/team-rules.md"}]
```

配置位于 workspace 之外，内容路径必须是 workspace 相对路径。最多 16 个附加 source；
label 使用限 64 字符的 ASCII 字母/数字/`_.-`，路径不能有空、`.`、`..` segment。
默认先加载 `AGENTS.md`，再按配置顺序加载 sources；每项均复用 scoped `read_file` 与文件级 policy，
ask/deny 项不读内容，missing/skipped 也写入 provenance。每文件最多 32 KiB，最终 system 最多 64 KiB；
超预算显式失败。provider boundary 重读并通过不可变 Context Epoch 保存完整 system、source hashes 与选择顺序。

这提供显式选择的 workspace producers；尚未实现 ambient user/ancestor discovery、完整 skill/reference catalog 或按任务自动选择。


## Session 内 raw-history recall

```jsonl
{"id":50,"method":"recall","params":{"session_id":"s","query":"旧错误信息","limit":10}}
```

model tool `recall` 自动绑定当前 Session，不接受目标 Session ID；权限 resource 为 `@session/history`，
复用 leaf policy 和 durable tool intent。host stdio adapter 可显式选择 Session。
查询是 case-sensitive literal substring（最多 512 UTF-8 bytes）；每页最多 20 个 matches，
扫描最多 1000 messages/2 MiB。按 message seq 倒序，返回角色、seq、UTF-8 安全的有界 preview。
未扫描完返回 `next_before_message_seq`；即使 matches 为空也必须根据 `exhausted` 判断是否还有历史。
单条 message 超过 2 MiB 时不载入内容，显式返回 `skipped_oversized_message_seqs` 并推进 cursor；原始记录仍保留。
检索 raw messages 中的 text/tool input/result，不检索生成的 summary 或 opaque provider continuation。
检索不会修改 transcript、checkpoint 或自动调度执行。


## Durable Session state：todos / goal

`session_state`、`todowrite`、`goal` model tools 自动绑定当前 Session；host adapter 提供：

```jsonl
{"id":60,"method":"state","params":{"session_id":"s"}}
{"id":61,"method":"update_state","params":{"session_id":"s","operation_id":"todo-edit-1","tool":"todowrite","input":{"todos":[{"content":"验证改动","status":"in_progress","priority":"high"}],"expected_revision":0}}}
```

SQLite event ledger 是唯一状态来源，没有额外 JSON 文件或第二份可变 store。每次更新在同一事务内
检查 `expected_revision` 并提交 `session.state.updated`；revision 是该提交的 event seq。
`expected_revision: 0` 表示尚无此类状态；省略 revision 采用 serialized last-write 行为。
相同 Session/operation id 对账 kind/value/expected revision，精确重试返回原提交；冲突不写事件。
model operation id 绑定 run/call；state revision 冲突返回显式工具错误，需重新读取状态。

最多 128 todos，内容非空且每项最多 2 KiB，总值最多 32 KiB；goal objective 最多 8 KiB，
evidence 最多 8 KiB，budget 最多 2 KiB。done/blocked 要求非空 evidence；引擎记录声明，不独立验证声明真实性。
状态操作使用 SessionState capability，filesystem read-only mode 仍可更新自己的 todo/goal；
规则可通过 `@session/state/**` 显式拒绝。不会由此授予 filesystem 写入或跨 Session authority。

snapshot 包含同一 cursor 的状态；默认 fork 继承当前状态，显式历史 fork 只继承边界前状态，并生成 target revision。
compaction 保留状态；恢复不重放状态工具，`session_state` 可核对已提交值。
每个 provider boundary 在同一 SQLite read transaction 内选择 history 与 state；允许读取状态时，以独立 user-role 动态前缀注入当前值。
此投影不写入 raw transcript，不改变稳定 system/Context Epoch；`provider.started.state_selection` 记录选用 revision 和 fingerprint。
`session_state` read policy 为 ask/deny 时跳过注入。history+state 总预算仍为 2 MiB；通知仍待后续实现。


## Durable choice question

model `question` 接受 1..4 个问题，每题 2..4 个唯一选项；支持 `multiSelect` 与默认启用的 `custom` typed answer。
header 最多 12 字符，完整 request/answer 各最多 32 KiB；timeout 默认 60 秒，上限 10 分钟。
通过 `questions` 或 snapshot 查询 pending requests，使用 controller 身份绑定的 `answer_question` 答复：

```jsonl
{"id":70,"method":"questions","params":{"session_id":"s"}}
{"id":71,"method":"answer_question","params":{"session_id":"s","answer":{"question_id":"RUN/CALL","input_hash":"HASH_FROM_REQUEST","answers":[["OPTION_LABEL"]]}}}
```

请求要求已有 active/dispatched `question` intent；location/input hash、Session/run/call 绑定，answer 必须符合选项、
单选/多选与 custom 规则。答复写入 SQLite event ledger 后 runner 才读到结果；完全相同的 answer 重试对账，
不同或已取消/过期的迟到答复拒绝。正常取消、shutdown 与恢复关闭 pending 请求，不自动重新提问或启动 provider。
恢复还清理历史 orphaned question，最多 256 项；fork 不继承 pending 交互请求。
模型只有 question tool，没有 controller 的答复权限；read policy 可通过 `@session/question` 拒绝请求。
目前 adapter 输出结构化请求和答复，尚无 TUI question UI、选项 preview 或远程 controller authentication。


## 只读 doctor 验收入口

```sh
miao-engine doctor
miao-engine doctor --db /path/to/engine.db
```

无需 provider 或 credentials，输出 JSON：编译版本、OS/arch、sandbox available、provider transport 列表，
以及可选 DB 的 application id/schema、`quick_check(1)` 完整性结果、Session/event/message 数量、input/run/tool 状态统计。
数据库以 read-only connection 和单个 read transaction 检查，不获取 engine owner lease、不 admission、不 reconcile。
运行中 owner 的 DB 也能检查；无关/future/missing DB 返回失败，不创建或迁移 DB，不输出 prompt/tool 内容。
完整性结果见 `database.integrity.ok`；doctor 不是网络连通、凭据有效性或任务质量验收。


## Process-owned 一次性 wakeup

permission config `allow_wakeup: true` 才向模型暴露 `schedule_wakeup` / `cancel_wakeup`；
这是独立 capability，默认 ask，允许 filesystem read-only Session 通过显式授权安排后续输入。
可配置 `schedule_wakeup` + `@session/wakeup` 规则，取消 resource 为 `@session/wakeup/TIMER_ID`。
输入 `prompt` 最多 8 KiB，`delaySeconds` 为 60..3600，`delivery` 默认 queue，也可显式 steer。

```jsonl
{"id":80,"method":"wakeups","params":{"session_id":"s"}}
{"id":81,"method":"cancel_wakeup","params":{"session_id":"s","timer_id":"TIMER_ID"}}
```

每 Session 最多 8 个、每 process 最多 64 个 attached timers；timer task 由 Runtime 监督并 join，
turn cancel 不取消 timer，独立 cancel_wakeup 只关闭未触发的 timer。触发时 `input.admitted` 与
`wakeup.resolved(fired)` 同事务提交，固定 `wakeup/TIMER_ID` input id，随后才发送 advisory wake；
queue 在 idle boundary 推进，steer 在安全 provider boundary 推进。

SQLite event ledger 保留 schedule/result 元数据；timer 本身使用 process-local monotonic deadline。
shutdown 取消/回收未触发 timers；恢复把未完成 schedule 标 interrupted，不重新安排 timer、发送 prompt 或重跑 provider。
若已触发并提交输入，其 admission 保留，按现有 pending/promoted 与显式 resume 规则处理。
触发与取消在 durable resolution 上串行化，fired timer 不能撤回已提交 prompt；fork 不复制 timers。
snapshot 包含当前未完成 timers，wakeups 提供最近 100 项状态。跨进程定时保证仍未实现。


## Process-owned recurring cron

`allow_cron: true` 独立启用 `cron_create` / `cron_list` / `cron_delete`，不会由 `allow_wakeup` 自动授予。
创建使用 Cron capability，默认 ask；规则 resource 为 `@session/cron`，删除 resource 为 `@session/cron/ID`。
接受数字式标准五字段表达式，支持 `*`、逗号、范围与步长；不接受 seconds/year、nickname 或扩展修饰符。
采用 croner calendar parser，DOM/DOW 为标准 OR 语义，系统本地时区与 DST 转换按 parser 行为处理。

```jsonl
{"id":90,"method":"crons","params":{"session_id":"s"}}
{"id":91,"method":"cancel_cron","params":{"session_id":"s","cron_id":"ID"}}
```

模型输入 `prompt` 最多 8 KiB，`cron` 最多 256 bytes，`recurring` 默认 true，`delivery` 默认 queue。
创建时必须在七天 process lifetime 窗口内有下一次 occurrence；后续 calendar lookup 在独立 blocking worker 完成。
cron 与一次性 wakeup 共享 8/Session、64/process attached schedule 总限额。

每次 occurrence 使用固定 `cron/ID/OCCURRENCE_MS` input id，admission 与 `cron.fired` 同事务提交，重复 occurrence 不再发送输入。
同一 cron 已有 pending 输入时记录 `cron.skipped(prior_input_pending)`，不堆积新 prompt。
暂停后从当前 logical time 寻找下一次日期，不逐个补发 missed ticks；calendar dates 转换为 process-local monotonic deadlines。
recurring=false 在首次触发后完成；七天到期关闭 schedule，独立删除仅停止未来 occurrences，不撤回已 admitted 输入。
turn cancel 保留 cron，shutdown join/cancel，恢复标 interrupted，不重新安排、不补发、不重跑 provider；fork 不继承 schedules。
结构化查询返回 next occurrence、fired/skipped 数与 terminal state，snapshot 包含未结束 crons。


## Gemini native GenerateContent SSE profile

```sh
GEMINI_API_KEY=... miao-engine serve --db /path/to/engine.db --workspace /path/to/workspace --provider gemini --model MODEL_ID
```

也可用已有 read-only credential source，默认 integration 为 `google`。目前是 API-key profile，
通过 sensitive `x-goog-api-key` header 传递，不接受 OAuth/subscription profile。默认 endpoint 是原生
`v1beta/models/MODEL_ID:streamGenerateContent?alt=sse`，可显式配置完整兼容 endpoint；模型必须显式指定。

text/functionCall parts 与 late usageMetadata 经过公共 bounded SSE decoder、pre-body retry 与 cancel 控制。
在 `response.completed` 之前出现的未登记 `response.*` sequenced checkpoint 事件会被跳过而不是拒绝完成响应；
completed 的 output array 是唯一权威，非 `response.*` 前缀的未知事件仍显式失败。
只接受单一 candidate、STOP finishReason；截断、blocked/未知 parts、partial/malformed args、重复 wire call id 显式失败，
收到 200 body 后不透明重放。每 reply 投影最多 512 KiB，最多 128 function calls。

function calls 使用独立 engine tool id，wire id/name/args 与完整 native parts 保存在
`provider_opaque(gemini-generate-content, model)` capsule。thoughtSignature 原值、顺序与所属 part 不变；
下轮 Echo native model parts，并合并连续 user functionResponses，保留 wire ids 和结构化结果。
协议/模型不匹配或 native/neutral mapping 被修改时，在发送 HTTP 请求前拒绝。
没有 native capsule 的外来 tool history 不合成 signatures；普通无签名 text history 可移植。

当前验证为真实 HTTP fixture 的原生 wire/profile/runtime 路径；尚无 Gemini 实际账户验收。
Vertex、Interactions、multimodal/hosted tools、streaming partial-function arguments 与 Google OAuth broker 仍未实现。
官方行为说明：[thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)。


## 显式 pre-response fallback

`serve --fallback-model MODEL_ID [--fallback-endpoint URL]` 配置同一 provider/profile/credential source 的 secondary。
也可用 `routing::Fallback` 组合 native providers；其 protected credential resources 会合并。
自定义 Gemini primary endpoint 时必须显式给出 fallback endpoint，保证新模型的 URI 由 host 选择。

整个 provider turn 共享三次 HTTP attempt / 60 秒 pre-response 预算：有可切换 secondary 时 primary 一次、secondary 最多两次。
只对未接受 response 的 transport failure 或 HTTP 429/500/502/503/504/529 切换；
响应 body transport failure、截断/语义错误、auth/history 问题不切换。body idle timeout 仍遵循原有 stream 规则。

读取 projected history 的 opaque protocol/model binding：只匹配 secondary 时直接 pin 到 secondary；
只匹配 primary 且 secondary 不兼容时保留 primary 的三次预算；mixed/未知 binding 明确失败。
不删除、不转换 signatures/reasoning state，也不在接受响应后重新请求另一个模型。
各并发 turn 的预算独立，resolver 不持有 Session/store，也不另起工具循环。

启用该 wrapper 后 `usage` 为 `{reported: VENDOR_USAGE, routing: SELECTION}`；失败事件也保存 routing metadata。
selection 包含 protocol/model、primary/fallback、opaque_pinned、fallback 原因与 attempt 数，不包含 endpoint 或 credentials。
当前尚无完整 purpose-role catalog、自动模型发现或质量/价格路由。


## Host 生命周期 hooks（tool 前后）

`--hooks-config /absolute/path/hooks.json` 配置 host 侧钩子（workspace 之外，≤64 KiB，自动列入保护资源）：

```json
[{"event":"tool_before","tool":"run_command","argv":["/path/guard","--check"],"timeout_ms":10000}]
```

`event` 为 `tool_before` / `tool_after`；`tool` 为精确模型工具名或 `*`；最多 16 个，
`(event, tool, argv)` 去重；argv 复用 run_command 校验（≤128 段、无 NUL、timeout 1..120000ms，默认 10s）。

钩子进程走 run_command 同一条 sandbox 路径（workspace 写沙箱、网络关闭、独立临时目录、进程组守护）。
`tool_before` 在 policy 授权后、intent 派发前执行：exit 0 且正常退出才放行；非零、超时、输出超限、执行错误一律
fail-closed 阻止派发，工具结果为 `blocked by tool_before hook (outcome …)`，不产生工具副作用。
`tool_after` 在工具结果 durable 落库后执行，只观测，永不改变结果或错误状态。
每次执行记录 `hook.completed`（phase/tool/outcome/exit_code/reason/时长），可审计。

钩子是 host 信任配置的守门/观测面，不是模型能力：不占 permission 规则、不需要 allow_process，
也不给模型任何新 authority。目前没有 per-hook 网络、stdin 注入、run/turn 级事件或远程 hook。
