# 服务端只挂 V2 路由（P7 收尾第 1 层）

状态：设计稿，2026-10-03。

## 目标与分层

- **第 1 层（本文）**：`packages/miao/src/server/routes/instance/httpapi/server.ts` 不再挂 V1 路由组
  （`rootApiRoutes`、`eventApiRoutes`、`ptyConnectApiRoutes`、`instanceRoutes`）与 `/doc` 的 V1+V2 合并文档，
  只留 `serverRoutes`（`/api/*`）与内嵌 UI。V2 路由依赖的 V1 服务（`Plugin`、`Provider`、`EventV2Bridge`、
  `WorkspaceV2Bridge`、插件 shell/pty 环境等）保留不动。
- **第 2 层（以后）**：迁走这些桥接服务，发布二进制改用 `packages/server` 的装配，`packages/miao` 只剩 CLI 外壳。

## 现状（2026-10-03 按代码核实）

V1 仍挂 16 个组。清点生产调用方后分四类（逐条证据见下）。

### A. 有 V2 等价路由，只需改调用

| 调用方 | V1 | V2 |
|---|---|---|
| `cli/cmd/run/runtime.boot.ts:99,107` | `GET /config/providers`、`GET /provider` | `/api/config/providers`、`/api/provider` |
| `cli/cmd/run/runtime.ts:231,379,383,387` | `/find/file`、`/agent`、`/experimental/resource`、`/command` | `/api/fs/find`、`/api/agent`、`/api/mcp/resources`、`/api/command` |
| `cli/cmd/run.ts:495,537`（`--attach`） | `/path`、`/agent` | `/api/path`、`/api/agent` |
| `tui/src/feature-plugins/system/diff-viewer.tsx:132` | `/vcs/diff`（mode `git` → `working`） | `/api/vcs/diff` |
| `app/src/context/server-sync.tsx:122` | `/lsp` | `/api/lsp` |
| `app/src/utils/server-health.ts:107`、`desktop/src/main/server.ts:189` | `/global/health`（仅作 `/api/health` 失败后的回退） | 删除回退 |

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
2. `POST /mcp/:name/auth/authenticate`：app 打开需要认证的 MCP 时调用（`app/src/context/server-sync.tsx:655`）。
   方案：新增 `POST /api/mcp/:name/auth/authenticate`（同语义），app 改调。
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

- `miao generate` → `PublicApi` 生成 OpenAPI → `packages/sdk/js` 生成 `@opencode-ai/sdk/v2`。实测：只留 V2 后
  重新生成，根命名空间方法（`client.config.*`、`client.global.*` 等）和只被 V1 路由引用的类型一起消失，
  tui 61、miao 128、cli 49、plugin 11、session-ui 9 处类型错误。错误大多是**类型**（`Config`、`Provider`、
  `Model`、`Agent`、`Command`、`Workspace`、`Path`、`FileContent`、`VcsFileDiff`、`LspStatus`、`McpStatus`、
  `GlobalEvent`、`ProviderAuthMethod`、`Auth` …），不是调用。
- 方案：把这些类型对应的 Schema 加进 `PublicApi` 的 `HttpApi.AdditionalSchemas`，生成器照常产出类型；
  路由方法随路由消失。这样第 1 层不必改写各包的类型 import；类型改从 `@miao/client` 取留待以后。
- **插件 `client`**（`plugin/index.ts:151`，`createOpencodeClient`）的根命名空间同时消失。仓内插件只用到
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
   删除；本地 worktree 工作区不受影响。微信/QQ 远程（`packages/remote`）已全走 `@miao/client` 与
   `/api/remote`，不受本方案影响。
