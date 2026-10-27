# Phase 3 T4：输入编辑器与准入

状态：设计 + 实现（2026-10-27）。前置：T3（PR #1527）。
范围与验收见 `specs/phase-3-ratatui-tui.md` §4 的 T4 行。

## 1. 范围

T4 让 composer 成为真正的输入面，并把提交送进引擎：

- 多行编辑：插入/删除、按字符与按词移动、行首行尾、跨行上下移动，光标随 CJK 宽字符
  正确推进（`unicode-width` 计算显示列，不用字节数）。
- 键位：`Enter` 提交；`Shift/Alt/Ctrl+Enter`、`Ctrl+J` 换行；方向键与 `Ctrl+B/F` 移动；
  `Ctrl+A/E` 行首尾；`Alt+B/F` 按词移动；`Ctrl+W` 删前一词；`Ctrl+U/K` 删到行首/行尾；
  `Ctrl+C` 清空（非空时）或退出（空时）。
- 粘贴：启用 bracketed paste，多行粘贴统一成 `\n`（ConPTY 的 CR 也归一）；长粘贴先
  原样内联，T9 再补 `[Pasted ~N lines]` 摘要。
- 历史：提交过的 prompt 进历史，单行输入按 `↑/↓` 翻，多行时先跨行移动；历史持久化到
  `~/.local/share/miao-tui/composer.json`（上限 100 条），与 TS 的 kv 分开存储。
- `@` 文件补全：光标前的 token 以 `@` 开头时，扫描 workspace（跳过 `.git`、`node_modules`、
  `target`、`.worktrees`，上限 2000 条），按路径子串匹配出候选；`Tab`/`Enter` 接受，
  `Esc` 关闭。
- 提交走引擎 `admit`：`{session_id, input_id, prompt, delivery:"steer"}`，`resume:true`，
  attachments 为空——与 TS 产品路径一致（TUI 只发 steer；queue 属于定时/工具路径）。
  提交后清空 composer 并记历史；消息出现在下一次 snapshot 投影里。
- home 增加 `n`：生成 Session ID 并 `initialize`，随后直接打开新 Session，否则全新安装
  没有任何会话可进。`<leader>n` 等 leader 键位留在 T8。

不做（归后续切片）：流式增量与打断（T5）、审批与问题（T5）、命令面（T8）、
`@agent` 引用（需要宿主侧 agent 目录；引擎目前没有 agent catalog 方法）、外部编辑器、
附件粘贴（图片/文件，T9/T10）。

## 2. 模型

`src/editor.rs`：

- `Editor { buffer: String, cursor: usize, history: History, pending: Option<Pending> }`。
  `cursor` 是字节偏移但始终落在 char 边界；所有移动以 `char_indices` 迭代。
- 显示列用 `unicode-width`：`line_of(cursor)`、`column_cells(cursor)` 供渲染与上下移动使用，
  上下移动保持"目标列"而不是目标字节。
- `Pending`：一次粘贴/补全插入的 undo 单元（`Ctrl+Z` 撤销这一段）；只保留一个。
- `History`：`{ entries: Vec<String>, index: Option<usize>, draft: String }`；翻历史时保存
  当前草稿，回到最新一条后恢复草稿。持久化文件与状态目录同 `composer.json`。
- 纯函数（可单测）：`normalize_paste`、`word_boundary_before/after`、`line_bounds`、
  `Completion::filter`。

## 3. 渲染

- Composer 高度随行数增长（2–10 行，含边框），超过后垂直滚动，光标行始终可见；
  水平方向按显示列滚动，保证宽字符下的光标不被截断。光标用 `frame.set_cursor_position`
  放在真实位置，IME 候选窗因此贴着文本出现。
- 补全弹层画在 composer 上方，最多 8 条，显示路径尾段与匹配高亮（前缀匹配即可）。

## 4. 提交

`engine::Handle` 新增：

- `Prompt { session_id, text }`：`admit`（`resume:true`、`delivery:"steer"`、附件空）。
  失败时把错误发回 UI 作为通知，草稿不清空已经由 UI 先清空——失败时用 `AppEvent::PromptFailed`
  把文本交还 composer。
- `NewSession`：`ses_<hex>`（时间 + 进程 + 计数）→ `initialize{session_id, title:"New session"}` →
  `Open`。复用 ID 的冲突由引擎拒绝并作为通知显示。

## 5. 验证

- 单测：编辑操作、CJK 显示列与上下移动、粘贴归一、词边界、历史往返、补全过滤。
- pty 冒烟：假引擎记录 `admit` 帧到 `MIAO_TUI_FAKE_ADMIT_LOG`；输入多行文本（含 CJK）后
  提交，断言记录里的 `prompt` 逐字节等于输入、`delivery` 为 `steer`。
- 三平台构建由 `tui` workflow 覆盖；Windows 的 CR-only 粘贴路径在 `96` 冒烟（本切片先由
  `normalize_paste` 单测覆盖）。
