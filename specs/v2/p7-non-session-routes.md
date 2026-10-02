# P7 — 非会话旧路由迁 `/api/*`

状态：进行中（2026-10-02 开始）。目标：让 TUI / app / CLI 完全脱离 V1 无前缀路由与 `@opencode-ai/sdk`，
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

## 客户端仍在用的 V1 无前缀命名空间（`rg -oN "sdk\.client\.([a-zA-Z]+)\." packages/tui/src`）

| 命名空间       | 次数 | V2 现状                               | 迁移目标                                                                              |
| -------------- | ---- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| `experimental` | 17   | 无 workspace 组（仅 `project-copy`）  | 新增 `/api/workspace`（list/status/create/…）                                         |
| `vcs`          | 4    | 无                                    | 新增 `/api/vcs`（status/diff）                                                        |
| `provider`     | 4    | `/api/provider`、`/api/integration`   | `oauth.authorize/callback` → `integration.oauth.*`；`provider.auth` → `integration.*` |
| `mcp`          | 4    | 无                                    | 新增 `/api/mcp`（list/add/remove/connect/disconnect/resources）                       |
| `instance`     | 4    | 无                                    | 新增 `/api/instance`（dispose 等）                                                    |
| `lsp`          | 2    | 无                                    | 新增 `/api/lsp`（status）                                                             |
| `config`       | 2    | 无                                    | 新增 `/api/config`（get/update，形状按 V2 Config）                                    |
| `formatter`    | 1    | 无                                    | 新增 `/api/formatter`（status）                                                       |
| `auth`         | 1    | `/api/credential`、`/api/integration` | 迁到 `credential`/`integration`                                                       |
| `app`          | 1    | 无                                    | 新增 `/api/app`（log）或删除调用                                                      |

app 侧：`packages/app/src` 仍有 `protocol === "v1"` 守护的 `client.session.*`（`session-archive.ts`、
`layout.tsx`、`directory-sync.ts`、`home-sessions-controller.tsx`、`server-session.ts`）与 V1 事件兼容层
（`server-sdk.tsx` 的 `adaptServerEvent`、`server-session.ts`）。V2 已有 archive/rename/get/message/context，
可逐点去掉 V1 分支。

## 下一步

剩余组都需要 core/schema 层工作，不是纯客户端迁移：

- `config`：core 的 `Config.Info` 定义在 `packages/core/src/config.ts`，**不在 `@miao/schema`**，protocol 无法引用；
  需要先把 config schema 落到 `@miao/schema`（或暴露 schema-safe 子集），再补 core 合并（变量替换 V1 有、core 无）。
- `mcp`：core `MCP` 只做“连接并注册工具”，没有 status/connect/disconnect；需把 `packages/miao/src/mcp` 的运行时状态下沉。
- `vcs`：core 无 VCS；core `Git` 只有 repo/change，需补 status/diff 的 V2 语义。
- `experimental/workspace`：需要 WorkspaceV2 的 list/status/create/remove + adapter + warp + console/controlPlane。

顺序：`config` → `vcs` → `mcp` → `experimental/workspace`（含 `instance`/`console`，因为 `instance.dispose` 与 console 切换绑定）。
每步固定：core 下沉/schema → 协议组 → handler → 生成两套客户端 → 迁 TUI/app → 删 V1 分支 → typecheck/测试 → commit & push。

## 服务端拆除（P7 收尾，P4 之前或并行）

1. 新增上述缺失的 V2 组：`packages/protocol/src/groups/<name>.ts` + `packages/server/src/handlers/<name>.ts`，
   在 `makeApi`（`packages/protocol/src/api.ts`）与 `packages/server/src/api.ts` 注册。
2. `cd packages/client && bun run generate` 重新生成客户端类型。
3. 迁移 TUI/app 调用点，`rg` 确认不再有非 `v2.*` 的 legacy SDK 调用。
4. 删除 `packages/miao/src/server/routes/instance/httpapi`（V1 树）与对应 handlers/groups/tests；
   `server.ts` 切到 `packages/server` 的 V2-only assembly。
5. `packages/miao` 只剩 CLI 外壳；`packages/miao/src/session|tool`、`app-runtime` 的 V1 层随 P4 删除。

## 验证（每步）

- `bun typecheck`（改动的包）通过。
- `packages/tui`、`packages/app` 相关测试通过。
- `rg -oN "sdk\.client\.([a-zA-Z]+)\." packages/tui/src` 的非 `v2` 计数逐步归零。
