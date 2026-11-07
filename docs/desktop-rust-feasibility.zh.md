# miao 桌面版的 Rust 化：可行性与路线

**语言 / Language:** 简体中文（暂未提供英文版）

这份文档回答一个问题：miao 桌面版能不能变成"全 Rust"，代价和收益各是什么，以及按什么顺序推进。
它是判断与计划，不是评测报告。数据来自当前仓库实测（2026-11-07）。

## 1. 桌面版今天是什么

三层结构，只有最内层是 Rust：

| 层 | 实现 | 体量 | 入口 |
| --- | --- | --- | --- |
| 壳（主进程） | Electron 42 + electron-vite / electron-builder，TypeScript | 3,895 行 / 40+ 文件 | `packages/desktop/src/main/` |
| 后端 sidecar | `utilityProcess.fork` 启动的 Node 进程，跑 TS server | 51 文件 / 5,529 行 / 30 个 handler | `packages/desktop/src/main/server.ts`、`packages/server/src/handlers/` |
| UI | 桌面与 web 共用的 SolidJS 应用 | `packages/app` 153,762 行 + `packages/ui` 46,659 行 + `packages/session-ui` 27,391 行 ≈ 22.8 万行 | `packages/app`、`packages/ui` |

主进程承担的职责（`packages/desktop/src/main/`）：窗口与窗口状态、菜单、IPC、单实例、深链、外部链接、
更新器（`updater.ts`、`updater-controller.ts`）、sidecar 生命周期、WSL 支持（`wsl/`）、shell 环境探测
（`shell-env.ts`）、日志、草稿存储、崩溃/无响应兜底。

Rust 侧已经具备的（这决定可行性）：

- **引擎双传输**：stdio 与 loopback HTTP。`crates/miao-engine/src/http.rs` 提供 `POST /rpc` 与
  `GET /events`（SSE，带 `miao-engine-protocol` 版本头）。
- **`miao serve` 已是纯 Rust 常驻服务器**，带 token 与 idle 超时（`crates/miao-cli/src/cli.rs`，
  内部调用 `miao_engine::http::serve_with_idle_timeout`）。
- **终端方向已经全 Rust**：`crates/miao-tui` 54,831 行。
- **沙箱与 pty**：`crates/miao-sandbox`（macOS seatbelt、Linux Landlock、Windows AppContainer）。
- `crates/miao-native` 目前只是给 TS 用的 N-API 加速层（gix / tree-sitter / tiktoken），Rust 壳里可直接退役。

**关键缺口**：Rust 的 HTTP 只有引擎命令表（2 条路由），桌面依赖的**产品 REST 面**还在 TS server 里。
它的形状以协议分组为准（`packages/protocol/src/groups/`）：**29 个分组、168 个 `HttpApiEndpoint`**
（`session.ts` 一组就 44 个），实现落在 `packages/server/src/handlers/`（30 个文件、5,529 行）。
这是"全 Rust"真正的工作量所在；不过多数端点只是引擎命令表的投影，移植以路由与投影为主。

## 2. 结论

- **全 Rust GUI（用 egui / Slint / GPUI 重写界面）：不做。** 要重写 22.8 万行共享 UI，
  并丢掉桌面与 web 的共用；粗估最小可用 12–18 人月，之后长期双份维护。
- **Rust 壳 + 保留 Web UI：做，分两步。** 让 Electron 主进程与 Node sidecar 都消失，
  后端吃 `miao serve` 的产品 REST 面，外壳换成 Tauri/wry。

一句话：**要去掉的是 Node 与 Electron，不是那套 UI。**

## 3. 两种方案对比

| 维度 | 现状（Electron + Node sidecar） | 全 Rust GUI | Rust 壳 + Web UI（推荐） |
| --- | --- | --- | --- |
| 界面代码 | 22.8 万行，桌面/web 共用 | 全部重写，失去共用 | 原样复用 |
| 后端 | TS server + Rust 引擎 | Rust | Rust（补产品 REST 面） |
| 安装体积 | Electron 运行时，约 150–250MB | 小 | 约 10–25MB（复用系统 WebView） |
| 内存 / 冷启动 | Electron + Node 双运行时 | 最优 | 明显改善 |
| 更新器 / 签名 / 公证 | 现成（electron-updater） | 重做 | 重做（tauri-updater 或自研） |
| 平台一致性 | Chromium 一致 | 一致 | WebView 碎片化（WKWebView / WebView2 / WebKitGTK） |
| 安全面 | Node 运行时 + 本地端口 | 最小 | 无 Node、无 sidecar 端口 |
| 主要风险 | 体积、双运行时 | 成本与长期双维护 | WebView 差异、更新与签名基建重建 |

## 4. 路线

### 第一步：去 Node 后端（保留 Electron）

目标：桌面不再需要 TS server 与 Node 运行时。

顺序不能反：`miao serve` 今天只有引擎命令表，产品端点在 `packages/server` 里。先切换桌面，
UI 会立刻缺接口。所以是"先补服务端，再切客户端"：

1. 把 `packages/server` 的产品 REST 面补进 Rust，由 `miao serve` 承载（先投影组，再 TS 专属组）。
   多数 handler 只是引擎命令表的投影，工作是路由与投影，不是重写业务。
2. 桌面改为直接连 `miao serve`（loopback HTTP + SSE），并处理认证适配：服务端用 stdout 打印的 token，
   渲染进程现在用 basic auth（`ServerReadyData { url, username, password }`）。
3. web 形态改由 Rust 直接托管静态 UI，避免同时维护两套 server。
4. 退役 `crates/miao-native` 的 N-API 层（不再有 JS 调用方）。

168 个端点的实际形状（按 `packages/protocol/src/groups/` 统计，引擎命令表见
`crates/miao-engine/src/protocol.rs` 的 `Command`，共 102 条）：

- **绝大多数集中在少数分组**：`session` 44、`runtime` 16、`pty` 9、`workspace` 8、`permission` 8、
  `mcp` 7、`integration` 7、`project` 6，其余均 ≤5。
- **约三分之二（110–120 个）可直接投影到已有引擎命令**：session/runtime/permission/config/model/
  provider/vcs/worktree/question/event/agent/message/location 等，这部分是写路由与投影。
- **约 50–60 个落在 TS 侧，需要真正搬实现**：`fs` 与文件监听、`lsp`、`mcp` 会话、`pty`、
  `formatter`、`skill`/`reference` 发现、slash `command`、`project` 注册、`control-plane`。
  其中 `fs`/`pty` 在 `crates/miao-sandbox` 已有基础，`lsp`/`mcp` 是全新工作量。

所以排法是先做投影组（可并行、低风险），再逐个搬 TS 专属组；不要平均分配到 29 个分组上。

验收指标（上线前测一次、与现状对照）：

- 进程树中不再出现 Node / sidecar；
- 冷启动时间、空闲 RSS、安装包体积三项与基线对照；
- `packages/server` 行数归零（或只留测试）；
- 桌面端 e2e：会话、diff、终端、LSP 诊断、审批全通。

粗估：4–8 人周（不含更新器改造）。

### 第二步：去 Electron（换 Rust 壳）

目标：主进程由 Rust 实现，Web UI 跑在系统 WebView 里。

按职责逐项移植（都在 `packages/desktop/src/main/` 有现成实现可对照）：

1. 窗口/多窗口、窗口状态、单实例与深链（`windows.ts`、`window-registry.ts`、`window-state.ts`）。
2. 菜单、托盘、快捷键（`menu.ts`、`desktop-menu-actions.ts`）。
3. IPC 桥：preload 的 `window.api` 换成壳提供的命令通道（`ipc.ts`、`preload/`）。
4. 更新器与发布：三平台签名/公证/增量更新重建（`updater*.ts` → Rust）。
5. PTY 与 WSL（`@lydell/node-pty`、`wsl/` → `miao-sandbox` 的 pty 与自研桥）。
6. 可观测性：Sentry / 日志 / 崩溃兜底（`logging.ts`、`unresponsive.ts`）。

验收指标：三平台安装包可自动更新；与 Electron 版逐项对齐的 UI 冒烟；崩溃率不高于现状。

## 5. 未决问题

- **WebView 差异**：WKWebView 与 WebView2 在 IME、字体、滚动、`contenteditable`、剪贴板上的行为要和
  Chromium 逐项对齐；这需要一套"渲染回归"用例，而不是靠肉眼。
- **更新与签名基建**：现在是 `electron-builder` + `electron-updater`，三平台流水线要重建，
  macOS 公证、Windows 代码签名、Linux 分发包格式都要重新验证。
- **web 形态归属**：web 端继续保留 TS server，还是统一到 Rust？这决定第一步是否能把
  `packages/server` 彻底删掉。
- **iOS / 移动端**：若移动端复用同一套 UI 与 API，产品 REST 面的形态要一次定好，避免二次迁移。
- **贡献者结构**：UI 贡献者以 TS 为主；壳换 Rust 后，桌面壳的贡献门槛会上升。

## 6. 明确不做

- 不重写 UI（不做 egui / Slint / GPUI 版本）。
- 不为"全 Rust"而把引擎再包一层自研 RPC（已有 `POST /rpc` + `GET /events`）。
- 不在第一步同时替换更新器与签名流程（两件事分开验收，避免一次改动引入两个不可回滚的风险）。

## 7. 如何继续（给下一次会话）

按顺序取下一个未勾选里程碑即可，每项都以 PR 落地。

顺序上有一处必须先说清：`miao serve` 现在只承载引擎命令表（`POST /rpc`、`GET /events`），
而 UI 要的 168 个产品端点在 `packages/server` 里。所以**不能先切换桌面**——切换时桌面会立刻缺少
session/fs/vcs 等接口；必须先把 REST 面搬到 Rust，再让桌面改连。下面的 M1/M2 就是按这个事实排的：

- [ ] M1：在 `miao serve` 上补齐产品 REST 面。先做可投影组（session/runtime/permission/config/model/
  provider/vcs/worktree/question/event/agent/message/location，约 110–120 个端点），再搬 TS 专属组
  （fs 与监听、lsp、mcp 会话、pty、formatter、skill/reference、slash command、project 注册、
  control-plane，约 50–60 个）。对照 `packages/protocol/src/groups/` 与 `packages/server/src/handlers/`，
  每个组以一组测试收口；保持 `packages/server` 可运行，便于对照与回退。
- [ ] M2：桌面改连 `miao serve`（HTTP/SSE）。要一并解决认证适配：`miao serve` 现在用 stdout 打印的
  token，而桌面渲染进程用的是 basic auth（`ServerReadyData { url, username, password }`）。sidecar 保留为
  可回退开关，默认不再启动。
- [ ] M3：移除 sidecar 与 `packages/server`，web 由 Rust 托管；测三项基线（冷启动 / 空闲 RSS / 安装包体积）。
- [ ] M4：选定 Rust 壳（Tauri/wry），只实现窗口 + 单实例 + 深链 + IPC 桥，跑通现有 UI。
- [ ] M5：更新器与三平台签名/公证重建。
- [ ] M6：PTY/WSL、托盘/菜单、可观测性补齐。

入口文件：

- 引擎 HTTP 传输：`crates/miao-engine/src/http.rs`
- 常驻服务器：`crates/miao-cli/src/cli.rs`（`serve_forever`）
- 桌面主进程：`packages/desktop/src/main/`
- 产品 REST 面：`packages/server/src/handlers/`
- 共享 UI：`packages/app`、`packages/ui`、`packages/session-ui`

## 8. 风险

- 最大风险不是 Rust 写不出来，而是**更新/签名基建重建**与**WebView 碎片化**带来的长尾问题。
- 第二步（换壳）必须在第一步的基线数据出来之后再做，否则无法判断收益来自哪里。
- 过渡期会同时存在 Electron、Rust 壳与 web，需要明确"谁是发布产物"，避免三套都半成品。
