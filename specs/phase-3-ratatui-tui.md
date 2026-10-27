# Phase 3：ratatui TUI 统一（单二进制，类 codex 形态）

状态：实施中。T1 骨架已合入 main（#1503）；T2 传输层已实现，评审中（#1520）；T3 及以后未开始。
前置：`specs/rust-phase-2.md` §5（Phase 3/4 边界）。前提条件已满足：
S3 之后会话状态只有引擎一个属主，S4 之后产品库是投影——TUI 重写不再面对两套状态。

## 1. 目的与不变量

把 `packages/tui`（TypeScript/Ink，208 个文件、约 3.6 万行，跑在 bun 上）替换为 Rust
ratatui TUI，直接以客户端身份对话 `miao-engine`。最终形态与 codex 一致：`miao` 一个二进制，
TUI 是它的默认子命令；bun/Node 不再是 TUI 的运行时依赖。

不变量（每一片都不得破坏）：

- **功能不断供**：切片期间 TS TUI 仍是默认入口；Rust TUI 在 `miao-tui`（env 或参数）后面生长，
  剪彩（默认切换）与删除 TS TUI 不在同一个 PR（§4 T11）。
- **引擎是唯一状态属主**：Rust TUI 只做渲染与输入，不建第二份会话状态；它消费的
  wire 事件与 TS TUI 完全一致（`session.next.*`、`history`、`snapshot`、`approval`、`wake`）。
- **回滚开关有测试**：默认切换后，环境变量一键回 TS TUI，直到 TS TUI 被删除。
- **三平台**：macOS、Linux、Windows（ConPTY/VT）都必须可构建、可冒烟；Windows 由 `96` 构建机验证。

## 2. 现状测绘（实现前已核实的事实）

- 入口：`packages/miao/src/index.ts:88` 默认命令是 TUI；TUI 进程按 location 拉起
  `miao-engine serve`（CLI 参数：`--db`、`--workspace`、`--policy`、`--context-config`、
  `--model-routes-config` 等，S5 step 2 会把它们收敛成目录+环境）。
- 传输：引擎 client 是 request/subscribe 两面（`connection.client.request("snapshot"/"events"/"wake"/...)`、
  `client.subscribe(sessionID, cursor)`），事件即 `input.admitted`、`input.promoted`、
  `session.next.*` 系。产品侧已有完整翻译层（`packages/miao/src/engine/bridge.ts`、
  `session-data.ts`），Rust TUI 按同一词汇表直读，不再经过 TS 翻译。
- TS TUI 的面：routes（home/session）、30+ dialog、command palette、prompt（history/stash/
  frecency）、theme（`.miao/tui.json`）、feature-plugins、attention/通知、clipboard、audio、
  keymap、zed 外编（`editor-zed.ts`）、remote（`specs/remote-control.md`）。
- 引擎已经持有 LSP、权限、审批、cron、knowledge 等服务面——TUI 只是另一类客户端，
  不需要在 Rust TUI 里重实现任何会话侧智能。

## 3. 架构

- 新 crate：`crates/miao-tui`（ratatui + crossterm + tokio current-thread）。
  引擎连接复用 `miao-engine` 的 client 类型；引擎仍以子进程 `miao-engine serve` 运行
  （保持今天「一 location 一引擎进程」的隔离与崩溃半径）。in-process 合并在 Phase 4 再评估。
- Rust TUI 的模块边界对应切片：`transport`（client+replay+subscribe）、`transcript`（渲染）、
  `composer`（输入）、`dialogs`、`palette`、`theme`、`platform`（win32/clipboard/attention）。
- 与 TS TUI 共存期内，两者读同一引擎、同一数据库，可同时打开同一会话（今天已允许）。

## 4. 切片（每片：单独设计确认 → 实现 → 功能验证 → PR）

验收基线：每片附一个 pty 驱动的脚本化测试（参考 `packages/tui/test/` 现有断言方式移植），
外加 `specs/phase-3-parity.md` 台账逐项勾对 TS TUI 的既有行为。

- **T1 骨架**：`miao-tui` crate + 事件循环 + 窗格框架 + theme 加载（`.miao/tui.json` 兼容）
  + 三平台 CI 构建。验证：pty 冒烟（启动、退出、resize、Ctrl+C 语义）。
- **T2 传输层**：Rust 引擎 client（request/subscribe/断线重连/事件回放到 cursor）。
  验证：对假引擎（对齐 `tests/` 现有 fixture 方式）断言重放与订阅序。
- **T3 只读会话视图**：home（会话列表、排序、预览）+ transcript 渲染（文本、工具调用、
  diff、思考块）。数据全部来自 `history`/wire 翻译词汇。验证：重放固定会话的渲染快照（文本级）。
- **T4 输入编辑器**：多行编辑、CJK/IME 安全区、粘贴（含图片标记）、历史、stash、
  @文件/agent 引用补全，提交走引擎 admit（steer/queue 语义与 TS 一致）。
  验证：pty 输入序列 → 引擎收到的 prompt 逐字节断言。
- **T5 流式与打断**：subscribe 增量渲染、turn 状态条、esc 打断（`interrupt`）、审批流
  （`approval` wire）。验证：假引擎脚本化回合 + 打断时序断言。
- **T6 对话框第一批**：模型/提供商切换、会话列表/重命名/删除、主题。
- **T7 对话框第二批**：workspace、accounts、MCP、skills、debug/status/tag/stash。
- **T8 命令面**：command palette、slash 命令、模板命令（`SessionCommand` 渲染与参数）。
- **T9 渲染对齐**：markdown 渲染、各工具结果的专用渲染（bash/edit/webfetch/todo），
  对照 parity 台账补差。
- **T10 集成面**：zed 外编、clipboard、attention/通知、audio、win32 VT、remote 协议接入。
- **T11 剪彩**：`miao` 默认切 Rust TUI，`--tui legacy`/env 回 TS；观察一个发布周期后
  在 Phase 4 删除 `packages/tui`（删除与新增不同 PR，沿用 §4 纪律）。

## 5. 验收与验证策略

- 每片的功能验证进 CI：pty 脚本测试三平台跑通；Rust 侧单测用假引擎，不做真实网络调用。
- parity 台账（`specs/phase-3-parity.md`）与切片同步维护：TS TUI 的每个用户可见行为一行，
  标注「已对齐/有意偏离（原因）/未做」，剪彩前必须无「未做」。
- 人工验收最低集：真实 CJK 输入、真实 IME、Windows Terminal、tmux、窄终端（<80 列）。
- 性能底线：10k 行 transcript 滚动不卡帧（crossterm 事件循环 60fps 预算），渲染增量而非全量重绘。

## 6. 风险

| 风险 | 处理 |
|---|---|
| CJK/IME 在 crossterm 下的编辑正确性 | T4 单独成片并带专项测试；必要时引入 IME 事件桥，不静默丢字 |
| Windows ConPTY 差异 | 每片都在 `96` 构建机冒烟；win32 VT 代码从 TS 侧移植而非新写 |
| wire 词汇漂移（TS 翻译层里的隐性约定） | T2 先把 bridge.ts 的翻译规则翻成 Rust 并用同一段事件 fixture 断言两侧输出一致 |
| 功能长尾拖垮剪彩 | parity 台账公开缺口；剪彩条件是「无未做」，不追求像素级一致 |
| 双 TUI 并存期的用户困惑 | 默认切换前 `miao-tui` 一直非默认；切换 PR 与回滚开关同 PR |

## 7. 不做什么

- 不在 Phase 3 重实现 TS TUI 的 feature-plugins 宿主（插件兼容属 Phase 4）。
- 不改引擎 wire 协议；TUI 是纯客户端。
- 不做 GUI/Web 面复用（桌面 app 不在 Phase 3 范围）。
