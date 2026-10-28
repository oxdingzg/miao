# Phase 3 T9：渲染对齐（markdown、工具结果）

状态：设计 + 实现（2026-10-27）。前置：T8（PR #1532）。

## 1. 范围

本片把 transcript 从「纯文本 + 统一工具行」提升到与 TS TUI 同级的阅读面：

- **markdown 渲染**：assistant 文本按 markdown 渲染（标题、强调、行内代码、围栏代码、
  列表、引用、分隔线、表格），样式取自当前主题。
- **引擎结果投影**：复刻宿主 `packages/miao/src/engine/bridge.ts` 的渲染相关翻译
  （工具名映射、输入字段、shell/todo 结果文本），TUI 直接读引擎 wire，没有那层 TS
  翻译，所以必须在这里补上；否则工具行显示的是引擎结果的原始 JSON。
- **专用工具渲染**：bash（命令 + 输出）、read/list（行数/条目摘要）、glob/grep
  （匹配数）、write/edit/apply_patch（文件 diff）、todowrite（todo 块）、question
  （问答块）、webfetch/websearch/skill（单行）。
- 台账补 T9 行。

不做（Phase 4 / T10）：

- ts/js 语法高亮与 diff 语法高亮：TS 使用 tree-sitter；Rust TUI 用主题色区分
  `+`/`-`/`@@` 与代码块底纹，不做逐 token 高亮。
- 工具行展开/折叠的鼠标交互（TS 的 click to view）：当前 transcript 是只读阅读面，
  预览行数按 TS 折叠态选取。
- 子代理内联 transcript（TS 的 Task 展开）：需要订阅子 Session 的 wire 事件，
  属 T10 的会话接入面；task 行显示描述与结果摘要。

## 2. Markdown

`crates/miao-tui/src/markdown.rs`，输入 markdown 文本，输出 `Vec<Line<'static>>`。

块级：

| 语法 | 渲染 |
|---|---|
| `#`..`######` | 加粗；一级 primary、二级 secondary、三级及以下 accent |
| ``` / ~~~ 围栏 | 头部 `╭ lang`、逐行 `│ `（surface 底）、尾部 `╰`，围栏内不做行内解析 |
| `-`/`*`/`+` | `• `（primary）+ 行内样式，保留缩进 |
| `1.`/`1)` | 原编号（primary）+ 行内样式 |
| `> ` | `│ ` + 行内（text_muted） |
| `---`/`***`/`___` | 一条 `─` 分隔线（border） |
| `\| a \| b \|` + 分隔行 | 按列宽对齐的表格；表头 secondary 加粗，分隔行 border，单元格按列宽补空格 |
| 空行 | 空行 |
| 其他 | 一行行内渲染（不合并段落，保留 CJK/硬换行语义） |

行内：`**bold**`/`__bold__`、`*italic*`/`_italic_`、`` `code` ``（accent + surface 底）、
`~~strike~~`、`[label](url)`（label accent + 下划线，省略 url）、反斜杠转义。
`_` 只在词边界生效，避免破坏 `snake_case`。

## 3. 引擎结果投影

引擎 `tool_result.content` 是 `serde_json::to_string(result)`（`crates/miao-engine/src/store.rs:2131`），
而 TS 侧由 `bridge.ts` 翻译成产品词汇。Rust TUI 在渲染时做同一层投影：

工具名（`product_name`，取自 bridge `TOOL_IDS` 的渲染子集）：

```
read_file/read_image/list_files → read   write_file → write   edit_file → edit
run_command/bash/start_job → bash        job_status/job_list → job_list
schedule_wakeup/cancel_wakeup/cron_* → schedule   lsp_* → lsp
其余（含 mcp_*、未知工具）保留原名
```

输入：`read`/`write`/`edit` 的 `path` 补成 `filePath`；`write_file.text` 补成 `content`；
`run_command`/`bash` 的 argv 拼成带引号的 command；`task.agent` 补成 `subagent_type`，
`description` 取 prompt 首行。

结果：

- `bash`/`run_command`：`stdout` + `stderr` + 结尾标记（`[exit code N]`、`[command timed out]`、
  `[killed by signal N]`、`[command not executed]`）；`{error}` 结果只显示错误文本。
- `todowrite`：`{kind, revision, value}` 取 `value.todos`（缺失时回落到输入的 `todos`）。
- 其他工具：优先使用结果里的可读字段（read 的 `text`/`entries`、glob/grep 的 `matches`
  用于计数）；无可用字段时显示原始文本。

## 4. 专用渲染

| 工具 | 行 |
|---|---|
| bash | `✓ bash  <command 首行>`；输出前 6 行（剥 ANSI），超出 `… N more lines`；失败输出 error 色 |
| read | `✓ read  <filePath>` + `⎿ Read N lines` / `Read image` / `Read N entries`（truncated 注明） |
| glob/grep | `✓ glob  <pattern>` + `⎿ N matches`（truncated 注明） |
| write/edit/apply_patch | `✓ Edit/Write/Patch <path>` + `⎿ Added N lines, removed M lines`；每个 display 文件 `◆ action path +N −M` 与 12 行 diff（`+` success、`-` error、`@@` accent） |
| todowrite | todo 块：`[✓] id: content ← deps`；in_progress warning、completed/cancelled muted |
| question | 每个问题一行提示（muted）+ 一行答案（逗号分隔；无答案 `(no answer)`） |
| webfetch/websearch/skill | 单行，不显示正文 |
| task | 描述 + 结果首行摘要（内联子会话不做） |
| 其他 | 现有通用行：输入摘要 + 输出前 8 行 |

状态符号与现有口径一致：`✓` 完成、`✗` 失败、`·` 进行中。

## 5. 验证

- 单测：markdown 标题/强调/行内代码/围栏/列表/引用/表格/链接；工具名映射；
  shell 结果投影（stdout+stderr+exit/timeout/error）；todo 解析与渲染；read 摘要；
  file diff 渲染与预览上限。
- pty 冒烟：沿用 T4/T5 的假引擎 transcript fixture，断言 markdown 与工具行出现在屏幕上。
- `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`（xx02）。
