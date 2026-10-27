# Phase 3 T6：第一批对话框

状态：设计 + 实现（2026-10-27）。前置：T5（PR #1529）、T4（PR #1528）。

## 1. 范围

- **leader 前缀**：`Ctrl+X`（与 TS `LeaderDefault` 一致）进入 pending 状态，下一键构成
  和弦；`Esc` 单独按下时取消前缀。T8 的命令面复用同一前缀。
- **模型列表**（`<leader>m`）：读引擎 `model_catalog`，列出 `model · protocol`
  （有 variant 时附 `· variant`）；`Enter` 发 `select_model`，`Esc` 关闭。
- **主题列表**（`<leader>t`）：内置主题（`theme::names()`），`Enter` 立即应用并写入
  `~/.local/share/miao-tui/preferences.json`（`MIAO_TUI_STATE_DIR` 可覆盖）；工作区
  `.miao/tui.json` 仍优先于保存的选择。
- **会话列表**（`<leader>l`）：全部 root 会话（含已归档），`Enter` 打开，`r` 重命名，
  `a` 归档/取消归档，`d` 删除（先确认）。重命名直接 `ctrl+r`；删除确认框默认焦点在
  “取消”，避免误删。
- 对话框是模态的：打开时按键不进入 composer；`Esc` 关闭最上层，`Ctrl+C` 仍直接退出。
- 模型对话框在手里没有目录时先发 `model_catalog`，等结果到达再打开，避免闪出一个空列表。

不做：命令面板/slash 命令（T8）、accounts/MCP/skills 对话框（T7）、stash、tag、status。

## 2. 数据与请求

- `model_catalog` 返回裸数组，元素 `{route_id?, protocol, model, variants?, model_key?,
  credential_id?}`；`select_model` 的 `binding` 为 `{protocol, model, route_id?, variant?}`。
- `rename {session_id, title}`、`archive {session_id, archived}`、`remove {session_id}`；
  删除后 `refresh_sessions`，若删的是当前会话则回 home。
- 主题保存为 `preferences.json` 的 `{"theme": "..."}`；读取失败按空处理，写入失败只在
  UI 里提示（不阻塞切换）。

## 3. 渲染

对话框为居中覆盖层：宽 = 终端的 60%（至少 40、至多 80 列），高 = 条目 + 2（至多 16），
先 `Clear` 再画边框；标题显示对话框名与键位提示，底部一行说明动作键。

## 4. 键位

| 场景 | 键 |
|---|---|
| leader | `Ctrl+X` 后接 `m`/`t`/`l`/`n`/`q` |
| 列表 | `↑/↓`、`j/k` 移动，`Enter` 确认，`Esc` 关闭 |
| 会话列表 | `r` 重命名、`a` 归档切换、`d` 删除确认 |
| 重命名 | 普通编辑键 + `Enter` 提交，`Esc` 取消 |
| 确认 | `←/→`/`Tab` 切换，`Enter` 确认，`Esc` 取消 |

`<leader>q` 退出沿用 TS；session 里 `Ctrl+D` 仍是删除后一个字符，删除会话改为
`<leader>l` 再按 `d`。

## 5. 验证

- 单测：列表移动夹取、回车返回索引、归档/删除键位、重命名输入、确认框默认取消；
  leader 前缀在 app 层只消费一次；主题切换改变 palette 并写入偏好；偏好文件损坏时回退。
- pty 冒烟：假引擎返回两个模型；`Ctrl+X m` 打开列表、`Enter` 后动作日志出现
  `select_model` 与所选 `model`。`Ctrl+X t` 打开主题列表。
