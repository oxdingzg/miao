# miao 路线图 — 剩余工作

状态快照：**2026-10-04**，最新发布版本 **v0.1.4**。

本文档汇总了在核对 V1→V2 重建各项追踪文档与仓库实际状态时发现的**所有仍未完成项**，
目的是避免剩余工作在多次会话之间遗漏。每一项都标明已知的确切代码入口，以及验收标准。

## 阅读说明

- **状态（Status）**：`open`（未开始）、`partial`（部分切片已落地）、`blocked`（受阻）。
- **验收（Acceptance）** 是「切片完成」的可观察证据，而不只是「代码已合并」。
- 大致按依赖与价值排序，非严格。

## 已完成（背景，非剩余工作）

- V1 会话运行时、工具，以及 `/session/*`、`/permission/*`、`/question/*`、`/sync/*`
  路由组已删除。所有已发布的客户端都通过 `/api/*` 读写。
- V1 退役的 Stage 1–5 已全部落地；V2 是唯一的会话运行时。
- TUI 已**清零** legacy SDK 调用。
- SendMessage 首个切片、内容寻址 Blob 存储、durable 事件 tail，以及大部分
  G2/G3/G9/G11/G13 切片已完成。
- 2026-10-04 快照的存储恢复验收已完成。

---

## 1. V1 残留 — P5（legacy SDK）与 P7（非会话路由）

**状态：** partial。

目标是让已发布的服务端能运行 V2-only 的组装，只剩 CLI 外壳，且没有任何客户端依赖
`@miao/sdk` 或无前缀的旧路由。

### 1.1 legacy JS SDK（P5）
- [ ] 移除 V1 根导出，并仅针对 V2 重新生成 SDK。
- [ ] 把插件 `Hooks` / `PluginInput.client` 从 V1 迁到 V2。
- [ ] 在所有消费方与类型清理完后，去掉 `@miao/sdk` 运行时依赖。
- **验收：** 没有任何包导入 V1 SDK 表面；插件 API 使用 V2 结构。

### 1.2 app 旧类型与适配层
**状态：** partial。
- [ ] 替换 `src/utils/session.ts` 的 current→legacy session 适配。
- [ ] 替换 `src/utils/session-message.ts` 的 message/part 适配。
- [ ] 替换 `src/context/global-sync/utils.ts` 的 agent/provider/model 适配。
- [ ] 在 app 状态与渲染中替换 legacy 的 `Session`、`Message`、`Part`、
      `PermissionRequest`、`QuestionRequest`、`Project`、`FileNode`、`FileDiffInfo`、
      `Event` 类型。
- [ ] 退役过渡期的会话事件（`session.created/updated/diff/status/idle/error`）。
- [ ] 退役旧消息事件兼容层（`message.updated/removed`、`message.part.*`）。
- [ ] 迁移 LSP 与 reference 事件。
- [ ] 删除 `src/context/server-session.ts` 的三处兼容兜底
      （`GET /session/:id`、`/message`、`/message/:mid`）。
- [ ] 在 e2e 与时间线性能测试中替换 V1 端点 mock 与 legacy 夹具。
- **验收：** app 仅用 `@miao/client` 类型渲染与变更；app 状态中无 legacy 类型。

### 1.3 非会话旧路由
**状态：** partial（大多数端点已加）。
- [ ] 移除 `packages/miao` 的 `app-runtime` V1 层及剩余非会话旧路由；把发布服务端切到
      V2-only 组装。
- [ ] 确认 V2 端点覆盖了此前在 V2 下被静默禁用的 app 行为（全局配置读取、项目重命名、
      目录选择器）。
- **验收：** `packages/miao` 只剩 CLI 外壳；服务端仅挂载 `/api/*`。

---

## 2. V2 架构缺口

**状态：** 逐项 open / partial。

### 2.1 原生 runner 切片
- [ ] 保留结构化的本地工具**急切结算**：持久化记录每次完整调用，立即启动子执行，在
      provider turn 关闭后等待所有结算，然后只重载一次投影历史。
- [ ] 在扩大暴露前，重新审视每轮工具调用上限、输出截断与运行背压。
- [ ] 在把剩余的一次性 native-adapter 用途替换为窄类型 dispatcher 后，移除公开的内存
      `@miao/llm` 工具循环。
- [ ] 批量处理流式 delta 并补充覆盖性 context 索引。
- [ ] 在远端消费者需要处，通过 HTTP 与生成的 SDK 暴露可重放的 Session 事件游标。

### 2.2 后台 / 异步任务（G6）
**入口：** `packages/core/src/background-job.ts`（已存在，**未接 V2**）、
`packages/core/src/tool/bash.ts`。
- [ ] 采用 ACP terminal 契约（`terminal/create` → `output`
      [output/truncated/exitStatus] / `wait_for_exit` / `kill` / `release`、`outputByteLimit`）。
- [ ] 将 `BackgroundJob` 接入 V2 工具执行：durable status、有界预览、协作式取消、
      增量投递、完成投递。
- [ ] 在暴露远端观测前定义重启恢复与授权。
- **验收：** 启动一个后台任务，重启 dev server，查询状态并取回退出码与截断输出。

### 2.3 取消结算与工具进度（G4）
**入口：** `packages/core/src/session/runner/llm.ts`、`to-llm-message.ts`、
`packages/core/src/tool/bash.ts`、`packages/core/src/session/input.ts`。
- [ ] 中断时级联取消子 fiber、排空 inbox、结算悬挂的审批。
- [ ] 核心工具产出增量工具进度检查点（bash 目前为缓冲输出）。
- [ ] 在 provider 历史降级前物化 remote 与 managed URI（`to-llm-message.ts:80` TODO）。
- **验收：** 中断一个带子任务与悬挂审批的会话 → 无悬挂/丢失状态。

### 2.4 崩溃恢复幂等（G5）
**入口：** `packages/core/src/session/runner/llm.ts`。
- [ ] 幂等键（`callID` + attempt）外加一次性消费 token。
- [ ] 重启时把未结算调用标记为结果未知，并要求显式 retry/abandon。
- **验收：** 工具执行中途 kill，恢复 → 无重复副作用；模型看到「结果未知」。

### 2.5 输出边界 / 超时 / 上限（G7）
**入口：** `packages/core/src/tool/bash.ts`、`ripgrep.ts`、`tool-output-store.ts`。
- [ ] 把完整 shell 输出流式写入受管存储，仅在有界内存中保留预览。
- [ ] 对尚未设界的非流式 JSON/image body 加上限。
- **验收：** `yes` / 超长行输出不会撑爆内存或挂起。

### 2.6 AST 编辑阶梯（G8 剩余）
**入口：** `packages/core/src/tool/edit.ts`、`edit-fuzzy.ts`。
- [ ] 在精确编辑行为确立后，实现 AST 感知的编辑阶梯。
- **验收：** 会被 token 匹配破坏的编辑被结构化应用或被拒绝。

### 2.7 MCP 渐进发现 / OAuth / CIMD（G9 剩余）
**入口：** `packages/core/src/mcp.ts`。
- [ ] 渐进发现（`search_tools` → `get_tool_details`，缓存在断点后追加，永不重排）。
- [ ] 通过 CIMD 排序的 OAuth（预注册 → CIMD → DCR → prompt），凭据以 AS `issuer`
      为键，校验 `iss`（RFC 9207）。
- [ ] 确定性的 `tools/list`，带 `ttlMs`/`cacheScope`（当前 MCP SDK 未暴露）。
- **验收：** 大型 MCP 目录在不扰动缓存前缀的前提下惰性加载；OAuth 按 issuer 持久化。

### 2.8 bash 之外的沙箱覆盖（G12 剩余）
**入口：** `packages/core/src/sandbox.ts`、`sandbox/{runner,policy}.ts`。
- [ ] 把 core OS 沙箱扩展到其他变更型工具（workdir、允许路径、网络），fail-closed、
      面向模型的拒绝提示。
- **验收：** 沙箱内的变更型工具无法写到允许路径之外；配置时拒绝网络。

### 2.9 durable 续跑恢复
**状态：** blocked，等待显式设计。
- [ ] 把崩溃后续跑恢复设计为一个显式切片：已提升输入与投影历史状态、排队输入提升与
      转向分配、provider-attempt 准备与派发歧义、跨进程丢失所必需的 turn 后续、显式
      `retry`/`abandon`、仅在幂等安全时的有界自动重试、重试预算/退避/可见状态、启动
      发现、未来集群化 ownership fencing。
- **验收：** 有具体消费方的成文策略；不从 advisory wake 推断重试。

### 2.10 延迟的硬化清理
保持可见，除非出现具体故障，否则不阻塞功能切片。
- [ ] 跨进程串行化数据库迁移申领（当前仅进程内信号量；两进程仍可能竞争）。
- [ ] 用 Effect `RcMap` 与每个活跃聚合一个共享 `PubSub.sliding<void>(1)` 简化进程内
      durable-tail wake 生命周期。
- [ ] 分页读取大规模 durable 聚合重放，而不是把陈旧游标后的所有行一次性载入数组。
- [ ] 决定已连接的 tail 是否需要针对跨进程写入者的周期性轮询兜底。
- [ ] 在解析前对 websearch body 收集加流式上限。
- [ ] 物化或一致地拒绝未解析的 URL 与文件附件来源。
- [ ] 决定无状态 OpenAI Responses 托管工具续跑行为。
- [ ] 决定是否保留已弃用的 `@miao/llm` 编排导出。
- [ ] 若兼容消费方需要，保留或别名化被重命名的文件系统 SDK 生成类型名。
- [ ] 重新审视针对敌意外部进程的 syscall 级变更限制（`openat`、`O_NOFOLLOW`、
      descriptor-relative mutation）。

### 2.11 SendMessage 剩余
**状态：** partial。
- [ ] 接收方 drain 的循环防护成本核算。
- [ ] 回复回送到发送方；重启后无重复投递；会话之间隔离。
- **验收：** A 发给 B；B 收到；回复回送；重启不产生重复。

---

## 3. Config、插件、service

**状态：** open。
- [ ] 重构 config 为更干净的形态，并自动转换旧配置。
- [ ] 在作用域化 registry seam 上实现插件定义的 context 注册与热重载生命周期。
- [ ] 成功读取后的嵌套项目指令发现，在下一个 Safe Provider-Turn Boundary 处 durable 准入。
- [ ] 设计服务端插件 API 与 hooks（immer 草稿、全局实例、工具注册）。
- [ ] 通过细粒度事件让每个 service 可热重载，而非拆除重建。
- [ ] 决定 provider/model 作为插件注册、喂给模型数据库。

---

## 4. 存储运维

**状态：** partial。
- [ ] 压缩 `miao-main.db`（preview channel；2026-10-04 为 **2.34 GB**，未压缩）。
- [ ] 对照 <200 MB 验收核对 `miao.db`（2026-10-04 为 **876 MB**）。
- [x] 删除 `~/.local/share/miao` 下旧的 `miao*.db.bak-*` / `*.compacted-*` 副本及
      `retirement-20261003` 演练暂存。2026-10-04 经 owner 批准删除：21 GB → 5.8 GB
      （回收约 15 GB）。活跃数据库（`miao.db`、`miao-main.db`、`miao-local.db`）与已验收的
      `backups/acceptance-*` 快照均保留。macmini 构建机上没有 miao 数据库文件，无需迁移。
- [ ] 事件日志保留/压缩（snapshot-then-truncate）。
- [ ] 按项目 blob GC（引用计数或 mark-and-sweep）。
- [ ] 验证 `db stats` 无 `message.part.updated` 膨胀、无内联 base64，且 `db vacuum`
      能回收体积。
- **验收：** 事件行数有界、无内联 base64、文件体积被回收。

---

## 5. 性能分析与报告

**状态：** partial（测量已完成，分析与报告未完成）。
- [ ] 用下载的 0.1.0 产物在同一夹具上运行，做受控的前后对比；产物路径记录在 2026-10-04
      交接文档中，不要在此硬编码临时路径。
- [ ] 审计批量按键的输入计时关联；当前收据逻辑可能覆盖 pre-update 收据，因此结果不能
      称作 per-key 延迟。
- [ ] 分析 RSS/原生分配与对象归属；补充 Session 切换/创建/关闭生命周期场景。
- [ ] 产出双语最终性能报告，附原始证据链接与边界说明。
- [ ] 厘清 `shutdown.forced: true` 结果（五秒 SIGTERM 等待）并确认优雅退出，区分应用
      行为与 PTY 排空行为。
- **验收：** 受控对比加书面报告；不对未证实的改进下结论。

## 6. 发布二进制验收

**状态：** open。
- [ ] 验收已发布的 **Windows 0.1.4** 产物并从 0.1.2 升级；确认该产物中的 provider 报错
      与 inbox 恢复。
- [ ] 在已发布二进制中验收出站消息卡片与跨进程收发行为。
- [ ] 针对确认循环引导，演练真实的 Multi-Session 行为（live soak）。
- [ ] 观测真实瞬时 TLS 故障的恢复（分类已发布并有单测）。
- [ ] 确认 Go 付费请求成功（需在 OpenCode workspace Privacy 中开启 **Global**）。
- [ ] 对照当前 `main` 重新评估较早的非阻塞 Windows 浏览器 E2E 失败。

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

## 横切规则

- 所有变更都通过短线分支的 PR 落地；`main` 受保护。
- 在配置好的构建机上编译，绝不在本地编译。
- 从包目录运行 `bun typecheck` 与受影响的包测试。
- 任何公开 Protocol/Server `HttpApi` 变更后，从 `packages/client` 运行 `bun run generate`。
