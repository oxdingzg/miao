# 桌面端架构（Tauri 壳 + 共享渲染层）

状态：方案已定，壳与最小前端已落地；桌面集成面与打包流水线待分批实现。2026-11-09

## 1. 结论

桌面端不是一个新客户端，而是同一内核的另一个窗口：

```
apps/desktop（Tauri 2 壳，Rust）
├─ WebView（系统 WebView：WKWebView / WebView2 / WebKitGTK）
│    └─ @miao/app + @miao/ui —— 与 web 版、与 Electron 版同一份 Solid 渲染层
└─ Rust 壳：sidecar 生命周期、窗口/菜单/深链/更新、平台细节
     └─ sidecar = miao 单一二进制（`miao serve` 常驻 loopback 服务）
```

三条硬约束：

1. **不为桌面端新增第二套协议。** 渲染层只经 `ServerConnection` 连本机 sidecar；桌面壳不定义自己的业务协议。
2. **每窗口一个运行时**，随窗口退出，不装 launchd/systemd 常驻服务——与 [`window-runtime.md`](window-runtime.md) 一致。
3. **渲染层只有一份。** `packages/app`、`packages/ui` 同时服务 web、Electron（过渡期）与 Tauri 壳；桌面壳只提供平台能力，不复制业务 UI。

## 2. 为什么是 Tauri，而不是继续 Electron

| 事实 | 证据 | 对决策的影响 |
| --- | --- | --- |
| Tauri 壳能做的事，Electron 版都在做；但 Electron 必须自带 Chromium 与 Node | `packages/desktop/src/main/server.ts` 用 `utilityProcess.fork` 起 TS sidecar | 用户机器上多一份 Chromium + Node 运行时 |
| miao 已经是单一 Rust 二进制，`serve`/`web`/`attach`/`hub`/`acp` 都在一个可执行文件里 | `crates/miao-cli/src/cli.rs:34-98`、`serve_forever` | 壳可以直接 spawn 该二进制，不再需要 Node/Bun 运行时 |
| 引擎支持进程内绑定 | `crates/miao-tui/src/transport.rs:155`、`src/bin/embedded_probe.rs` | 后续可做到「壳 + 引擎同进程」，Electron 无法如此 |
| 上游做过完整 Tauri 桌面端，后来删除 | 见 §3 | 实现可从历史恢复（MIT），但这条壳今后由 miao 维护 |

## 3. 上游证据：Tauri 桌面端存在过，后被删除

- `packages/desktop/src-tauri` 在 opencode 上游存在了数月，覆盖 Linux Wayland/X11 选择、Windows job object 与 ConPTY 无关的进程包裹、macOS entitlements、NSIS 资源、spector 生成 bindings、更新通道与签名（Azure Artifact Signing）。
- 提交 `b4147c8d08`（`refactor(desktop): consolidate desktop-electron into desktop package (#25822)`）把 `packages/desktop/src-tauri` 的 182 个文件整块删除，并把 `packages/desktop-electron` 的 Electron 实现改名接管 `packages/desktop`。也就是说：**上游最终选择 Electron，并放弃了 Tauri 壳**。
- 该提交只说明合并动作，没有给出弃用理由。因此不能据此推断 "Tauri 不可行"；能推断的是 **这条壳上游不再维护**，miao 若采用它必须自己承担后续平台回归。
- 许可证：`git show upstream/dev:LICENSE` 仍为 MIT，`Copyright (c) 2025 opencode`，恢复这段代码时保留其版权与许可声明。

结论：恢复上游壳是低风险的起点（依赖版本组合经真机验证），代价是这条壳成为 miao 自维护代码。真正的差异化理由是 §2 的第 2、3 条——miao 有 Rust 内核，上游没有。

## 4. 目录选择

`apps/` 放**可交付的终端应用**，`packages/` 放**被 workspace 消费的库**：

- `apps/ios`：SwiftUI 原生客户端（远程控制 + 端侧 agent）。
- `apps/desktop`：Tauri 壳与其渲染层入口（本目录），`src-tauri/` 是原生壳。
- `packages/app`、`packages/ui`、`packages/session-ui`：跨客户端共享的渲染层与组件。
- `packages/desktop`：**过渡期保留**的 Electron 实现，只作参照与功能对照；对等后删除，不再新增功能。

workspace 通过根 `package.json` 的 `workspaces.packages` 显式登记 `apps/desktop`（不写 `apps/*`，避免把无 `package.json` 的 `apps/ios` 纳入）。

## 5. 阻塞点：渲染层的数据通道（必须先解决）

壳能起来，不等于桌面可用。当前 main 上：

- 发布产物只有 `crates/miao-cli`：一个平台一个 `miao-<os>-<arch>`，引擎与 TUI 同进程
  （`.github/workflows/release.yml:154-160`），Bun 宿主不再产出。
- 该二进制的 `serve` 只提供引擎自己的控制面：`POST /rpc`、`GET /events`、`GET /api/health`、
  `POST /lease`（`crates/miao-engine/src/http.rs:89-95`）。
- `packages/app` 仍按旧的 TS `HttpApi` 工作：数据层用 `@miao/client`（`/api/*`），健康检查
  `/api/health`、终端 `/api/pty/<id>/connect`（`packages/app/src/utils/terminal-websocket-url.ts`）。
- 仓库自己的验收门把 web/desktop 客户端记为 deferred（`docs/acceptance/2026-11-05-rel04-completion-gate.md:71`）。

因此桌面端的第一优先级不是壳，而是二选一：

1. **渲染层迁到引擎 RPC**（推荐）：在 `packages/app` 里加引擎传输，读 `snapshot`/`events`/`history`，
   与 TUI 同语义（快照重投影），逐步替换 `@miao/client` 的 `/api/*` 调用。
2. **Rust 侧实现 `/api/*`**：在引擎 HTTP 面上补齐 HttpApi 兼容层。改动集中在 Rust，但会把旧协议固化进发布二进制。

选定 1 之后，桌面与 web 共用同一条数据通道，`miao serve` 直接作为 sidecar，不再需要任何 Bun 运行时。

## 6. 分阶段

| 阶段 | 内容 | 完成判据 |
| --- | --- | --- |
| P0（本次） | 恢复并改名壳：`ai.miao.desktop*` 标识、`miao` sidecar、`miao://` 深链、`~/.miao/bin/miao` 安装路径、更新源；最小渲染层入口接 `@miao/app`；sidecar 准备脚本；构建与 typecheck 可跑 | `bun typecheck`、`vite build` 通过；`cargo check --all-targets` 在构建主机通过 |
| P1（阻塞项） | 渲染层数据通道（§5 方案 1）：`packages/app` 接入引擎 RPC，TUI 已有的投影语义复用 | 桌面与 `miao serve` 之间能列出会话、跑通一轮对话 |
| P2 | 桌面集成面对齐：菜单、深链、草稿存储、原生翻译、附件/保存对话框、剪贴板图片、致命错误上报（以 `packages/desktop/src/preload/index.ts` 为清单） | 逐项对照 Electron 版验收 |
| P3 | 打包与发布流水线：macOS 签名+公证、Windows NSIS、Linux deb/rpm、`latest.json`；`miao` 作为 `externalBin` 一并签名 | 三平台各出一个可安装件，首次安装能连上本地 sidecar |
| P4 | 单进程：壳内进程内绑定 `miao-engine`（同 TUI `start_embedded`），去掉 sidecar 进程 | 与 `native-engine-enablement` 的启用门槛对齐 |

**P0 交付后桌面尚不可用**：窗口能起、sidecar 能连，但会话界面依赖 P1。

## 7. 验收门槛

- 壳启动必须等到 sidecar 健康检查通过再显示主窗口；sidecar 退出的错误要可见，不能白屏。
- 关闭窗口必须回收 sidecar 进程组（Unix）与 job object（Windows）。
- 深链 `miao://` 在单实例下交给已有窗口，不新开实例。
- 与 TUI 相同的语义：提交事件驱动重投影，不在渲染层维护第二套 reducer。

## 8. 风险

- 系统 WebView 差异（WebKitGTK 版本、WebView2 更新通道）需要最低版本门槛与冒烟项。
- 上游已弃用该壳，桌面相关修复（安全公告、平台回归）不会再从上游流入。
- 过渡期 `packages/desktop`（Electron）与 `apps/desktop`（Tauri）并存，两份壳的桌面能力要按清单对齐后再删除前者。
- 若 P1 选择方案 2（Rust 实现 `/api/*`），会把已计划退休的 HttpApi 固化进发布二进制，与 V2-only 路线冲突。
