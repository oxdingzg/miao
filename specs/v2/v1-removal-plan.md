# 彻底去除 V1：方案与决策

状态：已定稿，2026-10-02。范围：P0–P7 全部纳入本轮（含非会话类旧路由）。

## 已定决策（2026-10-02 用户确认）

1. **范围**：P0–P7 全部做，P7 也纳入本轮。
2. **旧插件钩子**：只迁内置插件；第三方旧钩子宣布废弃；补 V2 版 `tool.execute.before/after`。
3. **share**：删除（fork 没有自己的分享服务）。
4. **`miao github` / `miao pr` / `github/` Action**：`miao pr`（检出 PR 再运行 miao）迁到 V2；`miao github` 与 GitHub Action 删除。
5. **旧会话迁移**：新版本启动时自动 backfill（先自动备份）；`compact` 永远保持手动。
6. **指令来源**：V2 兼容读取 `AGENTS.md`、`CLAUDE.md`（含 `~/.claude/CLAUDE.md`）、`CONTEXT.md` 与 `instructions` 配置，与 V1 一致。
7. **`--mini`**：迁到 V2 并保持现有体验。
8. **app 的每轮 DiffSummary 与 inline comment**：在 V2 实现每轮 DiffSummary；inline comment 若 V2 无对应模型则删除（实施前单独确认）。
9. **Copilot / Azure / Bedrock / Vertex**：删 V1 之前在 V2 补齐，避免能力倒退。
10. **旧库文件**：P3 在副本上验证通过、真库压缩并观察一周后，再删除 `miao.db.bak-20261001`、`*.compacted-*` 等（删除前确认）；macmini 等其他机器上的 miao 库纳入迁移清单。
11. **`packages/web` 文档**：迁到 mtty.dev 后删除；`sdks/vscode` 删除。
12. **CI**：typecheck CI 在 main 上运行，作为每个删除阶段的硬门槛。

执行约束：编译、打包、全量测试在构建机上进行（macmini：macOS；xx02/xx01：Ubuntu；192.168.3.96：Windows），不在开发者本机进行；全量测试以 CI 为准。优先项：先修 MCP 工具调用不再询问权限的安全退步（P1 第一项）。

进展（2026-10-02）：P4 第 1 步的客户端回退已移除——TUI 源码中全部 `Flag.MIAO_TUI_V2` 分支删除，`MIAO_TUI_V2` 开关从 `core` 移除；app 的 `?protocol=v1`、`createV1Api` 运行时与 `CompatibleApi` 的 legacy 类型全部删除（`CompatibleApi = ServerApi`，调用点去掉 V2 不支持的 `agent`/`model`/`variant`/`legacyParts`），API 选择不再依赖协议探测；`run.ts`/`pr.ts`/`session.ts` 的开关引用清理。TUI 测试夹具已迁到 V2，`packages/tui` 366 pass/0 fail，`core`/`tui`/`app`/`miao` typecheck 通过。
注意：app 里仍有一批 `protocol === "v1"` 守护的 V1 专属功能路径（terminal `pty.shells`、custom provider、`project.update`、legacy `session.update` 归档、`path.get` 兜底等）。它们用的是 legacy client，而对应 `/api/*` 路由尚未迁移，因此本轮**不能**删除，留到 P7 非会话旧路由迁移后处理。服务端 V1 路由与 `packages/miao/src/session|tool` 同样待 P3 压缩与 R1 soak 之后删除。

进展（2026-10-02，P3 前置）：已实现 `miao db restore --merge-from <db>`（`packages/core/src/session/restore.ts` + CLI），按主键并集把另一 miao 库的 `project`/`project_directory`/`session`/`session_message`/`session_input`/`session_context_epoch`/`todo`/`session_share`/`event` 合并进来，`event_sequence` 取两库最大值，父表先于子表插入，只做 `INSERT OR IGNORE` 不覆盖已有行，支持 `--dry-run`。覆盖测试在 `packages/core/test/session-restore.test.ts`（3 pass）。这是压缩真库前回滚流程 `miao db restore --merge-from <compact-clone>` 的工具。

进展（2026-10-02，P1 完成 + run.ts 死码清理）：核对确认 P1 各项已由近期提交完成——`edit` 询问带 diff，`edit`/`write`/`apply_patch` 均带 LSP 诊断，V2 bash 接 `shell.env`，`summary_*` 由 projector 写入，`stats` 在 core `SessionStats` 按 root 会话树去重，`export`/`import` 已用 V2 投影；codex/copilot 的逐请求头已在 `packages/core/src/session/runner/provider-headers.ts`（copilot `X-Interaction-Id`/`x-initiator`/vision、openai `session-id`）与 `runner/model.ts`（codex `originator`/UA、copilot `X-GitHub-Api-Version`/`anthropic-beta`）实现，codex 的 `chat.params` 在 V2 天然等价（openai 协议不消费 `limits.output`）。另外删除了 `miao/src/cli/cmd/run.ts` 中因 `sessionsV2` 恒真而不可达的 V1 分支（`session`/`createFreshSession` 的 V1 体、`loop`、`if (!interactive)` headless-V1 循环，-326 行）；`test/cli/run` 226 pass，help 快照已更新。

进展（2026-10-02，P3 主库完成）：真库 `~/.local/share/miao/miao.db` 已压缩（2746 MB → 574 MB，`quick_check` = ok，`message`/`part` 已删），已装正式版 `miao` 0.0.34 可正常读取。正确克隆方式是 `sqlite3 <db> ".backup '<clone>'"`（禁止 `cp -c`，WAL 热拷贝会损坏）；克隆校验用 `sqlite3 <clone> "PRAGMA quick_check;"`（**不要加 `-readonly`**，WAL 目标会误报 error 14）。`db compact` 已加 `PRAGMA quick_check` 前置守卫。`miao-main.db`（preview 通道）尚未压缩。

进展（2026-10-02，P7 开始）：TUI 已把 `find.files`→`v2.fs.find`、`path.get`→`v2.location.get`、`project.current/directories`→`v2.project.*` 迁到 V2（`packages/tui` 367 测试通过）。P7 清单与缺口（`config`/`mcp`/`lsp`/`vcs`/`formatter`/`experimental-workspace`/`instance-app`/`sync` 尚无 `/api/*` 组）见 `specs/v2/p7-non-session-routes.md`；补齐这些 V2 端点并迁移客户端是下一步主体。

进展（2026-10-03，P4 会话运行时删除）：`packages/miao/src/session` 与 `packages/miao/src/tool` 已删除；V1 会话路由组 `session`/`permission`/`question`/`sync` 及其 handlers 从 assembly 移除（`legacy-route` 中间件保留，仅用于观测）。`packages/core/src/v1`（config/permission/session）与 core 的 `backfill`/`compact`/`v1-read`/`legacy-tables`/`restore` 保留，用于读取旧库以及 `miao db backfill`/`compact`/`restore`。`miao github` 已删除，`miao pr` 保留。剩余：旧 JS SDK（P5）与 `config`/`mcp`/`lsp` 等非会话旧路由（P7）。

进展（2026-10-03，按代码重新盘点）：P7 已补 `config`/`vcs`/`lsp`/`formatter`/`mcp`/`workspace`/`control-plane`/`capabilities` 的 `/api/*` 组，TUI 只剩 console/org 切换的 4 处 V1 调用。app 是 P7 的主体：约 25 处 legacy SDK 调用；项目重命名、目录选择、配置读取、自定义 provider 在 V2 下静默失效；新 API 走的是 vendored 上游 `@opencode-ai/client` 1.17.13，与 miao 路由不一致（`/api/vcs/diff`、`/api/project` 等 miao 未提供）。详见 `specs/v2/p7-non-session-routes.md`。P0 仍有 `web`/`console`/`enterprise`/`stats`/`function`/`slack` 六个包未删；`miao-main.db` 未压缩。

进展（2026-10-03，交接）：

- SDK 的 V1 根导出、`src/gen`、旧 smoke test 和 `duplicate-pr.ts` 已删除并重新生成 `/v2` SDK；插件类型、run 的 prompt 类型与 SDK 示例已调整。旧 Copilot `chat.*` 钩子及其测试删除，V2 provider-request 测试仍覆盖逐请求头。迁移指南写入 CHANGELOG。非会话 legacy SDK 命名空间仍在，P7 尚未完成。
- app 的五处归档操作改走 V2；新增 `/api/fs/content`，TUI diff 高亮已迁移。原生 V2 e2e 夹具已添加，reasoning、reducer、transport 三个 spec 共 18 个测试恢复。它们发现并修复了内容按 ID 排序、idle 事件未更新状态以及加载历史后新 stream 覆盖原内容的问题。
- P6 剩余：其余 `LEGACY_V1_FIXTURE` 用例和 performance 夹具；每轮 DiffSummary / inline comment；原生附件与引用的渲染归一化；`server-session` 的旧投影 unit-test adapter 及 V1 事件兼容层。不要只删 fixme 而不迁移夹具。
- P7 进展（2026-10-03）：console 删除；PTY、config 写入、project 元数据、worktree、MCP OAuth 迁到 `/api/*`；服务端只挂 V2 路由，V1 路由树已删除（见 `v2-only-routes.md`）。剩余：第 2 层——迁走 V2 路由仍依赖的 V1 桥接服务（`Plugin`、`Provider`、`EventV2Bridge`、`WorkspaceV2Bridge` 等）与 `AppRuntime` 的 V1 层，发布二进制改用 `packages/server` 装配。
- P3 已完成 `miao-main.db` 的一致性备份与副本 backfill / compact 演练。备份和压缩副本分别位于 `~/.local/share/miao/retirement-20261003/main-before.db`、`main-rehearsal.db`。副本 2230.4 MB → 254.1 MB，删除 104297 个 legacy event 和 2 张表；`quick_check` 为 ok，foreign-key 检查无输出；59 个 session、8964 个 session_message、134 个 session_input、24 个 context epoch 的逐行双向 EXCEPT 均为 0，session list / stats 冒烟通过。
- **真库未压缩**：4132 服务仍运行 `0.0.21`，并打开 `miao-main.db`；升级并重启这个旧读写进程之前不能删除真库的 message / part。本次未停止服务、未删备份、未开始一周观察；restore 合并演练也尚未执行。检查过的构建机默认数据目录未发现需要迁移的 miao 库，不能据此断言其他目录或用户下没有库。

另：本次还修复 Windows 自升级。`curl` 安装布局在 Windows 改用内嵌原生 PowerShell，支持系统代理、验证 ZIP 内 exe 的版本、运行中替换及失败回滚；发布 workflow 增加 Windows 实机回归和 x64 baseline 资产。Windows 集成演练与版本检查通过，但修复尚未发布，不能让旧二进制自动获得新升级器。

---


状态：草案，2026-10-02，待用户审阅后决定是否入库（建议入库位置 `specs/v2/v1-removal-plan.md`，并在
`specs/v2/v1-retirement.md` Stage 5 处链接）。

依据：`miao/main` @ `c16645b20`（阅读用 detached worktree）；用户日常库 `~/.local/share/miao/miao.db`
的 `.backup` 副本（只读分析，另在 `cp -c` 克隆上实跑 backfill + compact）；已安装正式版 `~/.miao/bin/miao`
0.0.33 在副本 / 压缩副本上的实测。凡是"读代码推断、未实际运行"的结论标【未核实】。

---

## 0. 结论摘要

- **V1 不只是 `--mini` 和 ACP。** 发布的 `miao` 二进制里，TUI worker、`miao run`、ACP、`serve`、`web`、`remote`
  用的都是同一个 V1+V2 合并的 server assembly（`packages/miao/src/server/routes/instance/httpapi/server.ts`）。
  28 个 `effectCmd` 子命令都跑在 `effect/app-runtime.ts` 上，而它会构建完整的 V1 会话层
  （`Session`、`SessionPrompt`、`SessionProcessor`、`LLM`、`ToolRegistry`、`SessionShare`……）。
  V2-only 的 `packages/server` 只有 `packages/cli` 用，而这个 fork 不发布 `packages/cli`。
- **实测：压缩后的库上，仍有 4 个 V1 入口不可用**（0.0.33，压缩克隆）：
  - ACP `session/load` 报 `Internal error … service: session`；
  - `miao stats` 报 `the V1 message API reads legacy storage…`；
  - `miao import` 报 `importing a V1 session archive needs the legacy message / part tables…`；
  - `--mini` 按代码推断同样会坏（与 2026-10-01 事故一致；交互式，未实跑）。
  - `miao export` 可用但有损：22 个 part 变成 8 个，step-start / step-finish 丢失。
- **未压缩的库上，ACP 同样看不到 V2 会话的历史。** 实测：一个有 450 条 `session_message` 的 V2 会话，
  `session/load` 只回放了 1 条 `session/update`。也就是说，现在用 ACP（Zed）打开在 TUI 里创建的会话，
  看到的就是空历史。
- **V2 自身还有会被用户感知的缺口**，删 V1 之前应先补：
  - MCP 工具调用不走权限询问（安全回退）；
  - edit 的权限询问不带 diff；
  - 没有 BashArity 前缀审批；
  - V1 风格插件钩子全部不触发（`chat.params` / `chat.headers` / `tool.execute.*` …），
    custom tool（`.miao/tool/*.ts`）也不加载；
  - 指令只认 `AGENTS.md`，不认 `CLAUDE.md`、`CONTEXT.md` 和 `instructions` 配置；
  - 没有标题生成，没有 status/retry 推送事件，没有 structured output；
  - `miao stats` 会重复计算子会话费用。
- **数据迁移本身风险低、速度快（实测）。** 日常库 2.4 GB，其中 77 个会话（11,826 条消息）只有 V1 数据：
  - `backfill --verify`：0 个失败；
  - backfill 用 4.5 秒；
  - compact 用 39 秒，2,610 MB → 439 MB。
  - 真正的风险是顺序：所有会打开这个库的二进制都必须先换成不依赖 `message` / `part` 的版本。
- **总工作量估计：不含 P7（非会话类旧路由）约 48–75 人日，含 P7 约 58–90 人日。** 关键路径（补缺 → 客户端迁 V2 →
  压缩 → 删运行时）约 32–46 人日；其余是 e2e 重写、插件 API 和 SDK、非会话类旧路由。比 `specs/architecture.md` 里 Phase 1 的
  "3–4 周"多，主要多在第 5、6 节说明的三项：插件 / SDK 破坏性变更、非会话类旧路由、e2e。

---

## 1. V1 依赖清单

### 1.1 入口逐项

路径相对 `packages/`。

| 入口 | 现状 | 证据 |
|---|---|---|
| `miao --mini` / `attach --mini` | **全 V1** | `miao/src/cli/cmd/tui.ts:159-182` → `runMini`（`cli/cmd/run.ts:1078`）。`run.ts:274-276` 注释写明 "interactive --mini still renders V1 events"。会话解析用 `sdk.session.get/fork/list/create`（`run.ts:462-596`）；运行时用 `session.abort`、`permission.reply`、`question.reply/reject`、`experimental.session.background`（`run/runtime.ts`）；历史回放用 `session.messages/children/status`（`run/stream.transport.ts:603-803`，`session-replay.ts` 合成 `message.updated` / `message.part.updated`）；发送用 `session.promptAsync/shell/command`。事件订阅 `sdk.global.event`，消费的是 V1 事件 `message.part.delta/updated`、`session.status`、`permission.asked` 等，V2 事件只用到 `session.next.shell.*`。`run/tool.ts` 还 type-import 了 16 个 V1 工具模块。`cli/cmd/run/` 共 38 文件、约 1.88 万行 |
| ACP（`miao acp`） | **全 V1** | `cli/cmd/acp.ts:20-27` 起 V1 assembly。`acp/service.ts` 调 `session.create/get/messages/list/abort/fork/prompt/command/summarize`；`acp/event.ts:153` 订阅 `global.event`，按 `message.part.updated/delta`、`session.status`、`permission.asked` 分支；`acp/permission.ts:92` 用 V1 `permission.reply`；`acp/content.ts:4` 引 `SessionV1`。ACP 终端 API 没有用到。共 12 文件、3,661 行 |
| `miao run`（headless） | **V2 为主** | `run/headless.ts` 全用 `client.v2.session.*` 和 `session.next.*`。残留：`MIAO_TUI_V2=0` 时回落 V1 循环（`run.ts:929-973`）；`--share` 只有 V1（`run.ts:874-878`）；本地模式和 `--attach` 仍挂在 V1 assembly 上（`run.ts:1044-1057`） |
| 默认 TUI | **会话读写已 V2**（`MIAO_TUI_V2` 默认开） | 开关在 `core/src/flag/flag.ts:82-84`。V2 开启时仍走 V1 的调用：`dialog-workspace-create.tsx:139` 和 `prompt/move.tsx:139` 的 `session.promptAsync`；`routes/session/index.tsx:1080` 的 `experimental.session.background`；`prompt/move.tsx:36` 的 `projectCopy.generateName`（handler 用 V1 `@/session/llm`）；`miao/src/cli/tui/validate-session.ts:24-29` 的 `session.get`（每次带 `--session` 启动都会调）。`sync.tsx:297-669` 里的 V1 事件处理器都没加开关。非会话类请求（config/provider/mcp/lsp/command/vcs/find/path/project/workspace）都走旧路由 |
| `MIAO_TUI_V2=0` | 整条 V1 回退路径 | TUI 约 30 个 `Flag.MIAO_TUI_V2` 分支；测试夹具强制 V1（`tui/test/fixture/tui-sdk.ts:6`） |
| app / desktop / web | **默认 V2**，保留 V1 shim | `app/src/utils/server-protocol.ts:24-51` 做探测，`?protocol=v1` 可强制 V1；`utils/server-compat.ts:125-` 的 `createV1Api` 是整套 V1 shim。**没有协议开关、始终走 V1 的调用**：share/unshare（`use-session-commands.tsx:201,221`、`message-timeline.tsx:662,669`）；导出（`utils/session-export.ts:24-25`，调 `session.get` + `session.messages`）。另有 V1 事件形状的兼容层：`server-sdk.tsx:40-69` 把新事件重新包装成 `permission.asked` / `message.part.updated`，交给 `server-session.ts` 的 V1 reducer。`app/V1_API_MIGRATION.md` 还有 27 项未完成 |
| `miao export` | 混合 | `cli/cmd/export.ts:322-358`：有 V1 表就读 V1，再与 V2 投影合并，输出 V1 `{info, messages:[{info, parts}]}` 格式。压缩库上可用但有损（实测，见 §3） |
| `miao import` | **全 V1 写入** | `import.ts:180-236` 直接写 `SessionTable`、`MessageTable`、`PartTable`。压缩库上直接失败（实测）；未压缩库上导入后的会话是 `legacy`，V2 拒绝续跑，必须先 `db backfill` |
| `miao stats` | **V1 读取** | `stats.ts:85,167` 用 `Session.messages`，即 `MessageV2.page`，读的是 V1 表。压缩库上失败（实测）；V2 会话的按模型 / 按工具统计全是 0【未核实】 |
| `miao session list/delete` | V1 Service | `session.ts:61,87`。只读写 `session` 表，压缩后 list 可用（实测） |
| `miao github` / `miao pr` | **全 V1、进程内** | `github.handler.ts:382-384,504,854,902,951`：`Session.create`、`SessionPrompt.prompt`、`SessionShare`，并订阅 `MessageV2.Event.PartUpdated`。`pr.ts:82` 会再调起 `miao import` |
| `serve` / `web` / `remote` / `generate` | V1+V2 合并 assembly | `serve.ts:14`、`web.ts:39`、`remote.ts`、`generate.ts:9` |
| 插件运行时 client | V1 根 SDK | `miao/src/plugin/index.ts:10,150-155` 用 `@opencode-ai/sdk` 根导出的 `createOpencodeClient` 访问 `Server.Default()` |
| 插件钩子（V1 `Hooks`） | **只有 V1 代码触发** | `core/src` 里没有任何 `.trigger(`。见 §2.1 |
| `@opencode-ai/plugin` 类型 | 依赖 V1 SDK 类型 | `plugin/src/index.ts:1-12` 从 V1 根导出引入 `Event`、`Message`、`Part`、`Permission`、`Config`、`createOpencodeClient`。去掉 V1 根导出 = 第三方插件 API 的破坏性变更 |
| 旧版 JS SDK `packages/sdk/js` | V1 根导出 + `/v2` 导出 | V1 `src/gen` 已冻结。根导出的消费者：plugin、`miao/src/plugin/index.ts`、`test/server/sdk-v1-smoke.test.ts`、`slack`、`github/`、`script/duplicate-pr.ts`。注意：**`/v2` 导出也大量调用无前缀的旧路由**；按文件计，app 99、tui 56、miao 51、session-ui 16 个文件 import 它。真正的替代者是 `packages/client`（`@miao/client`，只覆盖 `/api/*`）和 `packages/sdk-next`（尚无消费者）。这个 fork 的 release 不发布 SDK 到 npm（`publish.yml` 有上游仓库守卫） |
| core 内的 V1 层 | 数据迁移依赖 | `core/src/v1/`（19 文件、1,349 行：`session.ts`、`permission.ts`、`config/*`）和 `schema/src/v1/`（`session.ts` 676 行等）。`core/src/session/{projector,backfill,compact,v1-read,legacy-tables,store}.ts` 依赖它做 V1→V2 投影和回退读取。`v1/config/migrate.ts` 是 V1 配置兼容层，V2 配置加载会直接调用（`core/src/config.ts:182-185`） |

### 1.2 只被 V1 自身或测试引用的代码

- 不被 core、server、tui、cli 任何一个引用：整个 `packages/miao`。依赖方向是单向的，`packages/miao` → core。
- 只在 `session/` 与 `tool/` 内部互相引用：
  - `session/` 下：`llm/{ai-sdk,native-request,native-runtime,request}`、`message-error`、`overflow`、
    `reminders`、`retry`、`system`、`tools`。
  - `tool/` 下：`code-mode`、`external-directory`、`mcp-websearch`、`sandbox`、`schema`、`shell/*`、
    `truncation-dir`。
- 被 V1 外围引用、删运行时时要一起改的：
  - `effect/app-runtime.ts`：所有 effectCmd 都走它，这是最大的耦合点；
  - `server/routes/instance/httpapi/*`：56 文件、7,025 行；
  - `control-plane/workspace.ts:25,157,584,797`（`SessionPrompt.cancel`、`Session.remove`）；
  - `share/*`；
  - `image/image.ts`、`plugin/github-copilot/copilot.ts`（引 `message-v2`）；
  - `agent/agent.ts`（引 `truncate`）；
  - `patch/index.ts` → `tool/native`；
  - `index.ts:20` → `tool/sandbox-runner`。
- `packages/miao/src/tool/shell.ts` 和 `tool/shell/*` **V2 完全不用**，只有 V1 registry、`session/prompt.ts:39`
  和 `cli/cmd/run/tool.ts:21`（type）引用。BashArity（`miao/src/permission/arity.ts`）也只有它在用。
- 规模（只算 `.ts`/`.tsx`）：

  | 目录 | 行数 |
  |---|---|
  | `miao/src/session` | 8,143 |
  | `miao/src/tool` | 5,427 |
  | `miao/src/server` | 7,708 |
  | `miao/src/acp` | 3,661 |
  | `miao/src/cli/cmd/run` | 约 18,800 |
  | `miao/test` 合计 | 约 101,000 |

  测试里与 V1 强相关的：`test/session` 15k、`test/server` 14k、`test/tool` 9.3k、`test/acp` 4.4k、
  `test/cli` 16.8k（部分）。

### 1.3 上游未用包：可直接删除（依据）

这个 fork 的发布路径只有 `script/release` → `release.yml` → `packages/miao/script/build.ts --single`
（内嵌 `packages/app`，不是 `packages/web`）。`install-local.sh` 也只构建 `packages/miao`。下面这些包在发布路径上都用不到。

| 目标 | 规模 | 依据 | 建议 |
|---|---|---|---|
| `packages/console/*`（6 包） | 589 文件 / 222k 行 | 没有被 import；只在 `infra/console.ts` 和根脚本 `dev:console` 里出现 | **现在删**；从 workspaces、`dev:console` 移除 |
| `packages/stats/*`（3 包） | 115 / 39k | 只被 `infra/stats.ts`、`stats.yml` 引用，后者有上游仓库守卫，fork 里不会运行 | **现在删**，连同 `stats.yml`、`script/stats.ts`（删前确认一下这个脚本本身） |
| `packages/function` | 6 / 482 | 没有被 import；`turbo.json` 的 `@miao/function#test` 会在 `test.yml` 里跑。CLI 调用的是上游已部署的端点（`github.handler.ts:998`），与本地代码无关 | **现在删**，同时去掉 `turbo.json` 那一项 |
| `packages/enterprise` | 36 / 1.7k | share 查看器，只部署到上游；CLI 只用 `enterprise.url` 配置值 | **现在删** |
| `infra/` + `sst.config.ts` + `sst-env.d.ts` + `deploy.yml` | 8 / 1.3k | SST app 名为 opencode，AWS profile 是 `opencode-*`；`deploy.yml` 有上游守卫 | **现在删**；同时检查根 devDependencies 里的 `sst`【未核实】 |
| `packages/web` | 705 / 224k | 没有被 import；`docs-*.yml` 是 `if:false` 或有上游守卫。唯一耦合是 `astro.config.mjs:321` 调用 `../miao/script/schema.ts` | **现在删**（先确认不需要它的文档内容；mtty.dev 已是独立站点【未核实其来源】） |
| `packages/slack` | 7 / 208 | 用 V1 根 SDK（`src/index.ts:2`），在 workspaces 里单独列出，没有被 import | **现在删**；也顺带去掉一个 V1 SDK 消费者 |
| `packages/containers` + `containers.yml` | 8 / 123 | workflow 只在 `dev` 分支触发，不会在 main 上运行；没有任何 workflow 用这些镜像 | **现在删** |
| `packages/identity`、`packages/docs` | 6 张图 / 24 文件 | 没有任何引用；docs 是 Mintlify 模板，内含一份过期的 `openapi.json` | **现在删** |
| `github/`（GitHub Action）+ 2 个 action workflow | 10 / 1.3k | 用 V1 根 SDK；`github install` 写入的是 `anomalyco/opencode/github@latest`（`github.handler.ts:367`），本地这份没有被使用 | 除非要发布 miao 自己的 Action，否则**删**（需同时处理 `github.handler.ts:367` 和 `raw-changelog.ts`） |
| `sdks/vscode` + `publish-vscode.yml` | 16 / 358 | 发布的扩展 ID 是 `sst-dev.opencode`，与 `ide/index.ts:40` 安装的 `sst-dev.miao` 对不上，IDE 安装本来就是坏的 | 除非要做 miao 扩展，否则**删** |
| `packages/storybook` | 28 / 1.2k | ui 和 session-ui 的开发工具 | 保留（可选） |
| `packages/desktop` | 306 / 9.6k | Electron 外壳，被 nix、`publish.ts`、CODEOWNERS 引用 | **保留** |

另：`typecheck.yml` 只在 `dev` 分支触发，**main 上没有 typecheck CI**（对删除大量代码的工程是风险，建议 P0 一并修）。
`packages/core` 引用了 `@opencode-ai/sdk/v2/types`，却没在 `package.json` 里声明依赖（靠依赖提升碰巧能解析）。

---

## 2. 功能缺口（V2 相对 V1）与补齐方案

工作量标记：S < 1 人日；M 1–3 人日；L > 3 人日。

### 2.1 插件钩子

V2 插件上下文（`core/src/plugin/host.ts:28-218`）只有 `agent`、`aisdk`、`catalog`、`command`、`integration`、
`reference`、`skill`，没有 chat、tool、permission、shell 这类钩子。V2 runner 用 `@miao/llm` 组装请求，
`AISDK.language` 钩子只在 V1 `session/llm.ts` 里用到，所以对 V2 runner 不起作用。

| 钩子 | V1 触发点 | V2 | 补齐方案 / 工作量 |
|---|---|---|---|
| `chat.headers` | `session/llm/request.ts:135` | 只在 `runner/llm.ts:372-380` 硬编码了 `session-id`（b70bbcb44） | 内置实现方有 codex（originator、UA、title 回落标记，`plugin/openai/codex.ts:559-567`）和 copilot（`X-GitHub-Api-Version`、`X-Interaction-Id`、anthropic-beta，`copilot.ts:360-372`）：迁成 V2 provider plugin 的请求头选项，S。V2 请求现在是否已带 originator【未核实】（`core/src/plugin/provider/openai.ts:271` 写的是 `"opencode"`） |
| `chat.params` | `request.ts:115` | 缺失 | 内置只有 codex（去掉 `maxOutputTokens`）和 cerebras：S |
| `chat.message`、`experimental.chat.system/messages.transform`、`experimental.session.compacting`、`compaction.autocontinue`、`text.complete`、`command.execute.before` | `prompt.ts`、`compaction.ts`、`processor.ts`、`agent.ts:382` | 缺失 | 内置插件都没用到。要么在 V2 插件 API 里正式设计 transform 钩子（L），要么宣布废弃（S）。**需决策（§5-2）** |
| `tool.execute.before/after`、`tool.definition` | `session/tools.ts:107-421`、`tool/registry.ts:318` | **已补（P1-C）**：`ctx.tool.before/after/definition`（`core/src/tool/plugins.ts`，在 `ToolRegistry` settle 前后、materialize 时触发） | before 可改参数或抛错拒绝，after 可改输出；钩子出错只让该次调用变成工具错误，不让会话失败 |
| `shell.env` | V1 bash、`!cmd`、PTY | PTY 已支持；V2 bash 缺失（`core/src/tool/bash.ts:133` 有 TODO） | S |
| 插件 `tool` 与 `{tool,tools}/*.ts` 自定义工具 | `tool/registry.ts:181-202` | **已补（P1-C）**：`core/src/tool/custom.ts` 按 V1 规则加载，插件用 `ctx.tool.register` 提供；每次调用先走 PermissionV2（动作名 = 工具名），首次 materialize 时才导入 | 本仓库 `.miao/tool/github-pr-search.ts`、`github-triage.ts` 已在 V2 下加载（`core/test/tool-custom.test.ts`） |
| `event` | `plugin/index.ts:260` | 能收到 V2 事件，但类型是 `session.next.*`，没有 `message.part.updated` | 语义变化，写进变更说明即可 |
| `permission.ask` | 声明了但从未触发（V1 也没有） | — | 直接删 |
| 旧式插件加载（函数返回 `Hooks`） | `project/bootstrap.ts:38` | V2 loader 只接受 `{id, effect\|setup}` 形状 | 按决策 2 废弃：V2 不加载，配置时记一次 warning（`config/plugin/external.ts`），`@opencode-ai/plugin` 的 `Plugin`/`Hooks` 标 `@deprecated` |

**V2 支持的插件钩子**（决策 2 落地后）：`agent`、`catalog`、`command`、`integration`、`reference`、`skill` 的
transform / reload，`aisdk.sdk` / `aisdk.language`，以及 `tool.before` / `tool.after` / `tool.definition` / `tool.register`。
旧式 `Hooks` 里其余的第三方钩子在 V2 下不触发，视为废弃；内置插件用到的部分迁移情况见下。

内置插件（`miao/src/plugin/index.ts` 的 `internalPlugins`）用到的 V1 钩子与去向：

| 内置插件 | V1 钩子 | V2 去向 |
|---|---|---|
| codex（openai） | `auth`、`provider`、`chat.headers`、`chat.params` | ChatGPT OAuth 与模型已在 `core/src/plugin/provider/openai.ts`（V2 integration）；`chat.*` 由 P1-D 迁进 provider |
| copilot | `auth`、`provider`、`chat.headers`、`chat.params`、`experimental.provider.small_model` | 模型/SDK 在 `provider/github-copilot.ts`；但 V2 integration 没有 Copilot 的 OAuth 登录方法（只有 openai、opencode、tencent-token-plan 注册了 OAuth），属决策 9 / P1-D；`chat.*` 由 P1-D 负责；`small_model` 只用于标题生成，随 P1「标题生成」一起做 |
| cerebras | `chat.params` | P1-D |
| azure、cloudflare（两个）、snowflake-cortex、xai、gitlab（npm） | `auth`、`provider` | V2 已有同名 provider 插件（模型/SDK）；登录依赖 models-dev 的 env/key 方法，V1 `auth` 钩子里的自定义提示与 OAuth 是否齐全【未核实】，属 provider 范围，本任务未改 |
| modal、digitalocean、poe（npm） | `auth`、`provider` | V2 **没有**对应 provider 插件，属 provider 范围（P1-D / §2.4），本任务未改 |
| miaotty | `event` | 只认 `session.status` / `session.idle` / `session.error` 和 `permission.*` / `question.*`；V2 runner 还不发 status 事件，busy/idle 依赖 P1「status / retry / error 推送事件」，暂时只能报告权限与提问状态 |

没有内置插件用到 `tool.*`、`shell.env`、`chat.message`、`command.execute.before`、`permission.ask` 或 `experimental.*`（除 copilot 的 `small_model`），
所以这些钩子废弃后内置功能不受影响。

用户本机全局 `~/.config/miao` 只装了 `@opencode-ai/plugin`，没有第三方服务端插件（实测）。
所以短期影响主要来自内置插件，以及本仓库 `.miao/tool` 下的两个自定义工具。

### 2.2 权限与工具

| 项 | V1 | V2 | 方案 / 工作量 |
|---|---|---|---|
| **MCP 工具权限**（安全） | 每次调用都 `ctx.ask`（`session/tools.ts:406`） | `core/src/mcp.ts:93-101` 直接 `callTool`；registry 只在规则整体 deny 时移除工具（已独立核对） | 在 `makeExternal` 的 execute 里加 `permission.assert`：**S，必须先做** |
| BashArity 前缀审批 | `permission/arity.ts`，加上 `tool/shell.ts:351-372` 的 tree-sitter 拆分子命令，"总是允许"会保存成 `git status *` 这样的规则 | `core/src/tool/bash.ts:130` 是 TODO。现在保存的是整条命令；25c8cc99d 只加了 `sh -n` 语法检查和 `stdin` | 把 tree-sitter 拆分和 arity 移进 core，`save` 与 `resources` 分开：M |
| edit 权限询问带 diff | V1 询问时附带 `metadata.diff` | V2 edit 在读文件之前就询问，只给了 `resources`（`core/src/tool/edit.ts:159-167`） | 先算 diff 再询问：S（ACP 和 TUI 的预览都需要） |
| LSP 诊断 | edit、write、apply_patch 之后都有 | 只有 write 有 | S |
| lsp 工具、plan_exit | 有（flag 控制） | 缺失（`builtins.ts:25-28` 有 TODO） | M |
| MCP resources、OAuth、超时、运行时 add | 有 | 缺失（protocol 里没有 MCP group） | M–L；ACP 的 `mcp.add` 依赖它 |
| task 的 background、嵌套 subagent、列出可用 agent | 有 | 只能同步，禁止嵌套（`llm.ts:728`） | M（可延后，不阻塞删 V1） |
| `invalid` 修复工具 | 有 | 无 | S 或不做 |

### 2.3 运行时行为

| 项 | 缺口 | 方案 / 工作量 |
|---|---|---|
| 标题生成 | V2 定义了 `title` agent 但没有调用方 | 在第一轮结束后调用并发布 `info.updated`：S–M |
| 指令来源 | V2 只读全局和逐级向上的 `AGENTS.md`（`core/src/instruction-context.ts:51,58`，已核对）。缺 `CLAUDE.md`、`CONTEXT.md`、`instructions` 配置（glob / URL）、读文件时的嵌套发现 | M。**需决策**要不要兼容 `~/.claude/CLAUDE.md`（V1 会读） |
| status / retry 推送 | 没有 `session.status` 推送；`SessionEvent.Retried` 的投影被注释掉了（`projector.ts:550`） | 发布 `session.next.retried`，并定义 busy/idle 状态事件：S。`--mini` 和 ACP 都需要 |
| 会话错误事件 | `step.failed` 只覆盖一部分 | S |
| structured output（`format: json_schema`） | V2 `session.prompt` 的 payload 没有这个字段 | M。目前仓库里调用方不多【未核实外部依赖】 |
| 单次 prompt 覆盖 system / tools / agent / model | 缺失（`specs/v2/session.md:140`） | M。ACP 的模式和模型切换已经可以用 `switchAgent` / `switchModel` 代替 |
| 命令模板里的 `` !`cmd` `` 展开、`@file`、subtask | V2 只支持占位符 | M |
| 每轮 diff 摘要（`summary.diffs`） | V2 只有整个会话的 `session.diff`。`summary_*` 列对 V2 会话是否更新【未核实】 | S–M。app e2e #6、#8 依赖它（见 §4 P6） |
| share | V2 完全没有（没有端点，也没有事件到 share 的映射），TUI 和 app 在 V2 下都隐藏了这个功能 | M（实现）或 S（删除）。fork 自己没有部署 share 服务（`infra/` 是上游的），**建议删除**，见 §5-3 |
| `miao stats` | 读 V1 表；还会把子会话费用重复计算（V2 的 `Step.Ended` 把用量累加到所有祖先，`projector.ts:140-150,533-535`，已核对；stats 又对所有会话求和） | 改读 `session_message`，只统计根会话：S–M |
| export / import | 没有 V2 导出端点；import 只写 V1 表 | 导出改成直接读 V2 投影，可以保留 V1 JSON 外形，或带版本号的新格式；import 把旧的 V1 归档经 `v1-read` 映射直接写成 V2 投影：M。注意 backfill 映射会丢 V1 的 compaction 标记、subtask part、assistant `info.error`，以及 step 粒度的用量（消息级 cost/tokens 保留）；**backfill 后旧会话第一次在 V2 上续跑，可能重放完整的压缩前历史**【未核实】 |
| V2 runner 的 provider 覆盖 | 只支持 `@ai-sdk/openai`、`anthropic`、`google`、`openai-compatible` 和已知的 base URL；Azure、Bedrock、Vertex、Copilot 没配 `api.url` 时会报 `UnsupportedApiError` | 用户在用的 openai(ChatGPT)、deepseek、tencent token plan 不受影响【未核实全部】。Copilot 用户删 V1 后会直接不可用：M |

### 2.4 配置兼容层

- V2 直接读 V1 形状的配置：`core/src/config.ts:182-185` → `core/src/v1/config/migrate.ts`。已映射的有：
  `autoshare`、`tools` 布尔值、旧 `permission`、`mode`、`agent.prompt`、`compaction.*`、`mcp` 等。
  **这一层在删 V1 运行时之后仍要保留**，它属于"读旧配置"，不属于"V1 运行时"。
- V2 缺失的：
  - `small_model`、`disabled_providers`、`enabled_providers`：能识别为 V1 键，但没有映射，会被静默忽略；
  - `{env:…}` / `{file:…}` 变量替换；
  - managed / `.well-known` 远程 / console 组织配置；
  - 旧 TOML 配置与 `tui-migrate`。

  前三项合计 M；managed / 远程配置按需（M）。
- `miao/src/config/config.ts:431-592` 和 `v2-compat.ts` 只为 V1 运行时服务（把 V2 键反向降级成 V1），
  随 V1 一起删。

### 2.5 `--mini` 迁 V2

- 现状：只有交互模式是 V1，headless 已经是 V2（`run/headless.ts`）。
- 方案：
  - 回放：用 `v2.session.context` 和 `history`，通过 TUI 已有的 `tui/src/context/session-v2.ts`
    （`sessionContextToMessages`）映射成现有 reducer 吃的 Message/Part 形状。
  - 实时：`session-data.ts` 和 `subagent-data.ts` 的 reducer 改吃 `session.next.*`（text/reasoning/tool
    的 delta、started/ended，以及 step、compaction）、`permission.v2.asked`、`question.v2.asked`。
  - 状态：补 §2.3 的 status / retry 事件。
  - `run/tool.ts` 的类型改用 core 工具的 input/metadata schema。V2 的 bash metadata 字段名和 V1 不同，
    渲染需要逐个工具核对。
- 工作量：M–L，4–6 人日。另需写一个回放测试：在压缩库克隆上打开一个 legacy 会话和一个 V2 会话，确认滚动区输出一致。

### 2.6 ACP 迁 V2

- 现有能力在 V2 上的对应：

  | ACP 需求 | V2 对应 |
  |---|---|
  | create / list / get / fork | 已有 |
  | load 回放 | 同 §2.5 的映射 |
  | prompt / command / compact / interrupt | 已有 |
  | 模式切换 / 模型切换 | `switchAgent` / `switchModel` |
  | 权限选项 | `once` / `always` / `reject` 对得上 |

- 缺口：
  - edit 询问时没有 diff，导致 `writeTextFile` 预览缺失（S）；
  - 没有 status 推送（S）；
  - 没有 `mcp.add`（M）；
  - ACP 终端 API 目前没用到，不阻塞。
- 方案：按 `specs/architecture.md`，把 ACP 放进一个只说 V2 协议的独立适配层（建议 `packages/acp` 或
  `miao/src/acp` 只依赖 `@miao/client`），以后可以换成 Rust 版 `miao-acp`。
- 工作量：L，5–7 人日。验收：Zed 中 new / load（legacy 与 V2 会话各一个）/ prompt / 审批 / 取消 / fork，
  全程在压缩库克隆上进行。

---

## 3. 数据迁移

### 3.1 日常库现状（`.backup` 副本，2026-10-02 12:19）

| 项 | 数值 |
|---|---|
| 文件大小 | 2.44 GB |
| 会话 | 112 个：77 个只有 V1 数据（其中 29 个是子会话）、34 个 V2、1 个空，**没有 mixed** |
| V1 `message` / `part` | 11,826 / 50,413 行。时间范围 2026-09-27 ~ 2026-10-01 20:48，之后没有新的 V1 写入 |
| part 类型（MB） | tool 172、file 79（112 个内联 base64 附件）、reasoning 20、text 2，另有 step-start/finish 约 2.2 万个、patch 2,011 个、compaction 14 个 |
| 占空间的表 | `event` 1,831 MB，其中 `message.updated.1` 1,250 MB（45,465 行）、`message.part.updated.1` 360 MB（120,237 行）；`part` 304 MB；`message` 81 MB；`session_message` 66 MB |
| 其他 V1 遗留事件 | `session.updated.1` 12,428 行（7 MB）、`session.created.1` 78 行。V2 会话不再产生这两种事件（已核对：V2 会话 0 行）。`db compact` **不删**它们 |
| `session_share` / `permission` | 0 / 0 |

其他通道的库（只读打开）：
- `miao-main.db`（preview 通道）：2.1 GB，35 个 legacy 会话；
- `miao-local.db`（dev 通道）：已经没有 `message` 表，即已压缩；
- 另有 `miao.db.bak-20261001`、多个 `*.compacted-*` 旧文件，共约 3.5 GB，可清理（需用户确认）。

其他机器（如 macmini）上是否有 miao 库【未核实】。

### 3.2 克隆上实跑（0.0.33）

```
miao db backfill --dry-run   → would backfill 77 session(s), repaired 0 mixed session(s)
miao db backfill --verify    → verified 11826 message(s) across 77 session(s) — 0 failure(s)   (6.8s)
miao db backfill             → backfilled 77 session(s)                                         (4.5s)
miao db compact --yes        → before 2609.7 MB → after 438.8 MB; deleted 165702 legacy events, dropped 2 tables (39s)
压缩后：session_message 345 MB，event 84 MB
```

在压缩克隆上验证各入口：

| 入口 | 结果 |
|---|---|
| `miao session list` | ✅ |
| `miao export <legacy 会话>` | ✅ 但 part 从 22 个减到 8 个（step-start / step-finish 丢失） |
| `miao stats` | ❌ `the V1 message API reads legacy storage that miao db compact retired` |
| `miao import` | ❌ `importing a V1 session archive needs the legacy message / part tables…` |
| ACP `session/load` | ❌ `Internal error: OpenCode service failure, service: session` |
| ACP `session/load`（**未压缩**库、V2 会话） | ⚠️ 450 条消息只回放了 1 条 update |

`--mini` 是交互式，没有实跑；按代码推断会坏（与 2026-10-01 的事故一致）。

压缩后 439 MB，没有达到 `<200 MB` 的验收线：`session_message` 345 MB 里含内联 base64 附件和大块工具输出。
这需要 blob 外置（checklist §6，`Blob` store 已经有了但还没接上），**不在本方案内**。

### 3.3 迁移策略（顺序是硬约束）

依据记忆 `compacted-db-needs-shipped-guard`："盘上格式变更必须先随 release 发布、并装到所有入口，再执行"。

1. **R1：发布"所有入口都不读写 `message` / `part`"的版本**（§4 P2 结束时）。这个版本仍然**能读**
   未压缩的库：`v1-read` 回退和 backfill 都保留；也**能读**压缩后的库。
   所有通道（`miao`、`miao-preview`、`miao-dev`）都升级到这个版本，并且确认用户不再运行任何更旧的二进制
   （包括别的机器）。
2. **先在克隆上演练。** 停掉所有会写这个库的 miao 进程（或至少确认没有写入），然后**用 SQLite 备份 API**
   克隆，不要用 `cp`/`cp -c`——库处于 WAL 模式时主文件不是一致快照，热拷贝会得到损坏的库（已实测：
   `cp -c` 出来的克隆 `PRAGMA quick_check` 报 btree 错误，`db compact` 在 VACUUM 处失败）：
   - 备份：`sqlite3 <db> ".backup '<db>.bak-YYYYMMDD'"`
   - 克隆：`sqlite3 <db> ".backup '/tmp/miao-clone.db'"`（`.backup` 走在线备份 API，含 WAL 内容，一致）
   - 克隆后先校验：`sqlite3 /tmp/miao-clone.db "PRAGMA quick_check;"` 必须输出 `ok`。
     **不要加 `-readonly`**：`.backup` 目标保持 WAL 模式，只读连接无法创建 `-shm`，会误报 `unable to open database file (14)`。
   在克隆上按顺序跑：
   - `MIAO_DB=/tmp/miao-clone.db miao-dev db backfill --verify`（0 失败）→ `… db backfill` → `… db compact --yes`；
   - 然后用**已安装的** `miao` 对克隆（`MIAO_DB=<clone>`）逐个冒烟：TUI 打开 legacy 和 V2 会话各一个、
     `--mini` 回放并续跑、ACP load / prompt、`export`、`import`、`stats`、
     `/api/session/<id>/context` 和 `/message` 都返回 200。
3. **再处理真库。** 停掉所有 miao 进程，`.backup` 后对真库执行同样的操作。日常库约需 1 分钟。
4. **备份留存。** 至少保留到 P4（删运行时）发布并浸泡 1 周之后。
5. **后续压缩（P7）。** 删掉 `session.created.1` / `session.updated.1` 这类 V1 会话事件，可以合进
   `db compact` v2。前提：确认 replay 和投影重建不再需要它们（`session` 表已经是投影结果）。

**是否改为自动迁移**（启动时检测 legacy 会话后自动 backfill，再提示 compact）需要决策（§5-5）。
`v1-retirement.md` Stage 4 当时决定的是保持显式。

### 3.4 回滚

| 场景 | 回滚方式 |
|---|---|
| 新二进制有问题，库还没压缩 | 装回上一个版本。库没动过，可以直接用；V1 写入路径在 P4 之前都还在 |
| 已压缩，新二进制有问题 | 装回 R1 及之后的任一版本（都能读压缩库）。**不能**回到 R1 之前的版本 |
| 必须回到 R1 之前的版本 | 用 `.backup` 恢复，再把压缩后新增会话的数据合并回去。2026-10-01 已经这样操作过一次：用 ATTACH 拷贝 `session`、`session_message`、`session_input`、`session_context_epoch`、`todo`、`session_share`、`event`、`event_sequence`，`project` / `project_directory` 用 insert-or-ignore。建议把这套流程固化成 `miao db restore --merge-from <compacted>`（S–M），**在第一次压缩真库之前做好** |
| 删除代码后发现缺功能 | 每个删除阶段都是独立的提交和 release，git revert 加回滚安装即可（`miao-preview` 有 `miao.prev`；正式版回滚方式【未核实】`miao upgrade <version>` 是否支持指定版本） |

---

## 4. 分阶段计划

每个阶段单独发布。门槛全部满足才进入下一阶段。人日按一个熟悉代码库的人估算。

### P0 — 清理上游未用包，补 main 的 CI（1.5–2 人日，可立即做，与其他阶段并行）

- 删除 §1.3 标"现在删"的包、相关 workflow 和根脚本；workspaces 和 `turbo.json` 去掉对应项；`bun install` 刷新 lock。
- 让 `typecheck.yml` 在 `main` 上触发；在 `packages/core` 的 `package.json` 里声明 `@opencode-ai/sdk` 依赖，
  或把这几个类型挪进 `@miao/schema`。
- 门槛：`bun turbo typecheck` 绿；`test.yml` 绿；`./script/install-local.sh` 能构建，`miao-preview --version`
  正常；nix eval 不报错。
- 风险：低。回滚：git revert。

### P1 — 补 V2 缺口（阻塞项）（8–12 人日）

- 安全与正确性，必须做：
  - MCP 调用的权限询问（S）；
  - edit 询问时带 diff（S）；
  - stats 的重复计算（并入 P2 的 stats 改造）。
- 客户端迁移依赖的：
  - status / retry / error 推送事件（S–M）；
  - 导出读 V2、import 写 V2（M）；
  - V2 会话 `summary_*` 列核对（S）。
- 用户可感知的回退：
  - BashArity 前缀审批（M）；
  - 标题生成（S–M）；
  - 指令来源对齐（按 §5-6 的决策，M）；
  - codex / copilot 请求头与参数迁进 V2 provider（S）；
  - custom tool 加载（M）；
  - bash `shell.env`（S）；
  - edit / apply_patch 后的 LSP 诊断（S）。
- 可以延后、不阻塞删 V1 的：lsp 工具、plan_exit、MCP resources/OAuth、background task、structured output、
  命令模板 `` !`cmd` ``。保留在 checklist 里即可。
- 门槛：每项有 core 测试；`bun typecheck`；core、server、tui、miao 测试套件绿；`miao-dev` 冒烟。
  发布 release 后浸泡 2–3 天。
- 风险：中，改动的是 V2 默认路径。回滚：装回上一版。

### P2 — 所有入口迁到 V2（R1）（14–20 人日）

| 项 | 工作量 |
|---|---|
| `--mini` 迁 V2（§2.5） | 4–6 人日 |
| ACP 迁 V2，放进独立适配层（§2.6） | 5–7 人日 |
| `stats`、`export`、`import`、`session`、`attach`、`validate-session` 改用 V2 | 2–3 人日 |
| TUI 残留：`promptAsync` 两处改成 `v2.session.prompt`（admit-only，`resume:false`）；`experimental.session.background` 和 `projectCopy.generateName` 改用 V2 或删除；`sync.tsx` 的 V1 事件处理器加开关 | 1–2 人日 |
| app 残留：export 改走 V2；share 按决策删除；`server-sdk.tsx` 不再把事件重新包装成 V1 形状（这一步依赖 P6 的 e2e 重写，可以拆到 P6） | 1–2 人日 |
| `miao github` / `pr`：按决策 §5-4 迁 V2 或删除 | 0.5 人日（删）/ 2–3 人日（迁） |
| 插件运行时 client 改成 `/v2` client 或 `@miao/client`（同时为 P5 做准备） | 0.5 人日 |
| **观测手段**：server 对每个 V1 路由命中打 `level=WARN legacy-route` 日志，浸泡期间统计 | 0.5 人日 |

- 门槛：
  - 源码里，除 `MIAO_TUI_V2=0`、`?protocol=v1` 回退分支外，任何客户端都不调用 `/session/*` 和 V1 SDK 的会话方法；
  - 在**压缩库克隆**上，`--mini`、ACP（Zed）、`export`、`import`、`stats` 的 e2e 全部通过；
  - 发布 R1，所有通道都升级；浸泡 5–7 天，日志里 `legacy-route` 为 0；
  - CI 绿。
- 风险：中高，`--mini` 和 ACP 是用户的实际入口。回滚：装回上一版。这个阶段库还没动，回滚没有数据风险。

### P3 — 压缩日常库（0.5 人日加 1 周观察）

- 先做 `miao db restore --merge-from`（§3.4，S–M）；然后按 §3.3 第 2–4 步执行，先 `miao.db`，再 `miao-main.db`。
- 门槛：克隆演练全部通过，真库压缩后同样一套冒烟通过；运行 1 周没有 `no such table` 一类的错误。
- 回滚：§3.4。

### P4 — 删除 V1 会话运行时（8–12 人日）

按 `v1-retirement.md` Stage 5 的顺序，每一步一个提交，测试全绿才进下一步：

1. 去掉 `MIAO_TUI_V2=0` 和 `?protocol=v1` 两条回退（TUI 约 30 个分支；app 的 `createV1Api` 和 V1 专属调用点）。
2. 从 V1 assembly 拆下 `session`、`permission`、`question`、`sync` 路由组，以及 `experimental` 里的会话部分；
   删除对应 handlers。
3. 删除 `miao/src/session/*`、`miao/src/tool/*`（含 `shell.ts`、`shell/*`、`native.ts`、`sandbox-runner.ts`）、
   `permission/arity.ts`（已移进 core）、`share/*`（按决策），以及 `effect/app-runtime.ts` 里的 V1 层。
   `effectCmd` 改成只构建命令真正需要的服务。顺带还能减轻启动和内存负担，与 Phase 0 的目标一致。
4. `control-plane/workspace.ts`、`image`、`copilot`、`agent`、`patch` 等外围引用改成用 core 的对应实现。
5. 删除对应测试：`test/session`、`test/tool`、`test/acp`（旧的部分）、`test/server` 里的 V1 路由测试，约 3–4 万行。
   需要的行为覆盖已经在 core 测试里，删之前逐个文件确认没有独有覆盖。
6. 停止产生 V1 事件；`core` 的 projector 保留 V1 事件的**读取 / 回放**处理（给还没压缩的库用），不再写入。

- 门槛：
  - `rg "src/session|@/session/|@/tool/" packages/miao/src` 只剩零个或白名单内的命中；
  - `bun typecheck` 全部包通过；
  - 全套测试绿；
  - 压缩库克隆和**未压缩**库克隆上，各入口 e2e 都通过；
  - 发布后浸泡 1 周。
- 风险：中。删除量大，但前面的阶段已经把调用方清空了。回滚：git revert 加装回 R1 之后的版本（库格式不变）。

### P5 — 插件 API 与旧 SDK（5–8 人日，破坏性变更）

- `@opencode-ai/plugin` 的 `Hooks` 类型改用 `/v2` 或 schema 类型；`PluginInput.client` 改为 V2 client。
  对仍要支持的旧钩子，在 V2 runner 里做适配层，或者明确废弃（§5-2）。
- 删除 `packages/sdk/js` 的 V1 根导出（`src/gen`、`client.ts`、`index.ts`）、`sdk-v1-smoke.test.ts`、
  `script/duplicate-pr.ts` 对它的引用。
- 门槛：内置插件全部改到新 API；示例插件编译通过；CHANGELOG 写明迁移指南。

### P6 — app e2e：17 个用例改用 V2 夹具（10–13 人日；含组 C 功能则 13–18 人日）

可以和 P1–P2 并行；**必须在 P4 删除 app 的 V1 shim 之前完成**。

- 夹具基础设施（2.5–3 人日）：
  - V2 message 和 event 构造器，分别用 `SessionMessage` 和 `OpenCodeEvent` 校验；
  - 导出派生 ID 的 helper：V2 中 text/reasoning 的 ID 是 `${msgID}:text:N`，这正是大部分用例挂掉的原因；
  - mock 默认 `protocol: "v2"`；
  - 补上 `GET /api/session/:id/message/:mid`、`/api/session/:id/todo`；
  - 修正 `/api/session/active` 函数形式的 `sessionStatus`。
- 分组（详细对照见调研记录）：
  - **A 组，直接改写（12 个）**：#1 smoke 时间线、#2 上下文分组、#3–4 history-root、#9 附件和引用、
    #10–12 reasoning 和 transport、#13–14 context-resize、#15–16 远程设置和自动审批。
    其中 #2 可能暴露一个真实的 app bug：按 part ID 排序（`server-session.ts:558`），导致 V2 下 text 和 tool 的交错顺序错乱。
  - **B 组，部分改写（2 个）**：#5 retry 生命周期、#7 时间线投影，去掉 DiffSummary 和 comment 的断言。
  - **C 组，先要补 app 或 V2 功能（3 个）**：
    - #17 todo dock：`session.todo()` 现在是个 stub，要改成调用 `GET /api/session/:id/todo`，S；
    - #6、#8 依赖每轮 DiffSummary 和 inline comment，V2 里都没有。二选一：实现每轮 diff 和 comment 元数据
      （3–5 人日），或者把 DiffSummary 行当作 V2 死代码删掉（§5-8）。
  - **D 组，需要删除的**：没有。
- 另有约 30 个当前能通过、但仍在发 V1 事件名（`message.part.updated`、`session.status`）的时间线用例，
  也要迁到 `session.next.*`，app 才能删掉 V1 事件兼容层。另需 3–5 人日，建议并进 P6。
- 门槛：`bun --cwd packages/app test:e2e:local` 中 0 个 `LEGACY_V1_FIXTURE`；mock 不再响应任何无前缀的会话路由；
  CI e2e（Linux）绿。

### P7 — 非会话类旧路由与收尾（10–15 人日，可排到 Phase 2 之前或之中）

- config、provider、auth、file、find、pty、mcp、lsp、tui、experimental/worktree、instance、global 这些无前缀旧路由
  迁到 `/api/*`。TUI 的 `packages/cli/src/tui.ts:21-37` 现在对 V2-only daemon 打桩 404，说明还缺这些接口；
  app 的 `V1_API_MIGRATION.md` 也还有 27 项未完成。迁完后 TUI 和 app 去掉 `@opencode-ai/sdk`，统一用 `@miao/client`。
  发布二进制的 server 切换到 `packages/server` 的 V2-only assembly，`packages/miao` 只剩 CLI 外壳。
  这也是 architecture Phase 2（daemon）的前提。
- 删除 core 里的数据迁移层：`v1-read`、`backfill`、`legacy-tables`、`compact`，projector 的 V1 分支，
  `core/src/v1/session.ts`、`schema/src/v1/session.ts`、`legacy-event`。**前提**：
  - 所有已知的库都已经压缩；
  - 最后一个带迁移能力的版本发布满一个周期；
  - 新版本遇到没压缩的库，给出明确提示："请先用 vX.Y 运行 `miao db compact`"，或者自带一次性迁移。
- `core/src/v1/config/*`（旧配置读取）**保留**，或者另立计划，因为用户的配置文件可能仍是 V1 形状。

### 汇总

| 阶段 | 人日 | 可独立发布 | 主要门槛 |
|---|---|---|---|
| P0 清理上游包和 CI | 1.5–2 | 是 | typecheck、CI 绿，install-local 正常 |
| P1 V2 补缺 | 8–12 | 是 | 各项测试，浸泡 2–3 天 |
| P2 入口迁 V2（R1） | 14–20 | 是 | 压缩库克隆上 mini/ACP/export/import/stats e2e 通过；`legacy-route` 日志为 0 |
| P3 压缩日常库 | 0.5 加 1–2（restore 工具） | 不发版 | 演练和真库冒烟通过 |
| P4 删 V1 运行时 | 8–12 | 是 | 不再 import `miao/src/session`；全绿 |
| P5 插件 API 和 SDK | 5–8 | 是（破坏性变更） | 内置插件迁移完成 |
| P6 e2e 重写 | 10–13（加 3–5 迁其余用例） | 是 | 0 个 fixme，CI e2e 绿 |
| P7 非会话旧路由和收尾 | 10–15 | 是 | 发布二进制只用 V2 assembly |
| **合计** | **约 58–90**（不含 P7 约 48–75；关键路径 P1→P2→P3→P4 约 32–46） | | |

---

## 5. 需要用户决定的事项

1. **范围。** "彻底去除 V1"是否包含 P7（非会话类旧路由、`@opencode-ai/sdk` 的 `/v2` 导出、切到 V2-only assembly）？
   - 建议：Phase 1 做到 P0–P6，P7 并入 architecture Phase 2（daemon 化本来就需要它）。
2. **旧式插件钩子。** 三个选项：
   - (a) 在 V2 里做兼容层，支持 `chat.params`、`chat.headers`、`tool.execute.before/after`、`shell.env`；
   - (b) 只迁内置插件，第三方旧钩子宣布废弃；
   - (c) 正式设计 V2 transform 钩子。
   - 建议 (b)，再加 `tool.execute.*` 的 V2 版本。用户本机没有第三方插件。
3. **share。** 删除，还是在 V2 里重做（需要自建 share 服务）？建议删除。
4. **`miao github` / `miao pr` 和 `github/` Action。** 删除，还是迁 V2？
5. **迁移是否自动。** 新版本启动时检测到 legacy 会话就自动 backfill（加自动备份），还是保持手动的
   `miao db backfill` / `compact`？compact 建议一直保持手动。
6. **指令来源。** V2 是否要兼容 `CLAUDE.md`（含 `~/.claude/CLAUDE.md`）、`CONTEXT.md` 和 `instructions` 配置？
   V1 都会读，V2 只读 `AGENTS.md`。本仓库根目录有 `CONTEXT.md`。
7. **`--mini` 的形态。** 迁 V2 并保持现有体验（4–6 人日），还是先做功能子集（回放、发送、审批）？
8. **app 的每轮 DiffSummary 和 inline comment。** 在 V2 里实现，还是删除（影响 e2e #6、#8）？
9. **Copilot、Azure、Bedrock、Vertex。** 它们在 V2 runner 里还不支持（没配 `api.url` 时）。删 V1 之前要不要补齐，
   还是接受只支持现有 provider？
10. **旧库文件。** `miao.db.bak-20261001`、`*.compacted-*`、`miao-main.db` 的处置（约 5.6 GB），
    以及其他机器（macmini 等）上的 miao 库要不要纳入迁移。
11. **`packages/web` 的文档内容。** 要不要保留或搬到 mtty.dev 之后再删？
    `sdks/vscode` 是做成 miao 扩展还是删除？
12. **CI。** 是否让 typecheck CI 在 main 上运行，并把它作为每个删除阶段的硬门槛（建议是）？

---

## 附：本次实测记录

- 工作区：`$CLAUDE_JOB_DIR/tmp/main`（`git worktree add --detach … miao/main`，阅读用，结束后移除）。
- 数据库：`sqlite3 ~/.local/share/miao/miao.db ".backup $CLAUDE_JOB_DIR/tmp/db.sqlite"`；
  压缩实验在 `cp -c` 出的 `db-trial.sqlite` 上进行，用 `MIAO_DB=<path> ~/.miao/bin/miao …`（0.0.33）。
  真库和其他通道的库都没有写入（`miao-main.db`、`miao-local.db` 只用 `mode=ro` 查询）。
- ACP 冒烟：
  `printf initialize; printf session/load | MIAO_DB=<db> miao acp --cwd <dir>`，统计 `session/update` 通知的条数。
