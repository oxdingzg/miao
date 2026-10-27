# Phase 3 T10：集成面（通知、剪贴板、外编、Zed 选区、Windows 终端）

状态：实施中。前置：T9 已合入（#1533）。本片只改 `crates/miao-tui` 与本文，不动引擎 wire。

## 1. 范围

| 能力 | TS 现状 | Rust 目标 | 验证 |
| --- | --- | --- | --- |
| 配置链 | `packages/miao/src/config/tui.ts`：全局 `~/.config/miao/tui.json` → `MIAO_TUI_CONFIG` → 项目 `.miao/tui.json`（由远及近） | 新增 `config` 模块按同样顺序合并 `attention` 段；主题仍走现有 `theme::load` | 单测：优先级、JSONC、默认值 |
| 通知/声音 | `attention.ts` + `feature-plugins/system/notifications.ts`：焦点感知、OSC 通知、音效、title 80 / message 240 截断、`enabled=false` 默认 | `platform::attention`：Focus 事件、OSC 9 / OSC 777（tmux 透传）、配置音文件播放，否则终端铃；触发点对齐 `approval.requested` / `question.requested` / `run.finished(reason)` | 单测：序列、截断、焦点门控、音量；pty 冒烟不启用通知 |
| 剪贴板 | `clipboard.ts`：OSC 52 + 平台命令写入；图片优先读 `MTTY_CLIPBOARD_FILE`，再 osascript / PowerShell / wl-paste / xclip，最后文本 | `platform::clipboard`：`copy` 写 OSC 52 并调用平台命令；`read` 返回图片（png base64）或文本；空粘贴与 Ctrl+V 触发 | 单测：命令选择、OSC 52、10 秒新鲜度；冒烟：Ctrl+V 文本进入 composer |
| 图片附件 | prompt 以 `[Image N]` 标记 + file part 提交 | composer 保存附件列表、插入 `[Image N] ` 标记，`admit` 的 `attachments` 参数带上 `{mime,data}`；提交失败按原样恢复 | 单测：标记计数、失败恢复；传输测试：admit 帧含 attachments |
| 外编 | `<leader>e`，`$VISUAL`/`$EDITOR`，临时 md 文件，挂起/恢复终端 | 新增 `platform::editor`：leader `e` 挂起 TUI 启动编辑器，退出后把内容写回 composer；临时文件 0600 并删除 | 单测：命令解析、临时文件清理；pty 冒烟用假编辑器 |
| Zed 选区 | `editor-zed.ts`：`ZED_TERM` 下读 Zed SQLite 的活动编辑器与选区，形成 `<system-reminder>` 前缀 | `platform::zed`：用系统 `sqlite3 -readonly -json` 读同一查询（避免引入 SQLite C 依赖）；提交时按选区 key 去重后前置上下文 | 单测：字节偏移→行列、上下文格式、去重；无 `sqlite3` 时静默不可用 |
| Windows 终端 | `terminal-win32.ts`：VT 输出、Ctrl+C guard、输入缓冲清理 | `crossterm` 已负责 VT 与 raw 模式；本片不改平台代码，Windows CI 构建 + 冒烟作为验收 | 既有 Windows CI |
| remote | `/remote-control` 走宿主 Runtime 与 `@miao/remote-control`，不是引擎 wire | **有意偏离**：`miao-engine serve` 没有 remote 方法，Rust TUI 是纯引擎客户端；远程接入须由宿主 Runtime/Hub 交付后另开引擎面，见 `specs/remote-control.md`（状态：拟议） | parity 台账记录原因 |

## 2. 行为细节

### 2.1 配置

- 文件顺序（后者覆盖前者）：全局 `tui.json` → `MIAO_TUI_CONFIG` → 项目祖先目录的 `.miao/tui.json`（根在前）。
- `attention` 默认值与 TS 一致：`enabled=false`, `notifications=true`, `sound=true`, `volume=0.4`, `sound_pack="miao.default"`, `sounds={}`。
- `sounds` 的相对路径按所在配置文件目录解析；未知键与非法值只告警，不影响启动。
- 内置音包不随 Rust 二进制分发（有意偏离）：配置了 `sounds.<name>` 就播放该文件，否则用终端铃。

### 2.2 通知门控

- 焦点未知时通知跳过（对齐 TS 的 `focus_unknown`）；声音不受焦点影响。
- 通知文本先剥 ANSI、折叠换行、去掉控制字符，再做 80/240 字符截断。
- 发射：`TERM_PROGRAM` 为 iTerm/WezTerm 或 `WT_SESSION` 用 OSC 9，其余用 OSC 777；`TMUX` 时额外包一层 passthrough，与 `clipboard.ts` 的写法一致。
- 触发点只针对当前打开的 Session，避免后台会话刷屏；同一 `request_id` 只通知一次。
- 失败重跑（`run.finished` 的 `reason=failed`）用错误音/文字；`interrupted` 不通知。

### 2.3 剪贴板与图片

- 写入：先写 OSC 52（tmux/ST 透传），再调用平台命令（macOS `pbcopy`；Linux `wl-copy` / `xclip` / `xsel`；Windows PowerShell `Set-Clipboard`）。平台命令失败不报错，OSC 52 仍是有效通道。
- 读取：`MTTY_CLIPBOARD_FILE` 只在 10 秒内且读取后删除；否则 macOS osascript JXA、Windows/WSL PowerShell、Linux `wl-paste` / `xclip` 取图；都没有则读文本（`pbpaste` / PowerShell / `wl-paste` / `xclip`）。
- 空 bracketed paste 与 `Ctrl+V` 都触发读取；读取在后台线程完成，UI 不阻塞。
- 图片以 `[Image N] ` 文本标记留在 composer，附件单独随 `admit` 的 `attachments` 发送；提交失败时文本与附件一起恢复。

### 2.4 外编

- `<leader>e`：把 composer 文本写入 `$TMPDIR/miao-<pid>.md`（Unix 0600），挂起备用屏与 raw mode，继承 stdio 运行 `$VISUAL`/`$EDITOR`，退出码为 0 时读回内容；文件无论成败都删除。
- 未设置编辑器时给出 composer 提示，不挂起终端。
- 编辑器运行期间终端事件继续排队，恢复后照常处理。

### 2.5 Zed 选区

- 仅在 `ZED_TERM=true` 或 `TERM_PROGRAM=zed` 时启用。
- 数据源：`MIAO_ZED_DB`，否则 macOS `~/Library/Application Support/Zed/db/0-stable/db.sqlite`，Linux `~/.local/share/zed/db/0-stable/db.sqlite`。
- 查询与 TS 相同：活动 pane 的活动 Editor，按工作区路径包含当前目录打分，取最新；选区字节范围按 UTF-8 边界转字符，内容优先取 `editors.contents`，否则读 buffer 文件。
- 上下文格式与 `formatEditorContext` 相同，作为用户文本前缀提交；相同选区只发一次。

## 3. 不做什么

- 不引入 SQLite C 依赖、不打包音效资源、不实现插件音包注册（`registerPack`/`activate` 属插件宿主，Phase 4）。
- 不实现 `/remote-control`（见第 1 节）。
- 不做鼠标框选复制；Rust 侧的复制是「复制最后一条回复」，在 parity 台账标为有意偏离。

## 4. 验证

- xx02：`cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`。
- pty 冒烟新增：假编辑器回写 composer；空粘贴走文本剪贴板（用假 `pbpaste` 不可行时只测纯函数，冒烟保持确定性）。
- `specs/phase-3-parity.md` 增补本片各行，剪彩前保持无「未做」。
