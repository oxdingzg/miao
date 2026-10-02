# P7 — 非会话旧路由迁 `/api/*`

状态：进行中（2026-10-02 开始）。目标：让 TUI / app / CLI 完全脱离 V1 无前缀路由与 `@opencode-ai/sdk`，
使发布二进制的 server 能切到 `packages/server` 的 V2-only assembly，只剩 CLI 外壳。

## 已完成

- `formatter`：core `Format.status()` 下沉 + `GET /api/formatter`（protocol 组 + server handler）+
  重新生成 `packages/client` 与 legacy SDK；TUI `sync.tsx` 改走 `client.v2.formatter.status`。
  加组后必须重生成两套客户端：`packages/client`（纯 codegen）与 legacy SDK
  （`packages/sdk/js/script/build.ts`，内部 `bun dev generate` 起服务导出 OpenAPI）。
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
