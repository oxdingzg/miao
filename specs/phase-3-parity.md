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
| `.miao/tui.json` 主题名选择 | 有意偏离（基础版） | 内置 12 个主题名的基础色板（仅 dark 模式，取自 `packages/tui/src/theme/assets/*.json` 的 dark 侧）；34 主题全集与 light 模式后续切片补 |
| `.miao/tui.json` 多文件合并（全局目录 → MIAO_TUI_CONFIG → 项目链，就近覆盖） | 有意偏离（基础版） | T1 只合并 workspace→root 的 `.miao/tui.json` 链（根优先，就近覆盖，对齐 TS 顺序语义）；全局配置目录与 `MIAO_TUI_CONFIG` 未做 |
| tui.json 为 JSONC（注释 / 尾逗号容忍） | 已对齐 | 本地剥离注释与尾逗号后 serde_json 解析（`src/theme.rs`） |
| tui.json 未知字段忽略并记录、不崩 | 已对齐 | 未知字段记 warning 到 stderr（config 加载发生在进 raw mode 之前）；损坏文件整份跳过并记录，同 TS 的 catch→log 语义 |
| 自定义主题 `themes/*.json` | 未做 | 后续切片 |
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
