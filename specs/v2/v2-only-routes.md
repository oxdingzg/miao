# 服务端只挂 V2 路由（P7 收尾第 1 层）

状态：第 1 层已实现，2026-10-03（`cd03f9ec3` 起，至 `20a62f874`）。

实施结果与方案的出入：

- C.2 改为把 MCP OAuth 整体移植进 core（`mcp-oauth.md`），因为 V2 下它本已失效。
- 旧 SDK 类型：`PublicApi` 只含 V2 后，客户端仍当作视图模型使用的 V1 形状类型经 `public-schemas.ts` 的
  `ClientSchemas` 作为 `AdditionalSchemas` 保留（Provider、Model、Config、Command、Agent、Auth、
  ProviderAuthMethod、VcsFileDiff、FormatterStatus、Workspace、McpStatus、LspStatus、FileNode、FileContent）。
  只由 V1 路由响应派生的类型改为本地定义或 V2 类型：TUI 的 `GlobalEvent`（GlobalBus 包装）与
  `ProviderCatalog`，app 的 `ProviderAuthResponse` / `ProviderListResponse`，`Path` → `LocationPath`，
  `ProjectDirectories` → `ProjectDirectory[]`。
- 一并删除的中间件：`legacy-route`、`instance-context`、`workspace-routing`、`proxy`、`fence`、V1
  `schema-error`，以及 `lifecycle.ts` 的 `disposeMiddleware`（只有 V1 handler 会标记实例销毁）。
- V1 插件在 V2 下按需加载：只有插件的 shell/pty 环境桥接（如创建 PTY、bash 工具）会触发加载。
  （第 2 层已删除该桥接，见下。）
- 已知测试缺口：`/api/event` 跳过未声明事件的行为原由 `/tui/open-help` 触发测试，`/tui` 删除后 HTTP 上已无
  可触发未声明事件的路由，该测试随之删除（逻辑仍在 `server/src/handlers/event.ts`）。

进展（2026-10-03，第 2 层桥接迁移）：

- 三处桥接已迁走。`PluginShellEnvironment` / `PluginPtyEnvironment` 删除：按决策 2，旧式 `Hooks` 插件的
  `shell.env` 不再加载（`core/src/config/plugin/external.ts` 对 V1 插件只记一次 warning），V2 bash 读 core
  `ShellEnvironment`（无 source），PTY 用 `@miao/server/pty-environment` 的 no-op。
- `WorkspaceV2Bridge` 删除，`WorkspaceV2` 由 core `WorkspaceLive` 实现：`ProjectWorktree` 新增
  `prepare` / `createFromInfo` / `list`，本地 worktree 的 create/list/remove/warp（含 `copyChanges` 的
  raw patch 复制与 session claim）保留；远端 workspace 仍不支持。`core/test/project-worktree.test.ts`
  覆盖新原语，`miao/test/server/httpapi-workspace.test.ts` 改为只断言内置 worktree adapter 与空列表。
- `EventV2Bridge` 不再挂在 V2 路由上；新增 miao 侧 `server/event-forwarder.ts`，在 UI 路由构建时把 core
  `EventV2` 事件转发到进程内 `GlobalBus`，供 in-process TUI worker 经 RPC 转发（`/api/event` 仍走 core）。
- V2 路由装配改为 core-only：`server.ts` 删除全部死 V1 节点（Auth/Config/Env/Provider/Agent/Skill/LSP/
  MCP/Command/Format/Project/Vcs/Workspace/Worktree/Snapshot/Storage/Plugin/InstanceStore/…），改用 core
  `AppNodeBuilder`；UI 路由改用 core `Flag.MIAO_DISABLE_EMBEDDED_WEB_UI`（新增于 `core/src/flag/flag.ts`），
  不再依赖 V1 `RuntimeFlags`。V1 插件服务端测试（`httpapi-listen` 的 plugin client、`httpapi-v2-pty` 的
  plugin shell env）随废弃路径删除。
- 装配迁移完成（同日晚）：发布二进制改用 `packages/server` 的 route assembly。新增
  `packages/server/src/assembly.ts`（`createRoutes({ cors, remote, auth, extensions })`，含 `/api/*`、
  error/compression/cors-vary、auth、location、遥测与 core 服务图）；error/compression/cors-vary 中间件
  从 miao 移入 `packages/server/src/middleware/`。`ServerAuth` 统一到 `@miao/server/auth`（读 core
  `Flag.MIAO_SERVER_*`，默认用户名 `miao`），`packages/miao/src/server/auth.ts` 改为再导出。
  miao 侧只剩 host 特有的 `extensions`（`/doc` 的 `PublicApi`、内嵌 UI 的 `serveUIEffect` 虚拟模块、
  `EventForwarder`）与 listener/mDNS/websocket，`server/routes/.../server.ts` 成为薄封装：
  `createAssembly({ auth: ServerAuth.Config.layer, extensions: Extensions.layer })`。

## 目标与分层

- **第 1 层（本文）**：`packages/miao/src/server/routes/instance/httpapi/server.ts` 不再挂 V1 路由组
  （`rootApiRoutes`、`eventApiRoutes`、`ptyConnectApiRoutes`、`instanceRoutes`）与 `/doc` 的 V1+V2 合并文档，
  只留 `serverRoutes`（`/api/*`）与内嵌 UI。V2 路由依赖的 V1 服务（`Plugin`、`Provider`、`EventV2Bridge`、
  `WorkspaceV2Bridge`、插件 shell/pty 环境等）保留不动。
- **第 2 层（以后）**：迁走这些桥接服务，发布二进制改用 `packages/server` 的装配，`packages/miao` 只剩 CLI 外壳。

## 现状（2026-10-03 按代码核实）

V1 仍挂 16 个组。清点生产调用方后分四类（逐条证据见下）。

### A. 有 V2 等价路由，只需改调用

| 调用方                                                                 | V1                                                           | V2                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `cli/cmd/run/runtime.boot.ts:99,107`                                   | `GET /config/providers`、`GET /provider`                     | `/api/config/providers`、`/api/provider`                           |
| `cli/cmd/run/runtime.ts:231,379,383,387`                               | `/find/file`、`/agent`、`/experimental/resource`、`/command` | `/api/fs/find`、`/api/agent`、`/api/mcp/resources`、`/api/command` |
| `cli/cmd/run.ts:495,537`（`--attach`）                                 | `/path`、`/agent`                                            | `/api/path`、`/api/agent`                                          |
| `tui/src/feature-plugins/system/diff-viewer.tsx:132`                   | `/vcs/diff`（mode `git` → `working`）                        | `/api/vcs/diff`                                                    |
| `app/src/context/server-sync.tsx:122`                                  | `/lsp`                                                       | `/api/lsp`                                                         |
| `app/src/utils/server-health.ts:107`、`desktop/src/main/server.ts:189` | `/global/health`（仅作 `/api/health` 失败后的回退）          | 删除回退                                                           |

### B. 事件流：V2 有 `/api/event`，但形状不同，需要真正迁移

- TUI HTTP 模式（`miao attach`、`miao tui --port/--hostname/--mdns`）：`tui/src/context/sdk.tsx:90` 订阅
  `/global/event`，消费 `GlobalEvent { directory, workspace, payload }`。进程内模式经 RPC 收到同形状事件。
  方案：客户端订阅 `/api/event`，按 `location.directory` 包装成同一 `GlobalEvent`；先核对 TUI 处理的每个
  事件类型都在 `EventManifest.ServerDefinitions` 里，缺的补登记或在 TUI 侧删掉处理器。
- `miao run --mini`：`cli/cmd/run/stream.transport.ts:434` 订阅 `/global/event`；headless：`run/headless.ts:64`
  订阅 `/event`。同上迁到 `/api/event`。

### C. 生产调用方存在、V2 没有等价路由

1. `PUT /auth/:providerID`（`auth.set`）：内置插件经插件 `client` 写入 OAuth/令牌——`plugin/openai/codex.ts:374`、
   `xai.ts:253`、`digitalocean.ts:251`、`snowflake-cortex.ts:305,342`。插件运行在服务端进程内，方案：改为直接用
   `Auth` 服务写入，不再绕 HTTP。
2. ~~`POST /mcp/:name/auth/authenticate`~~：核实发现 MCP OAuth 在 V2 下本已失效（core 连接不带 token），
   改为把 OAuth 移植进 core，见 `mcp-oauth.md`；app 改调 `POST /api/mcp/:name/auth`。
3. 控制面远程工作区同步（`control-plane/workspace.ts`）：向远端工作区服务器发 `/global/event`(:187)、
   `/vcs/diff/raw`(:610)、`/vcs/apply`(:626)，以及 `/sync/history|replay|steal`(:328,683,707)。
   **`/sync/*` 在 P4 已删，这条链路现在就是坏的**；远端也是 miao 服务端，去掉 V1 后其余三条也会断。

### D. 无仓内调用方，随组删除

`config`、`control-plane`、`project`、`pty`、`workspace` 全部端点（均有 `/api/*` 等价）；`/tui/*` 13 个远程控制
端点、`/log`、`/global/config`、`/global/dispose`、`/global/upgrade`、`/instance/dispose`、`/find`、
`/find/symbol`、`/file/status`、`/vcs/diff/raw`、`/vcs/apply`、`/mcp` 增删与 OAuth 端点（无 V2 等价，也无调用方）。
同时删除：`legacy-route`、`workspace-routing`/`proxy` 中间件、`disposeMiddleware`/`lifecycle`、
`instance-context`、V1 授权层中只服务 V1 的部分、`groups/`、`handlers/` 与对应测试。

## 旧 SDK 与插件 API 的连带影响

- `miao generate` → `PublicApi` 生成 OpenAPI → `packages/sdk/js` 生成 `@miao/sdk/v2`。实测：只留 V2 后
  重新生成，根命名空间方法（`client.config.*`、`client.global.*` 等）和只被 V1 路由引用的类型一起消失，
  tui 61、miao 128、cli 49、plugin 11、session-ui 9 处类型错误。错误大多是**类型**（`Config`、`Provider`、
  `Model`、`Agent`、`Command`、`Workspace`、`Path`、`FileContent`、`VcsFileDiff`、`LspStatus`、`McpStatus`、
  `GlobalEvent`、`ProviderAuthMethod`、`Auth` …），不是调用。
- 方案：把这些类型对应的 Schema 加进 `PublicApi` 的 `HttpApi.AdditionalSchemas`，生成器照常产出类型；
  路由方法随路由消失。这样第 1 层不必改写各包的类型 import；类型改从 `@miao/client` 取留待以后。
- **插件 `client`**（`plugin/index.ts:151`，`createMiaoClient`）的根命名空间同时消失。仓内插件只用到
  `auth.set`（见 C.1）；第三方插件若调用 `client.config.get`、`client.tui.*`、`client.app.log` 等会失效——
  这是插件 API 的破坏性变更。`client.v2.*` 不受影响。
- `/doc` 改为输出只含 V2 的文档（`PublicApi` 本身变成只含 V2）。

## 实施顺序（每步单独提交、推送）

1. A 类调用改走 V2；`miao run` 的事件流迁到 `/api/event`（B 的一半）。
2. TUI HTTP 模式事件流迁到 `/api/event`（B 的另一半），补齐缺失的事件登记。
3. C.1 内置插件改用 `Auth` 服务；C.2 新增 `/api/mcp/:name/auth/authenticate` 并迁移 app。
4. C.3 按决定处理控制面远程工作区同步。
5. `PublicApi` 只留 V2 + AdditionalSchemas；`server.ts` 摘掉 V1 组；删除 `groups/`、`handlers/`、
   V1 专用中间件与测试；重新生成旧 SDK；更新 `web` 文档里的 SDK/插件示例。

## 验证

每步：改动包 `bun typecheck`；相关单测；`rg` 确认对应 V1 调用清零。第 3 步后跑一次带 `--attach` 的 `miao run`
与 `miao attach` 冒烟。第 5 步：旧 SDK 重新生成后全部包类型检查通过，`/doc` 只含 `/api/*`，CI 跑完一次
（unit linux + e2e linux）。

## 决定（2026-10-03，用户确认）

1. 插件 `client` 的 V1 根命名空间随之删除，接受第三方插件的破坏性变更；插件改用 `client.v2.*`。
2. `/tui/*`（上游 opencode 的 TUI 远程控制接口，给 IDE 扩展用，与微信/QQ 远程无关）直接删除。
3. 控制面远程工作区同步（上游 opencode 实验性 workspaces 的跨服务器会话迁移与 diff 同步，`/sync/*` 已断）
   删除；本地 worktree 工作区不受影响。旧微信/QQ连接器、本机 Router 与 `/api/remote` 已在后续清理中移除。
