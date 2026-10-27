# Phase 3 parity 台账（TS TUI → Rust TUI）

状态枚举：**已对齐** / **有意偏离** / **未做**。剪彩（Phase 3 T11）前必须无「未做」。
行为来源：`packages/tui`、`packages/miao/src/config/tui.ts`。随切片逐行补充；
每行备注写明证据位置或偏离原因。

## T1 骨架（crates/miao-tui）

| 行为 | 状态 | 备注 |
|---|---|---|
| 进程启动进入 raw mode + alternate screen，退出时恢复 | 已对齐 | crossterm；正常退出与错误路径都 restore（`src/terminal.rs`） |
| panic 时恢复终端状态 | 已对齐 | panic hook 先 restore 再走默认 hook；`MIAO_TUI_TEST_PANIC` 注入钩子由 pty 测试覆盖 |
| Ctrl+C 在输入行非空时清空输入、为空时退出 | 已对齐 | 对齐 `packages/tui/src/config/keybind.ts:164`（input_clear=ctrl+c）与 `packages/tui/src/app.tsx:1238`（app_exit 仅输入空时生效） |
| ctrl+d 退出（仅输入空时） | 已对齐 | 同 app_exit 键位 |
| `<leader>q` 退出 | 有意偏离（基础版） | T1 用裸 `q` 直接退出；T4 输入编辑器落地时改为 leader chord，避免与打字冲突（`src/app.rs` 注释） |
| 标题栏显示 workspace 与分支名 | 已对齐（T1 占位） | 分支来自 `git rev-parse --abbrev-ref HEAD`，无 git 时显示 no git |
| composer 提示符与输入回显 | 有意偏离（基础版） | 单行 `> ` 回显；多行编辑、CJK/IME、粘贴、历史归 T4 |
| transcript 渲染 | 未做 | T3；T1 仅占位边框与说明文字 |
| 右侧侧栏 | 未做 | T3+；T1 在宽度 ≥100 列时渲染占位侧栏 |
| resize（SIGWINCH / ConPTY resize）自适应不崩 | 已对齐 | crossterm Resize 事件驱动重绘；pty 冒烟覆盖三平台 |
| `.miao/tui.json` 主题名选择 | 已对齐（dark 模式） | `BUILTIN_THEMES` 由 `packages/tui/src/theme/assets/*.json` 的 dark 侧生成，34 个内置主题全在（`every_typescript_theme_is_available` 守住名单）；light 模式与终端背景探测未做 |
| `.miao/tui.json` 多文件合并（全局目录 → MIAO_TUI_CONFIG → 项目链，就近覆盖） | 已对齐 | `config::files` 是 attention 与 theme 共用的同一条链（全局目录 → `MIAO_TUI_CONFIG` → 项目根-first）；嵌套 `{"tui": {...}}` 按 TS 规则摊平，顶层字段优先 |
| tui.json 为 JSONC（注释 / 尾逗号容忍） | 已对齐 | 本地剥离注释与尾逗号后 serde_json 解析（`src/theme.rs`） |
| tui.json 未知字段忽略并记录、不崩 | 已对齐 | 未知字段记 warning 到 stderr（config 加载发生在进 raw mode 之前）；损坏文件整份跳过并记录，同 TS 的 catch→log 语义 |
| 自定义主题 `themes/*.json` | 已对齐（dark 模式） | `theme::custom_themes`：全局配置目录 + 向上每层 `.miao` 的 `themes/*.json`，主题名取文件名，按 TS 的扫描顺序后者覆盖前者；支持 `defs` 引用、`{dark, light}` 取 dark、ANSI 码、`#rgb`/`#rrggbb`(`aa`)；缺必需色或循环引用则整份跳过并告警；同名覆盖内置主题 |
| keybinds 自定义覆盖 | 未做 | T1 键位固定 |
| 鼠标捕获（TS 默认开启） | 未做 | T1 不启用 |
| 光标样式 `cursor.style` | 未做 | 后续切片 |
| `miao-tui` 为非默认入口 | 已对齐 | 独立二进制，`--workspace <dir>`（默认 cwd）；`miao` 默认命令仍走 TS TUI，剪彩在 T11 |

## T2 传输层（crates/miao-tui/src/transport.rs）

| 行为 | 状态 | 备注 |
|---|---|---|
| NDJSON：`{id,method,params}` 请求，`{id,result\|error}` 应答 | 已对齐 | 写线程统一补 `\n`，与引擎 `read_line` 的帧边界一致 |
| `event` / `progress` / `resync` 三类通知走同一事件通道 | 已对齐 | `resync` 是 stdio 广播滞后的通知（`reason: ephemeral_progress_lagged`），TUI 据此重拉快照 |
| 每 session 维护 durable cursor，`seq` 取大不前移 | 已对齐 | 与 `packages/miao/src/engine/client.ts` 的订阅语义一致；引擎侧 `events(session, after)` 为 `seq > after` |
| 断线重连从 cursor 重放订阅 | 已对齐 | `Connection` 的 cursor 表跨进程代际共享；respawn 后逐个 `subscribe(after)`，测试断言重放不重复、不跳号 |
| 控制面请求 60s 超时 | 已对齐 | `Connection::start(spawn, timeout)` |
| 只读方法超时只拒绝本次调用，写方法超时退役传输 | 已对齐 | `READ_ONLY_METHODS` 与 TS 同一份列表（snapshot/sessions/history/events/usage/timer_sessions） |
| 单请求 error 应答不退役传输 | 已对齐 | `TransportError::Rejected`，对应 TS 的逐调用 `EngineError` |
| 无 id 的 error 帧以一次终态失败结算所有 pending | 已对齐 | 老引擎/坏请求无法回填 id |
| 反向工具调用（product/hook tool） | 有意偏离 | Rust TUI 不执行产品工具，一律回 `{bridge_id, error}`，避免引擎永久等待；TS host 会代理执行 |
| 退出分类：`engine_busy` / `engine_closed` | 已对齐 | 读 stderr 尾部 `Error: Busy`；其余带退出状态 |
| 显式 `close` 走 `shutdown` 帧，1s 内不退再 kill；不报终态失败 | 已对齐 | 与 TS 的 graceful shutdown 顺序一致 |
| `initialize` / `admit` / `cancel` / `approve` / `answer_question` / `history` / `snapshot` 便捷方法 | 已对齐 | 参数形状按引擎 `Command` 的 serde 字段名 |
| 录制 transcript 逐字段、按 seq 序到达 TUI | 已对齐 | `tests/fixtures/events.json` 收录 `bridge.ts` 翻译的 committed 事件（session.initialized → run.finished 共 11 条）；`tests/transport.rs` 断言 session_id/seq/kind/data/recorded_at_ms 全等且 cursor 落在末条 |

## T3 只读会话视图（home + transcript）

| 行为 | 状态 | 备注 |
|---|---|---|
| home 列表：root、未归档、按 updated_at_ms 降序，同值时按 id | 已对齐 | `session.rs:home_rows`；引擎 `sessions` 返回裸 id 数组，逐条 `snapshot(metadata_only)` 汇总 |
| 列表行：标题（无标题显示 untitled）、相对更新时间、目录名、选中标记 | 已对齐 | `pane.rs:Home::render`；相对时间 just now / Nm / Nh / Nd |
| 空列表与错误提示 | 已对齐 | `pane.rs:Home::render`（`notice` 优先） |
| 打开会话：全量 `snapshot` + `events` 分页回放 + `subscribe(cursor)` | 已对齐 | `engine.rs:open_session/project`；events 每页 100 条，按 `seq > after` 取 |
| transcript：user `❯` 前缀、assistant 的 agent·model 头、text、thinking 字符数折叠、工具状态图标与输出前 8 行、diff 前 12 行 | 有意偏离（文本近似） | markdown 与工具专用渲染在 T9；此处只做纯文本陈列 |
| `tool.completed` 的 display diff 按 call_id 关联，刷新时保留 | 已对齐 | 快照不含 diff，`Opened.displays` 跨投影携带 |
| 侧栏：会话标题、目录、更新时间（宽度 ≥100 列时显示） | 已对齐 | `pane.rs:SidebarPane` |
| 自动跟随尾部；手动滚动后脱离跟随 | 已对齐 | `TranscriptPane.follow` |
| PageUp/PageDown 与 Ctrl+Alt+Y/E 滚动 | 已对齐 | 每次 5 行；逐行/半页细粒度键位未复刻 |

## T4 输入编辑器

| 行为 | 状态 | 备注 |
|---|---|---|
| 多行编辑，按显示列（CJK 双宽、tab=4）定位光标 | 已对齐 | `editor.rs` 单测覆盖 CJK、emoji、宽字符与 tab |
| Enter 提交；Shift/Alt/Ctrl+Enter 与 Ctrl+J 换行 | 已对齐 | `editor.rs:handle_key` |
| Ctrl+A/E/B/F/W/U/K/D 与 Alt+B/F | 已对齐 | 行首尾、词移动、删词、删到行首/尾、删后一字符 |
| 上下移动保持列目标 | 已对齐 | `Editor.goal` 在垂直移动时锁定 |
| bracketed paste 原样进入编辑器（含换行、CJK），不触发提交 | 已对齐 | `terminal.rs` 开关 + `event::Paste`；pty 冒烟断言引擎收到原文 |
| 粘贴归一化（CRLF → LF、去尾随换行） | 已对齐 | `normalize_paste` |
| `@` 文件补全：Tab/Enter 接受、Esc 关闭、↑↓ 选择 | 有意偏离（基础版） | 只做子串过滤（非模糊评分），workspace 索引上限 2000 个文件，跳过 .git/target/node_modules；T9 细化 |
| 输入历史（↑/↓）与草稿恢复 | 已对齐 | `Composer.history`，持久化到 `composer.json`（`MIAO_TUI_STATE_DIR` 可覆盖） |
| 提交失败把草稿放回输入框 | 已对齐 | `PromptFailed` → `Composer::restore` |
| Ctrl+C 清空草稿，空输入时退出 | 已对齐 | `app.rs` |
| 真实终端光标用于 IME 定位 | 已对齐 | `render_composer` 用 `frame.set_cursor_position` 设置行列 |

## T5 流式与打断

| 行为 | 状态 | 备注 |
|---|---|---|
| subscribe 增量投影：committed 事件合并 150ms 后重拉快照 | 已对齐 | `engine.rs:REFRESH_DEBOUNCE` 与事件白名单（message/tool/run/approval/question） |
| run 状态条：working / idle，带 queued 数 | 已对齐 | `app.rs:update_status` |
| Esc 打断 active run（`cancel`），非运行态才返回 home | 已对齐 | Esc 顺序：关补全 → 拒绝提问 → cancel → 有面板则停留 → 回 home |
| 审批面板：tool/resource/input；1 allow once、2 always allow、3 deny | 已对齐 | `panel_lines` 与 `app.rs:handle_panel_key`；always 走 `approve_persistent` |
| 提问面板：单选/多选、↑↓、Space、Enter 逐题推进、Esc reject | 已对齐 | `Panel`；回答与拒绝都回传 question_id + input_hash |
| 面板模态：按键不进入 composer | 已对齐 | `handle_panel_key` 只要面板存在就消费按键 |
| 控制动作失败只提示，不结束传输 | 已对齐 | `AppEvent::ActionFailed` 写入 composer notice |

## T6 第一批对话框

| 行为 | 状态 | 备注 |
|---|---|---|
| leader 前缀 Ctrl+X，后接 `m`/`t`/`l`/`n`/`q` | 已对齐 | `app.rs:handle_leader`；未知和弦被丢弃，不进入 composer |
| 模型列表读 `model_catalog`，variant 展开为独立条目，Enter 发 `select_model` | 已对齐 | `dialogs.rs:ModelInfo::catalog`；binding 字段与引擎 `session_model::Binding` 一致（`route_id`/`variant` 省略为空） |
| 主题列表：Enter 立即应用并写 `preferences.json` | 已对齐 | `app.rs:apply_theme`、`state.rs`；工作区 `.miao/tui.json` 仍优先 |
| 会话列表含已归档；Enter 打开、r 重命名、a 归档切换、d 删除确认 | 已对齐 | `dialogs.rs` + `engine.rs` 的 `rename`/`archive`/`remove`；删除确认默认焦点在取消 |
| Ctrl+R 重命名当前会话 | 已对齐 | `app.rs`；预填当前标题 |
| 对话框模态：Esc 关闭、Ctrl+C 仍退出 | 已对齐 | `app.rs:handle_key` |
| 居中覆盖层先 `Clear` 再画边框 | 已对齐 | `pane.rs:render_dialog`，宽 60%（40–80 列），条目超过 14 行时滚动 |
| 删除是不可撤销的动作 | 已对齐 | 确认文案说明不可撤销；确认后 `remove` 并回 home（删的是当前会话时） |


## T7 状态、账户、调试与 stash

| 行为 | 状态 | 备注 |
|---|---|---|
| 状态视图：会话身份、模型绑定、账户、run 状态、排队数 | 已对齐 | `<leader>s`；`app.rs:status_rows` 只呈现 snapshot 已有事实 |
| 状态视图：turns / partial turns / tokens / cache read / tools / TTFT / lineage | 已对齐 | 读引擎 `usage`；`status.rs:UsageSummary` 缺字段按 0/空处理 |
| 账户切换：列出 `model_catalog` 中带 `credential_id` 的账户，Enter 发 `select_account` | 已对齐 | `ctrl+o`；同一会话内即时更新标题栏与侧栏的账户钉住状态，下一次快照再校准 |
| 调试视图：引擎二进制、数据库、模型、workspace、状态目录、主题、版本 | 已对齐 | `<leader>d`；数据库路径从启动参数读回，不维护第二份 |
| stash：`<leader>P` 存当前草稿并清空输入框；`<leader>p` 列表取回（取回后移除）或 `d` 删除 | 已对齐 | TUI 本地 `stash.json`，最多 50 条、去重置顶；不触碰会话数据 |
| MCP 列表 | 有意偏离（Phase 4 宿主移植） | 数据来自插件宿主/HTTP API，纯引擎客户端拿不到（计划 §7） |
| skills 列表 | 有意偏离（Phase 4 宿主移植） | 同上 |
| workspace 列表/切换 | 有意偏离（Phase 4 宿主移植） | 同上 |
| provider integrations | 有意偏离（Phase 4 宿主移植） | 同上 |

## T8 命令面

| 行为 | 状态 | 备注 |
|---|---|---|
| 命令 palette：`ctrl+p` 打开，输入过滤，Enter 执行动作 | 已对齐 | TS palette 只列关键动作、不列模板命令；本片同口径，`commands.rs:Builtin` + `dialogs.rs:PaletteDialog` |
| leader/快捷键动作与 palette 共用一套实现 | 已对齐 | `app.rs:run_builtin`；palette 的 id 就是动作名 |
| slash 补全只在首词、输入空格后收起 | 已对齐 | `editor.rs:completion_query`；接受后插入 `/name ` |
| slash 提交：命中命令则渲染模板并捕获 command 引用，否则按普通 prompt 发送 | 已对齐 | `app.rs:submit`、`commands::split`；首行取词规则同 TS prompt |
| 模板发现：全局目录、`MIAO_CONFIG`、项目配置文档、`.miao`/`.opencode`、`MIAO_CONFIG_DIR`、`MIAO_CONFIG_CONTENT`，低→高覆盖 | 已对齐 | `commands::templates`；顺序对齐 `Config.entries()` |
| markdown 命令：`{command,commands}/**/*.md`，名字去 `.md` 保留嵌套路径，frontmatter 读 `description` | 已对齐 | `commands::load_directory` / `parse_markdown` |
| 模板渲染：`$1…$n`（最高位捕获其余）、`$ARGUMENTS`、无占位符追加原始参数、`trim` | 已对齐 | `commands::render_template`；分词含引号与 `[Image N]` |
| `/help`：列出内置动作、键位、发现的模板命令 | TUI 自有能力 | TS 无对应 slash；便于纯引擎客户端发现命令 |
| `/init`、`/review` | 有意偏离（Phase 4 宿主移植） | 插件宿主注入，纯引擎客户端拿不到 |
| 模板的 `agent`/`model`/`variant`/`subtask` 执行默认值 | 有意偏离（Phase 4 宿主移植） | 引擎要求 agent 带捕获 manifest；本片只发 `{name, arguments}` |
| MCP 命令（`:mcp`）与 skills 来源 | 有意偏离（Phase 4 宿主移植） | 数据来自宿主服务 |

## T9 渲染对齐

| 行为 | 状态 | 备注 |
|---|---|---|
| assistant 文本按 markdown 渲染：标题、强调、行内代码、围栏、列表、引用、分隔线、表格 | 已对齐 | `markdown.rs`；围栏内不做行内解析，未闭合围栏保留正文 |
| 语法高亮（代码块与 diff 的 tree-sitter 着色） | 有意偏离（依赖） | Rust 侧按主题色区分 `+`/`-`/`@@` 与代码块底纹，不引入 tree-sitter |
| 引擎工具名投影为产品词汇（`read_file`→`read` 等） | 已对齐 | `tool::product_name`；子集同 `bridge.ts:TOOL_IDS` |
| 引擎输入字段投影（`path`→`filePath`、`text`→`content`、argv→command、task 描述） | 已对齐 | `tool::product_input` |
| shell 结果投影：stdout+stderr+`[exit code N]`/超时/信号/未执行，拒绝原因只显示错误文本 | 已对齐 | `tool::shell_text`；ANSI 序列先剥离 |
| bash 行：命令首行 + 输出前 6 行折叠 | 已对齐 | TS 折叠态同 6 行 |
| read 行：路径 + `Read N lines`/`Read image`/`Read N entries`（truncated 注明） | 已对齐 | 读引擎结果里的 `text`/`entries` |
| glob/grep 行：pattern（含 path）+ 匹配数 | 已对齐 | 匹配数来自结果 `matches` |
| write/edit/apply_patch：文件摘要 + 每个文件的 `◆ action +N −M` 与 12 行 diff | 已对齐 | diff 来自已提交的 `tool.completed.display`；跳过 `Index:`/`---`/`+++` 头 |
| todowrite：`[✓] id: content ← deps`，in_progress warning、其余 muted | 已对齐 | todo 取自输入的 `todos`；结果 `{value:{todos}}` 兜底 |
| question：每个问题 + 答案（无答案 `(no answer)`） | 已对齐 | 答案来自结果 `answers` |
| webfetch/websearch/skill：单行，不显示正文 | 已对齐 | 与 TS 折叠态一致 |
| task：描述 + 结果摘要 | 有意偏离（后续切片） | 内联子会话 transcript 需要订阅子 Session 的 wire，不在本片 |
| 工具行展开/折叠（TS 的 click to view） | 有意偏离（交互面） | transcript 当前是只读阅读面；预览行数按折叠态 |
| transcript 中持久化消息以外的事件类型 | 已对齐 | 仍只由 snapshot 投影消息；`tool.completed` 只补 display diff |

## T10 集成面

| 行为 | 状态 | 备注 |
|---|---|---|
| `tui.json` 的 `attention` 段：全局目录 → `MIAO_TUI_CONFIG` → 项目祖先链，就近覆盖，JSONC | 已对齐 | `config.rs:files/merge`；默认值同 `packages/miao/src/config/tui.ts` |
| 未知键、非法值只告警，坏文件整份跳过 | 已对齐 | `config.rs`；告警在进 raw mode 前写到 stderr |
| 通知门控：`enabled=false` 默认、焦点未知/聚焦时不发通知、声音不受焦点影响 | 已对齐 | `platform/attention.rs`；对齐 `attention.ts` 的 `focus_unknown` 与 `when:"always"` 声音 |
| OSC 9（iTerm/WezTerm/Windows Terminal）与 OSC 777，tmux passthrough；80/240 字符截断、剥 ANSI | 已对齐 | `attention::sequence` / `normalize` |
| 触发点：`approval.requested`、`question.requested`、`run.finished(failed|completed)`，同一 request 只发一次 | 已对齐 | `engine::attention_event` + `App::announce`；只针对当前打开 Session |
| `run.finished(reason=interrupted)` 不通知 | 有意偏离 | TS 的 abort 会走 `session.error` 发「Session aborted」；Rust 侧静默，避免用户自己按 Esc 后的噪音 |
| 内置音包（`miao.default` 的 6 个 mp3） | 有意偏离（资源） | 不随二进制打包；配置了 `sounds.<name>` 就播放文件，否则终端铃 |
| 插件音包注册（`registerPack` / `activate`） | 有意偏离（Phase 4 宿主移植） | 属插件宿主能力 |
| 剪贴板写入：OSC 52（tmux/ST 透传）+ pbcopy / wl-copy / xclip / xsel / PowerShell | 已对齐 | `platform/clipboard.rs:copy` |
| 剪贴板读取：`MTTY_CLIPBOARD_FILE`（10 秒、读后消费）→ 平台图片 → 平台文本 | 已对齐 | `clipboard::read`；读取在后台线程，空粘贴与 `Ctrl+V` 触发 |
| 图片附件：`[Image N] ` 标记 + `{mime,data}` 随 admit 发送，失败随文本恢复 | 已对齐 | `editor::Composer::attach_image` / `restore_with`、`engine::Handle::prompt` |
| 外编 `<leader>e`：`$VISUAL`/`$EDITOR`、临时 0600 文件、挂起/恢复终端、退出码 0 读回并删除 | 已对齐 | `platform/editor.rs`、`terminal::suspend/resume`、drive 循环 |
| Zed 选区：`ZED_TERM`/`TERM_PROGRAM=zed` 下读活动编辑器选区，UTF-8 偏移→行列，格式化前缀，同一选区只发一次 | 已对齐 | `platform/zed.rs`；用系统 `sqlite3 -readonly -json`，无 SQLite C 依赖，`sqlite3` 缺失时静默不可用 |
| 光标无选区时仍提示已打开文件 | 已对齐 | 对齐 `formatEditorContext` 的 opened-file 分支 |
| Windows 终端：VT 输出 / raw mode / 焦点事件 | 已对齐（依赖 crossterm） | 不写平台代码；Windows CI 构建与冒烟验收 |
| 鼠标框选复制 | 有意偏离（交互面） | Rust 侧 `Ctrl+Y` 复制最后一条回复；transcript 仍是只读阅读面 |
| `/remote-control` | 有意偏离（宿主未交付） | `miao-engine serve` 没有 remote 方法；由宿主 Runtime/Hub 提供，见 `specs/remote-control.md` |
