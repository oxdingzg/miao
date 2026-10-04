# miao 路线图 — 剩余工作

状态快照：**2026-10-04**，最新发布版本 **v0.1.4**。

本文档是 V1→V2 重建中所有未完成项的**唯一权威清单**。它取代了此前分散的追踪文档
（remaining-work checklist 与 handoff、V2 todo 列表、P7 路由盘点、app API 迁移清单，以及
发布/性能/存储交接），这些文档已归档到 `docs/archive/`。每一项都标明状态、已知的确切代码
入口，以及可观察的验收标准。

## 阅读说明

- **状态（Status）**：`open`（未开始）、`partial`（部分切片已落地）、`blocked`（受阻）。
- **验收（Acceptance）** 是「切片完成」的可观察证据，而不只是「代码已合并」。
- 大致按依赖与价值排序，非严格。
- 适用于每个切片的通用规则集中列在文末。

## 已完成（背景，非剩余工作）

- V1 会话运行时、工具，以及 `/session/*`、`/permission/*`、`/question/*`、`/sync/*` 路由组
  已删除。服务端只挂载 `/api/*`、OpenAPI 文档与内嵌 UI。
- V1 退役的 Stage 1–5 已全部落地。创建已是 V2 原生（`session.next.created.1`）；V1 投影器与
  `packages/core/v1` schema 仅为 legacy DB 读取、backfill、compact、restore 保留。
- 所有已发布的客户端——TUI、`--mini`、ACP、`miao run`、web/desktop app、`miao remote`——
  都通过 `/api/*` 读写。TUI 已**清零** legacy SDK 调用。
- app 已从 vendored 上游客户端切到 `@miao/client`；`detectServerProtocol` 与
  `protocol === "v1"` 分支已删除。TUI 的 console/org 切换功能已删除。
- SendMessage 首个切片、内容寻址 Blob 存储、durable 事件 tail，以及大部分 G2/G3/G9/G11/G13
  切片已完成。
- 2026-10-04 快照的存储恢复验收已完成。

---

## 1. V1 残留 — P5（legacy SDK）与 P7（非会话路由）

**状态：** partial。目标：已发布的服务端运行 V2-only 组装，只剩 CLI 外壳，且没有任何客户端
依赖 `@miao/sdk` 或无前缀的旧路由。

### 1.1 legacy JS SDK（P5）
旧 V1 SDK 已移除：没有任何包依赖 V1 SDK 表面，app 与 CLI 都走 `@miao/client`，`packages/sdk` 现在是
**嵌入式 SDK 入口**（库用法 `OpenCode.create()`），不是 legacy 表面——保留它。剩余：
- [ ] 把插件的 `Hooks` 接口与 `PluginInput.client` 从 V1 形状迁走
      （`packages/plugin/src/index.ts`）。这是插件 API 设计工作（见第 3 节），不是清理。
- **验收：** `PluginInput.client` 暴露 V2 客户端，V1 `Hooks` 接口被适配或退役。

### 1.2 app 旧类型与适配层
app 的网络调用已迁移，恒等的 `server-compat` shim 已删除（#40）。注意：`src/utils/session.ts` 与
`src/utils/session-message.ts` 是当前 V2→视图模型的归一化，不是 legacy 适配，保留。剩余为真正
V1 形状的遗留：
- [ ] 替换 `src/context/global-sync/utils.ts` 的 agent/provider/model 适配。
- [ ] 在 app 状态与渲染中替换 legacy 的 `Session`、`Message`、`Part`、`PermissionRequest`、
      `QuestionRequest`、`Project`、`FileNode`、`FileDiffInfo`、`Event` 类型。
- [ ] 退役过渡期的会话事件（`session.created/updated/diff/status/idle/error`），位于
      `src/context/global-sync/event-reducer.ts`、`src/context/server-session.ts`、
      `src/context/notification.tsx`、`src/pages/session/usage-exceeded-dialogs.tsx`。
- [ ] 退役旧消息事件兼容层（`message.updated/removed`、`message.part.*`），位于
      `src/context/global-sync/event-reducer.ts` 与 `src/context/server-session.ts`。
- [ ] 迁移 `src/context/global-sync/event-reducer.ts` 中的 LSP 与 reference 事件。
- [ ] 删除 `src/context/server-session.ts` 的三处兼容兜底
      （`GET /session/:id`、`/message`、`/message/:mid`）。
- [ ] 替换 V1 端点 mock（`e2e/utils/mock-server.ts`）、`e2e/performance/timeline-stability/fixture.ts`
      的 `SessionV1` / legacy 夹具，以及剩余的 legacy SDK 类型夹具。
- [ ] 剩余的目录配置读取 `GET /config`。
- **验收：** app 仅用 `@miao/client` 类型渲染与变更；app 状态中无 legacy 类型；测试中无 legacy
  路由 mock。

### 1.3 非会话旧路由与服务端拆除
大多数 V2 端点已存在（`pty.shells`、`project.update`、`vcs.diff`、`fs.content`、`config.update`、
经 `/api/worktree` 的 `workspace.reset`、`project.initGit`、项目持久化）。剩余：
- [x] 把项目持久化下沉 core。ID 迁移、sandbox 维护、目录注册与 `project.updated` 事件本就在 core
      `ProjectRegistry` 中；`ProjectMetadata` 现在也负责 `setInitialized`、`sandboxes`、`addSandbox`、
      `removeSandbox`。`packages/miao` 的 `Project` 服务委托 core，不再直接写 `ProjectTable`
      （#35、#36）。服务端 handler 已只用 core。
- [x] 删除 `packages/miao` 的旧 `Project` facade。实例启动直接调用 core 的完整项目注册；
      `/init` 订阅并入实例 bootstrap，并随实例释放。工作树、CLI 与测试直接使用
      `ProjectRegistry`、`ProjectMetadata` 和 Schema 类型；原有迁移、目录、图标与元数据测试保留。
- [ ] 移除 `packages/miao` 的 `app-runtime` V1 层及剩余非会话旧路由；把发布服务端切到 V2-only
      组装。
- [ ] 确认 V2 端点覆盖了此前在 V2 下被静默禁用的 app 行为（全局配置读取、项目重命名、目录
      选择器、自定义 provider）。
- **验收：** `packages/miao` 只剩 CLI 外壳；服务端仅挂载 `/api/*`；无 V1 project 代码残留。

---

## 2. V2 架构缺口

**状态：** 逐项 open / partial。

### 2.1 原生 runner 切片
首个 Effect 原生的本地 runner 已实现。接下来审定的切片：
- [ ] 保留结构化的本地工具**急切结算**：持久化记录每次完整调用，立即启动子执行，在 provider
      turn 关闭后等待所有结算，然后只重载一次投影历史。
- [ ] 在扩大暴露前，重新审视每轮工具调用上限、输出截断与运行背压。当前本地急切执行刻意
      不设上限，而 SQLite 发布保持串行。
- [ ] 在把剩余的一次性 native-adapter 用途替换为窄类型 dispatcher 后，移除公开的内存
      `@miao/llm` 工具循环。
- [ ] 批量处理流式 delta 并补充覆盖性 context 索引。
- [ ] 在远端消费者需要处，通过 HTTP 与生成的 SDK 暴露可重放的 Session 事件游标。

### 2.2 后台 / 异步任务（G6）
**入口：** `packages/core/src/background-job.ts`（已存在，**未接 V2**）、
`packages/core/src/tool/bash.ts:72-74`。
- [ ] 采用 ACP terminal 契约（`terminal/create` → `output`
      [output/truncated/exitStatus] / `wait_for_exit` / `kill` / `release`、`outputByteLimit`
      从头部按字符边界截断）。
- [ ] 将 `BackgroundJob` 接入 V2 工具执行：durable status、有界预览、协作式取消、增量投递、
      完成投递。
- [ ] 在暴露远端观测前定义重启恢复与授权。
- **验收：** 启动一个后台任务，重启 dev server，查询状态并取回退出码与截断输出。

### 2.3 取消结算与工具进度（G4）
**入口：** `packages/core/src/session/runner/llm.ts`、`to-llm-message.ts`、
`packages/core/src/tool/bash.ts`、`packages/core/src/session/input.ts`。
进展：停滞的子代理会被中断，父级中断时清理子进程组；中断会清除工具 fiber 并让未结算工具
失败，而 durable 的排队/转向输入得以保留；中断悬挂的 permission/question 会发布
`Replied(reject)`/`Rejected`；附件在请求构建时按模型能力归一化；工具进度事件已端到端接通
（`session.next.tool.progress`）。
- [ ] 把级联取消子 fiber、排空 inbox、结算悬挂审批作为一条第一类取消路径。
- [ ] 核心工具产出增量工具进度检查点（bash 目前为缓冲输出）。
- [ ] 在 provider 历史降级前物化 remote 与 managed URI（`to-llm-message.ts:80` TODO）。
- **验收：** 中断一个带子任务与悬挂审批的会话 → 无悬挂/丢失状态，无丢失的排队消息。

### 2.4 崩溃恢复幂等（G5）
**入口：** `packages/core/src/session/runner/llm.ts`。
进展：由前序进程遗留仍在运行的工具会以「结果未知」错误结算（`failInterruptedTools`）。
- [ ] 幂等键（`callID` + attempt）外加一次性消费 token。
- [ ] 重启时把未结算调用标记为结果未知，并要求显式 retry/abandon。
- **验收：** 工具执行中途 kill，恢复 → 无重复副作用；模型看到「结果未知」。

### 2.5 输出边界 / 超时 / 上限（G7）
**入口：** `packages/core/src/tool/bash.ts`、`ripgrep.ts`、`tool/websearch.ts`、
`tool/http-body.ts`、`tool-output-store.ts`。
进展：ripgrep 强制默认 30s 超时（可覆盖），到期 kill 并使调用失败；webfetch/websearch 对响应体
设界；MCP 图片结果上限 5 MB base64。
- [ ] 把完整 shell 输出流式写入受管存储，仅在有界内存中保留预览。
- [ ] 为 ripgrep 增加有界的按行分帧。
- [ ] 对尚未设界的非流式 JSON/image body 加上限。
- **验收：** `yes` / 超长行输出不会撑爆内存或挂起；长时间 grep 干净超时。

### 2.6 AST 编辑阶梯（G8 剩余）
**入口：** `packages/core/src/tool/edit.ts`、`edit-fuzzy.ts`、`packages/core/src/snapshot.ts`。
进展：基于快照的 undo/redo 已存在；会破坏文件的 mid-line 模糊匹配被拒绝。
- [ ] 在精确编辑行为确立后，实现 AST 感知的编辑阶梯（刻意移植 V1 模糊修正策略：行裁剪匹配、
      块锚点回退、缩进修正、相似度阈值复核）。
- **验收：** 会被 token 匹配破坏的编辑被结构化应用或被拒绝；undo 还原编辑前的字节。

### 2.7 MCP 渐进发现 / OAuth / CIMD（G9 剩余）
**入口：** `packages/core/src/mcp.ts`；OAuth 先例在 `packages/miao/src/mcp/{auth,oauth-provider}.ts`。
进展：MCP 规范工具名按码点顺序确定性去重（先到先得）。
- [ ] 渐进发现（`search_tools` → `get_tool_details`，在 1–5% context 时切换，在缓存断点后追加，
      永不重排）。
- [ ] 通过 CIMD 排序的 OAuth（预注册 → CIMD → DCR → prompt），凭据以 AS `issuer` 为键，校验
      `iss`（RFC 9207）。
- [ ] 在已安装的 `@modelcontextprotocol/sdk` 暴露的前提下，实现带 `ttlMs`/`cacheScope` 的确定性
      `tools/list`。
- **验收：** 大型 MCP 目录在不扰动 prompt-cache 前缀的前提下惰性加载；OAuth 完成且凭据按 issuer
      持久化。

### 2.8 bash 之外的沙箱覆盖（G12 剩余）
**入口：** `packages/core/src/sandbox.ts`（`Sandbox.Service`）、
`packages/core/src/sandbox/{runner,policy}.ts`。
进展：V2 bash 在 core OS 沙箱下运行；catch-all allow 规则无法解除它。
- [ ] 把同一 core-owned 沙箱扩展到其他变更型工具（workdir、允许路径、网络），fail-closed、
      面向模型的拒绝提示。
- [ ] 让沙箱对剩余工具默认开启。
- **验收：** 沙箱内的变更型工具无法写到允许路径之外；配置时拒绝网络；拒绝以工具错误呈现。

### 2.9 durable 续跑恢复
**状态：** blocked，等待显式设计。不要从 advisory wake 推断歧义的 provider 工作可安全重试；
首个 inbox 驱动的 runner 刻意省略外层 provider-attempt 标记，直到有具体消费方与完整恢复策略。
- [ ] 把崩溃后续跑恢复设计为一个显式切片，建模：已提升输入与投影历史状态；排队输入提升与
      转向分配；provider-attempt 准备与派发歧义；跨进程丢失所必需的 turn 后续；对未知结果的
      显式 `retry`/`abandon`；仅在 provider 与工具幂等安全时的有界自动重试；重试预算、退避、
      可见恢复状态、启动发现，以及未来集群化 ownership fencing。
- 不要仅为归组这些事实而引入一个外层 durable 执行身份；进程内的 Session drain 没有 durable
  的 transcript 边界。
- **验收：** 有具体消费方的成文策略；不从 advisory wake 推断重试。

### 2.10 延迟的硬化清理
保持可见；除非 canary 出现具体故障，否则不阻塞功能切片。
- [ ] 跨进程串行化数据库迁移申领（当前仅进程内信号量；两进程对同一 SQLite 库启动时仍可能
      竞争）。
- [ ] 用 Effect `RcMap` 与每个活跃聚合一个共享 `PubSub.sliding<void>(1)` 简化进程内 durable-tail
      wake 生命周期，保持 SQLite 游标重放与 subscribe-before-history 语义不变。
- [ ] 分页读取大规模 durable 聚合重放，而不是把陈旧游标后的所有行一次性载入数组。
- [ ] 决定已连接的 tail 是否需要针对跨进程 SQLite 写入者的周期性轮询兜底（当前 advisory wake
      刻意是进程内的）。
- [ ] 在解析前对 websearch body 收集加流式上限。
- [ ] 物化或一致地拒绝未解析的 URL 与文件附件来源。
- [ ] 决定无状态 OpenAI Responses 托管工具续跑行为（当 `store !== false` 时，重建的托管输出可
      作为已存 `item_reference` 重放；`store: false` 刻意省略）。
- [ ] 决定是否保留已弃用的 `@miao/llm` 编排导出。
- [ ] 若兼容消费方需要，保留或别名化被重命名的文件系统 SDK 生成类型名。
- [ ] 重新审视针对敌意外部进程的 syscall 级变更限制（`openat`、`O_NOFOLLOW`、descriptor-relative
      mutation）。

### 2.11 SendMessage 剩余
**入口：** runner 注册的 `send_message` / `list_sessions` 工具。
进展：`send_message` 解析 Session ID 或 `@slug`，拒绝缺失与跨项目目标，拒绝撑爆目标入站队列
（`MAX_INBOUND_QUEUE`），准入一条排队的 `<message from session="…">` 输入，并通过
`SessionRunner.run` 上的 `wake` 回调唤醒目标。`list_sessions` 枚举同级 Session。投递按目标断言
`message` permission 动作（默认 ask）。同项目内 A → B 投递已可用。
- [ ] 接收方 drain 的循环防护成本核算。
- [ ] 回复回送到发送方；重启后无重复投递；与无关会话隔离。
- **验收：** A 发给 B；B 收到；回复回送；重启不产生重复。

### 2.12 供应商重复输出保护
- [x] 为文本/reasoning 检测提供按流隔离、有界的状态；高置信度短句循环会中止而不自动重试，
      保留此前工具结算。
- [x] 只在供应商上下文中隔离已识别的重复助手输出，保留持久化记录与已完成工具调用/结果。
- [ ] 收集更多 wire 证据后，扩展短的换行自然语言之外的检测范围。
- **证据：** [调查与边界](provider-output-repetition.zh.md)，含同模型并发正常会话对照。
  这是客户端保护，不是已证实修复了供应商根因。

---

## 3. Config、插件、service

**状态：** open。
- [ ] 重构 config 为更干净的形态，并自动转换旧配置。旧配置应被自动转换。
- [ ] 在作用域化 System Context registry seam 上实现插件定义的 context 注册与热重载生命周期。
- [ ] 成功读取后的嵌套项目指令发现，在下一个 Safe Provider-Turn Boundary 处 durable 准入。
- [ ] 设计服务端插件 API 与 hooks（immer 草稿以便丢弃坏变更、全局实例、工具注册如
      `opencode.tool.register({...})`）。
- [ ] 通过细粒度事件让每个 service 可热重载，而非拆除重建，使服务能对变化做出反应并自我
      重配（前端也能收到，如 `model.added`）；这也避免启动阻塞。
- [ ] 把 provider 作为插件注册，按各自的逻辑/config 自动加载，并把模型注册进模型数据库；
      auth 系统应能跟踪任何类型的认证，而不仅是 provider。

---

## 4. 存储运维

**状态：** partial。
- [ ] 压缩 `miao-main.db`（preview channel；2026-10-04 为 **2.34 GB**，未压缩）。沿用 V1 表退役
      路径（`miao db compact`：批量删除 `message.*` 事件、drop `message`/`part`、只重置被清空的
      `event_sequence` 行、checkpoint + vacuum）。
- [ ] 对照 <200 MB 验收核对 `miao.db`（2026-10-04 为 **876 MB**；此前 2026-10-03 为 666 MB）。
- [x] 删除 `~/.local/share/miao` 下旧的 `miao*.db.bak-*` / `*.compacted-*` 副本及
      `retirement-20261003` 演练暂存。2026-10-04 经 owner 批准删除：21 GB → 5.8 GB（回收约
      15 GB）。活跃数据库（`miao.db`、`miao-main.db`、`miao-local.db`）与已验收的
      `backups/acceptance-*` 快照均保留。macmini 构建机上没有 miao 数据库文件，无需迁移。
- [ ] 仅 delta 事件：退役 V1 的逐 delta sync 事件；每个完成片段/消息只保留一行 durable 记录。
      不要把 V1 的 snapshot-per-delta 带过来。（V2 写路径已按片段持久化一条 durable
      `text.started`/`text.ended`，无 durable delta。）
- [ ] 事件日志保留/压缩（snapshot-then-truncate）。
- [ ] 按项目 blob GC（引用计数或 mark-and-sweep）。
- [ ] 验证 `db stats` 无 `message.part.updated` 膨胀、无内联 base64，`event` 行数由片段/消息数
      界定，且 `db vacuum` 能回收体积。
- **验收：** 事件行数有界、无内联 base64、文件体积被回收。

---

## 5. 性能分析与报告

**状态：** partial（测量已完成，分析与报告未完成）。已编译 0.1.2 preview 上的 400 消息固定负载
打字运行已完成：1800 s，119 输入 / 0 超时，PTY 写入到回显 P50 19.5 ms / P95 23.7 ms /
P99 25.4 ms / max 27.3 ms；主 isolate RSS 725.6 MB → 747.9 MB；FD 稳定在 35；hydration 计数 1。
测量边界不含终端呈现，且这是「空闲 + 打字」，不是流式或反复的 Session 生命周期切换。
- [ ] 用下载的 0.1.0 产物在同一夹具上运行，做受控的前后对比，串行地配合后续运行。（产物路径
      记录在已归档的 2026-10-04 交接文档中；不要在此硬编码临时路径。）
- [ ] 审计批量按键的输入计时关联；当前收据逻辑可能覆盖 pre-update 收据，因此结果不能称作
      per-key 延迟。
- [ ] 分析 RSS/原生分配与对象归属；补充 Session 切换/创建/关闭生命周期场景。
- [ ] 产出双语最终性能报告，附原始证据链接与边界说明。
- [ ] 厘清 `shutdown.forced: true` 结果（五秒 SIGTERM 等待）并确认优雅退出，区分应用行为与 PTY
      排空行为。
- **验收：** 受控对比加书面报告；不对未证实的改进下结论。

---

## 6. 发布二进制验收

**状态：** partial。2026-10-04 在三台真机上安装并演练了已发布的 **0.1.4** 二进制：macOS ARM64
（macmini）、Linux x64（xx02）、Windows x64（192.168.3.96）。每台机器 `--version` 返回 `0.1.4`，
初始化了全新数据库，`miao doctor` 报告 `findings: none`。在隔离 DB 上 `db stats`、
`db compact --dry-run`、`db vacuum` 均干净运行。

已在发布二进制上验证：
- [x] 跨平台冒烟：同一个 0.1.4 产物在 macOS ARM64、Linux x64、Windows x64 上均可运行；
      三台 `doctor` 均干净。
- [x] 跨进程 inbox 恢复：一个进程准入一条 durable `queue` 输入
      （`admitted_seq=1, promoted_seq=null`），另一个更晚的进程在无 live 会话事件的情况下通过
      `GET /api/session/:id/inputs` 读回它，第三个进程将其提升（`promoted_seq=17`，投影
      `session_message` `seq=17`）。在 xx02 上用隔离数据库演练。

仍未完成或受阻：
- [ ] 验收已发布的 **Windows 0.1.4** 产物从 0.1.2 的升级路径（目前只做了全新安装）。
- [ ] 在已发布二进制中验收出站消息卡片与跨进程收发行为（受阻：验证机上无 provider 凭据）。
- [ ] 在已发布二进制中针对真实 provider 观测 provider 报错可见性（受阻：无 provider 凭据；此前
      编译二进制故障注入看到红色 `API Error: 429` 与 `Retrying · attempt #1`）。
- [ ] 针对确认循环引导，演练真实的 Multi-Session 行为（live soak）。
- [ ] 观测真实瞬时 TLS 故障的恢复（分类已在 0.1.2 发布并有单测）。
- [ ] 确认 Go 付费请求成功（需在 OpenCode workspace Privacy 中开启 **Global**）。
- [ ] 对照当前 `main` 重新评估较早的非阻塞 Windows 浏览器 E2E 失败。
- [ ] 确认最新的完整跨平台 CI 套件，包括此前按非阻塞处理的 Windows 浏览器 E2E 失败。

注：`MIAO_DATA_DIR` 不生效；数据库覆盖变量是 `MIAO_DB`（一个文件路径）。验证使用了一次性 `HOME`
加 `MIAO_DB`，未触碰任何 owner 数据库。

---

## 7. 文档

**状态：** open。
- [ ] 更新仍描述已移除 SDK 或已被取代架构的现行指南。
- [ ] 保留历史发布/研究记录与上游许可声明。
- [ ] 将 OpenCode 厂商 provider ID（`opencode`、`opencode-go`）保留为真实 provider 身份。

---

## 工作区草稿（未提交）

- `packages/miao/script/measure-input-pty.py`
- `packages/miao/script/seed-input-latency.ts`

在决定是否提交前，需做最后一次隔离重跑（若重新播种，保持单调聚合序号）。

## 通用规则（每个切片）

- 在 `miao-dev`（源码）中运行；发布 `miao` 是日常主力，绝不可弄坏。
- 每会话一个写入方：按 surface 同时翻转引擎、路由与客户端。
- 只 `git add` 你编辑的路径；绝不 `git add -A`；不要提交其他 session 的 WIP。
- 每个变更：`bun typecheck` 通过加上受影响包的测试，然后在短线分支上以 conventional commit
  提交，通过 pull request 合入。`main` 受保护；squash 合并。
- 在配置好的构建机上编译，绝不在本地编译。
- 任何公开 Protocol/Server `HttpApi` 变更后，从 `packages/client` 运行 `bun run generate`。
- 未 backfill 的旧会话会抛 `Session.LegacyNotMigratedError`；在 V2 上继续前先运行
  `miao-dev db backfill`。
- 不要为未验证行为编造修复；记录 blocker。

## 回滚

- Preview 二进制：`ln -sfn ~/.local/share/miao/bin/miao.prev ~/.local/bin/miao-preview`。
- V1 已删除，因此回归时通过安装上一个 release 来回滚。
