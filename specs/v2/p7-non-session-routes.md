# P7 — 非会话旧路由迁 `/api/*`

状态：进行中（2026-10-02 开始，2026-10-03 按代码重新盘点）。目标：让 TUI / app / CLI 完全脱离 V1 无前缀路由与 `@opencode-ai/sdk`，
使发布二进制的 server 能切到 `packages/server` 的 V2-only assembly，只剩 CLI 外壳。

## 已完成

- `formatter`：core `Format.status()` 下沉 + `GET /api/formatter`（protocol 组 + server handler）+
  重新生成 `packages/client` 与 legacy SDK；TUI `sync.tsx` 改走 `client.v2.formatter.status`。
  加组后必须重生成两套客户端：`packages/client`（纯 codegen）与 legacy SDK
  （`packages/sdk/js/script/build.ts`，内部 `bun dev generate` 起服务导出 OpenAPI）。
- `lsp`：core `LSP.status()` 已有，加 `GET /api/lsp`（protocol 组 + server handler）+ 生成；
  TUI 改走 `client.v2.lsp.status`，并在 `sync.tsx` 用 `toLspStatus` 把 core 的 `{id,extensions,connected}`
  投影回现有 `{id,name,root,status}` 形状（`root` 置空），渲染点与插件 API 不变。
- `provider` / `auth`：`sync.tsx` 的 `provider.auth` → `client.v2.integration.list`，用 `toProviderAuth`
  把 `IntegrationInfo.methods` 映射回 `Record<providerID, ProviderAuthMethod[]>`（env 方法丢弃）；
  `dialog-provider` 的 `auth.set` → `client.v2.integration.connect.key`，并去掉随之的 `instance.dispose`
  （V2 保存凭据后服务端自行重载）。
- `provider.oauth`：`dialog-provider` 的 `authorize/callback` → `client.v2.integration.connect.oauth`
  （返回 `Attempt{attemptID,url,instructions,mode}`）→ code 用 `attempt.complete({attemptID,code})`、
  auto 用 `attempt.status({attemptID})` 每秒轮询；`toProviderAuth` 保留 V2 `method.id` 供 `methodID`；
  成功后只 `sync.bootstrap()`（不再 `instance.dispose`），并加 `onCleanup` 停止轮询。
- `config.get`：core 新增独立 `Config.merge(entries)`（深合并文档），加 `GET /api/config`
  （protocol 组 + handler）。因为 `Config.Info` 定义在 core、protocol 不能依赖 core，成功类型暂用
  `Schema.Record(String, Unknown)` 宽松对象，TUI 用 `toConfig` 直接接收——**待 config schema 下沉到
  `@miao/schema` 后再收紧**。`config.providers` 见下条。
- `vcs`：core `Git` 新增 `status.entries(repository)`（`git status --porcelain` + `git diff --numstat`），
  `@miao/schema/vcs.ts` 定义 `Info`/`FileStatus`/`FileDiff`，加 `/api/vcs`（`vcs.get`/`vcs.status`），
  TUI 的 `vcs.get`/`vcs.status` 改走 V2（含 `dialog-workspace-create` 的第 4 处）。`vcs.diff`/`diff-viewer`
  仍 V1，未在本轮范围。
- `provider.list`（catalog）：新增 `GET /api/config/catalog`，服务端用 core `provider.all()` + `model.all()` +
  `provider.available()` 投影回 V1 的 `{all, default, connected}`，TUI 的 `loadProviderCatalog` 改走
  `client.v2.config.catalog`，`provider_next` 形状不变。投影逻辑抽到
  `packages/server/src/handlers/provider-projection.ts`，与 `config.providers` 共用。
- `config.providers`：新增 `GET /api/config/providers`，**服务端**把 core `provider.available()` + `model.available()`
  投影回 V1 的 `{ providers: Provider[], default: Record<providerID, modelID> }` 形状（`default` 用全局
  `model.default()`，其余 provider 取最新可用模型），TUI 只改一行、store 形状不变，避免动 ~15 个消费点。
  成功类型同样先用宽松 `Schema`，待 provider/model schema 下沉后收紧。
- `command` / `skill` / `project.current`：TUI 的 `sdk.client.command.list`、`app.skills`、
  `project.current` → `client.v2.command.list` / `v2.skill.list` / `v2.project.current`（`sync.tsx` 用
  `toCommand` 把 `CommandV2Info` 映射回 V1 `Command`，`model` 拼成 `provider/model`）。无需新端点。
- `experimental.session.background`：V2 下 `foregroundTasks` 恒为空，`session.background` 命令与快捷键
  永远禁用，已连同 `foregroundTasks` 一并删除。
- `app` / `project`：`app.agents` → `v2.agent.list`，`sync.tsx` 用 `toAgent` 把 `AgentV2Info` 映射回
  V1 `Agent`（`name←id`，不读 `permissions` 置空，`model←ModelRef`）；`dialog-move-session` 的
  `project.directories` → `v2.project.directories`。无需新端点。
- TUI：`sdk.client.find.files` → `client.v2.fs.find`；`sdk.client.path.get` → `client.v2.location.get`；
  `sdk.client.project.current/directories` → `client.v2.project.*`（`context/project.tsx` 把
  `LocationInfo.project.directory` 映射回 `instance.path.worktree`）。`packages/tui` 367 测试通过、typecheck 通过。
- 此前已完成：会话读写全部 V2；app 的协议选择回退（`createV1Api`/`?protocol=v1`）删除。

- `mcp`（`0515122fa` status/connect/disconnect、`3f604a5a2` resources）、`workspace`（`0537c126a`）、
  `control-plane/move-session`（`330141bfc`）、`capabilities`（`c311394b5`）：protocol 组 + handler 已加，
  TUI 对应调用已迁到 `client.v2.*`。

- 2026-10-03 下午：`/api/vcs/diff`（`290c4f394`，git CLI 封装与 diff 逻辑下沉为 core `GitCli`/`VcsDiff`，`d5fef5ee6`）、
  `/api/pty/shells`（`be7c0f431`）、`GET /api/project` 与 `PATCH /api/project/:projectID`（`50daab309`，core 新增
  `ProjectMetadata`，改名时为还没有会话的项目补写行，并经 EventV2 发 `project.updated`，已加入 `ServerDefinitions`）。
- `/api/event` 修复（`5c9b22954`）：事件流原先对每个 EventV2 事件做 `encodeUnknownSync(OpenCodeEvent)`，V1 bridge
  发出的未登记类型（`vcs.branch.updated`、`lsp.updated`、`tui.command.execute` 等）会抛错并结束整条订阅，客户端
  只能重连且丢事件。现改为跳过无法编码的事件。

- app 改用 `@miao/client`（`430ebc357`），删除 vendored 的上游 `opencode-ai-client-1.17.13` tarball；session-ui 改用
  `@miao/schema` 的 `Vcs.Patch`。类型对齐暴露并修复了一批连 miao 服务端时的运行时错误：
  - **发消息**：旧请求体是扁平的 `{text, files, agents}`，miao 要求 `{prompt: {...}}`，实测返回 400（`Missing key at ["prompt"]`），
    即 web/desktop app 发不出消息。现改为嵌套结构，并照 TUI 的做法在发送前用 `switchAgent`/`switchModel` 应用所选 agent/模型
    （miao 的 prompt/command 不带 agent/model）。command/shell 去掉了服务端不认的字段。
  - `project.current` 返回 `{location, data}`，原代码读 `.id` 得到 `undefined`（子目录 project、工作区目录列表失效）。
  - provider OAuth 的 status/complete 改用 `/api/integration/attempt/*`。
  - MCP status/resources 直接使用 miao 的 Record 结构，去掉不存在的 `pending` 状态。
  - 会话列表新增服务端 `roots` 过滤（`c1938893e`），替代 miao 不支持的 `parentID=null`，避免子代理会话混入列表与分页。
  - 实时 reducer 与历史投影改按 miao 的消息 schema（synthetic 的 `text`、shell 的 `callID`/`output`、附件 `source`、
    工具 `pending` 状态与 `structured`/`provider`、reasoning `providerMetadata`、compaction 结算后才出现）。
  - `/api/vcs/diff` 返回必填 `patch`/`status` 的 `Vcs.Patch`（`c89ec3ce4`）。

## 现状盘点（2026-10-03 按代码核实）

### TUI：只剩 4 处 V1 调用

`rg -oN "sdk\.client\.([a-zA-Z]+)\." packages/tui/src` 的非 `v2` 命中：

- `experimental.console` ×3（`context/sync.tsx:679`、`component/dialog-console-org.tsx:33,98`）：
  console/账户切换只有 V1 `/experimental/console*`，没有 V2 group。
- `instance.dispose` ×1（`dialog-console-org.tsx:106`）：切换 org 后重载实例。

`file.read`（`routes/session/index.tsx` 的 diff 高亮）正在改走新增的 `GET /api/fs/content`（工作区未提交）。

### app：两层问题

**1. 仍调 legacy SDK（`sdk().client.*`，`@opencode-ai/sdk/v2` → 无前缀 V1 路由）**

| 调用 | 位置 | V2 现状 |
| --- | --- | --- |
| `file.list` / `file.read` | `context/file.tsx`、`pages/session/review-tab.tsx`、`pages/session/v2/review-panel-v2.tsx` | `fs.list` 已有；`fs.content` 新增中 |
| `pty.update/get/connectToken/shells` | `components/terminal.tsx`、`settings-general.tsx`、`settings-v2/general-controllers.ts` | `/api/pty/*` 已有，仅剩 `protocol === "v1"` 死分支；`shells` 无 V2 端点 |
| `project.initGit` | `pages/session.tsx`、`pages/home/home-controller.ts` | 无 |
| `project.update` | `pages/layout.tsx`、`context/layout.tsx`、`components/edit-project.ts` | 无；V2 下被 `protocol !== "v1"` 直接 return（**重命名项目在 V2 下静默失效**） |
| `worktree.create/remove/reset` | `pages/layout.tsx` | `/api/workspace` 有 create/remove，无 reset |
| `instance.dispose` / `global.dispose` | `pages/layout.tsx`、`settings-providers.tsx`、`settings-v2/providers.tsx` | 无 |
| `global.config.update` | `context/server-sync.tsx` | 无（`GET /api/config` 只读） |
| `auth.set/remove` | `dialog-custom-provider.tsx`、`settings-providers.tsx`、`settings-v2/providers.tsx` | `/api/credential` 有 update/remove；自定义 provider 在 V2 下被拒（`provider.custom.unavailable`） |
| `path.get` | `dialog-select-directory*.tsx` | `/api/location`；V2 下被 `protocol !== "v1"` 直接 return |
| `lsp.status` | `context/server-sync.tsx:137` | `/api/lsp` 已有 |
| `session.get/messages/message` 兜底 | `context/server-session.ts` | V2 已有，删兜底即可 |

另外 `loadGlobalConfigQuery`（`context/global-sync/bootstrap.ts:107`）现在恒返回 `{}`：**app 在 V2 下读不到配置**。

**2. 新 API 用的是 vendored 上游客户端，不是 `@miao/client`**

`packages/app/src/utils/server.ts` 的 `createApiForServer` 用 `@opencode-ai/client/promise`，来源是
`packages/app/vendor/opencode-ai-client-1.17.13-v2.tgz`（上游 opencode 1.17.13 的契约）。它的路由集合与 miao
protocol 不一致：上游有、miao 没有的路由包括 `/api/vcs/diff`、`/api/project`（list/update）、`/api/mcp/:name`、
`/api/mcp/resource`（miao 是 `resources`）、`/api/integration/:id/connect/oauth/:attempt*`（miao 是
`/api/integration/attempt/*`）、`/api/shell*`、`/api/session/:id/form*` 等。app 实际调用的 `api.vcs.diff`、
`api.project.update`、`api.pty.shells`、`api.integration.oauth.*`、`api.mcp.connect/disconnect`、`api.resource`
在 miao 服务端上很可能 404（**待浏览器实测确认**）。修法：app 改用 `@miao/client`，按 miao protocol 补缺失端点，
删掉 vendor tarball。

`packages/app/V1_API_MIGRATION.md` 已按以上核实结果更新。

## 剩余工作（按顺序）

1. ~~**app 切到 `@miao/client`**~~：已完成（见上）。
2. **补 V2 端点**（protocol 组 + server handler + `bun run generate`）：~~`pty.shells`~~、~~`project.update`~~、
   ~~`vcs.diff`~~、~~`fs.content`~~、~~`config.update`~~（见 `config-write.md`；`global.dispose` 已由配置写入后的位置
   失效替代）已完成；剩 `workspace.reset`（及 app 里随之的 `instance.dispose`）、`project.initGit`（见下一条）。
   - **项目持久化下沉 core（删 V1 前必做）**：`ProjectTable` 的行目前只由 V1 `Project.fromDirectory` 完整维护
     （项目 ID 迁移、sandboxes、`time_initialized`），V2 只在建会话（`session-create.ts`）和改名时 insert-or-ignore。
     `project.initGit` 依赖 git init 后的项目重新解析与 ID 迁移，需要先把这部分搬进 core（`ProjectV2.commit`
     注释里的过渡桥）再做；V1 `project.ts` 的 `fromRow` 与 core `ProjectMetadata.fromRow` 重复，随 V1 删除。
3. **app 删 V1 分支**：去掉 `detectServerProtocol` 与全部 `protocol === "v1"` / `!== "v1"` 分支，恢复上表中
   V2 下静默失效的功能（项目重命名、目录选择、配置读写、自定义 provider）。
4. **TUI console**：决定 console/org 切换是迁 V2 还是删除（上游 console 服务 fork 不用，倾向删除）。
5. **服务端拆除**：见下节。
6. app 类型层：`@opencode-ai/sdk` 的 `Session`/`Message`/`Part` 等类型与 V1 事件兼容层替换为 `@miao/client` 类型
   （见 `V1_API_MIGRATION.md` 的 Legacy Types 一节），最后移除 `@opencode-ai/sdk` 依赖。

## 服务端拆除（P7 收尾，P4 之前或并行）

1. 新增上述缺失的 V2 组：`packages/protocol/src/groups/<name>.ts` + `packages/server/src/handlers/<name>.ts`，
   在 `makeApi`（`packages/protocol/src/api.ts`）与 `packages/server/src/api.ts` 注册。
2. `cd packages/client && bun run generate` 重新生成客户端类型。
3. 迁移 TUI/app 调用点，`rg` 确认不再有非 `v2.*` 的 legacy SDK 调用。
4. 删除 `packages/miao/src/server/routes/instance/httpapi`（V1 树）与对应 handlers/groups/tests；
   `server.ts` 切到 `packages/server` 的 V2-only assembly。2026-10-03 仍挂着的 V1 组（`groups/`）：`config`、
   `control-plane`、`control`、`event`、`experimental`、`file`、`global`、`instance`、`mcp`、`metadata`、`project`、
   `provider`、`pty`、`query`、`tui`、`workspace`。其中 `tui`（`/tui/*` 远程控制 TUI）、`global/health`、
   `global/upgrade` 要先确认是否还有调用方（miaotty、`miao attach`、插件）。
5. `packages/miao` 只剩 CLI 外壳；`packages/miao/src/session|tool` 与旧会话路由组已随 P4 删除（2026-10-03），`app-runtime` 的 V1 层与剩余非会话旧路由在 P7 收尾。

## 验证（每步）

- `bun typecheck`（改动的包）通过。
- `packages/tui`、`packages/app` 相关测试通过。
- `rg -oN "sdk\.client\.([a-zA-Z]+)\." packages/tui/src` 的非 `v2` 计数逐步归零。
