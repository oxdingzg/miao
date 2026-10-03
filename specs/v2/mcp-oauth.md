# V2 MCP OAuth（移植进 core）

状态：设计稿，2026-10-03。前置于 `v2-only-routes.md` 第 3 步（C.2）。

## 现状（按代码核实）

- core `MCP`（`core/src/mcp.ts`，location node）连接远程服务器时只传 `requestInit.headers`，**不带
  `authProvider`**；遇到 401 只把状态标成 `needs_auth` / `needs_client_registration`。core 里没有任何代码读
  `mcp-auth.json`。
- app 打开需要认证的 MCP 时调 V1 `POST /mcp/:name/auth/authenticate`（`app/src/context/server-sync.tsx:676`）。
  它在 **V1 `MCP`**（`miao/src/mcp/index.ts`）里跑完 OAuth、把 token 写进 `mcp-auth.json`，但随后的 V2 重连
  仍不带 token → 依旧 `needs_auth`。**结论：MCP OAuth 在 V2 下已不可用**，补一个同语义的 V2 路由修不好。
- V1 的 OAuth 部件只依赖 core：`mcp/auth.ts`（`McpAuth`，`<data>/mcp-auth.json`，按 MCP 名存 tokens、
  clientInfo、codeVerifier、oauthState、serverUrl）、`mcp/oauth-provider.ts`（`McpOAuthProvider`、
  `McpOAuthPendingProvider`）、`mcp/oauth-callback.ts`（`127.0.0.1:19876/mcp/oauth/callback` 回调服务，5 分钟
  超时）、`mcp/browser.ts`（`openUrl`）。`miao mcp auth/logout/list`（`cli/cmd/mcp.ts`）也用它们。
- core 配置已有 `mcp.servers.<name>.oauth`：`false` 或 `{ client_id, client_secret, scope, callback_port,
  redirect_uri }`（snake_case，V1 为 camelCase）。

## 方案

1. **搬进 core**：上述四个模块移到 `core/src/mcp/`（`auth.ts`、`oauth-provider.ts`、`oauth-callback.ts`、
   `browser.ts`），行为不变。`McpAuth`、`McpBrowser` 为全局 node。**存储文件与格式不变**，V1 或 CLI 已存的
   token 直接可用。V1 原路径改为从 core 再导出，V1 `MCP` 与 CLI 在删除前共用同一份实现。
2. **core `MCP` 连接**：远程服务器除非 `oauth === false`，都挂 `McpOAuthProvider`（按 core 配置字段映射），
   于是已存 token 自动带上、过期自动刷新，与 V1 相同。
3. **core `MCP` 新增**：
   - `authenticate(name)`：非远程或 `oauth === false` → `UnsupportedOAuthError`；否则起回调服务 → 用
     `McpOAuthPendingProvider` 发起连接截获授权 URL → 打开浏览器（失败则发 `mcp.browser.open.failed`，带 URL）
     → 等回调并校验 state → `finishAuth` 换 token → `connect(name)` → 返回新状态。若服务器无需授权直接连上，
     则直接 `connect(name)`。待完成的 transport 存在服务实例内，按名字索引。
   - `removeAuth(name)`：删 `mcp-auth.json` 中该项、取消待回调，然后断开并重连，状态回到 `needs_auth`。
4. **路由**（`/api/mcp`，location 为项目任一目录）：
   - `POST /api/mcp/:name/auth` → `authenticate`，阻塞到授权完成或超时，返回 `MCP.Status`。
   - `DELETE /api/mcp/:name/auth` → `removeAuth`，返回 `MCP.Status`。
   - 错误：未知名字 404 `McpServerNotFoundError`；不支持 OAuth 400 `InvalidRequestError`。
   - `mcp.browser.open.failed` 登记进 `ServerDefinitions`，客户端可提示用户手动打开 URL。
5. **app**：`toggleMcp` 的 `authenticate` 改调 `api.mcp.authenticate`。

## 不在范围

- 浏览器在**服务端主机**上打开（与 V1 相同）；远程或无头服务器上的授权另行设计。
- `miao mcp auth/logout/list` 继续走 V1 `MCP`（共用同一份 core 实现与存储），随第 2 层迁移。

## 测试

- V1 的 `auth`、`oauth-provider`、`oauth-callback`、`browser` 单测随模块迁到 core。
- core `MCP`：用本地假 OAuth MCP 服务器（参照 V1 `oauth-auto-connect.test.ts`）验证——已存 token 时连接带上
  Bearer；`authenticate` 走完授权码流程后状态变为 `connected`；`removeAuth` 后回到 `needs_auth`；本地服务器
  调 `authenticate` 返回不支持。
- 路由：未知名字 404、本地服务器 400；app 类型检查与相关单测。
