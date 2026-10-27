# Phase 3 T7：状态、账户、调试与 stash

状态：设计 + 实现（2026-10-27）。前置：T6（PR #1530）。

## 1. 范围

T7 原计划是「workspace、accounts、MCP、skills、debug/status/tag/stash」。其中
workspace / MCP / skills / provider integrations 的数据在 TS 里来自宿主 HTTP API 与插件宿主
（`sdk.api.integrations`、`sdk.api.files`、插件注册表）。Phase 3 明确不移植插件宿主
（`phase-3-ratatui-tui.md` §7），纯引擎客户端拿不到这些事实，因此本片只实现引擎能回答的
部分，并把宿主侧对话框在台账里记为「有意偏离（Phase 4 宿主移植）」。

本片做：

- **状态对话框**（`<leader>s`）：当前会话身份、模型绑定、run 状态、队列数，以及引擎
  `usage` 报告的 turns/tokens/tools/TTFT/lineage。
- **账户对话框**（`ctrl+o`）：从 `model_catalog` 的 `credential_id` 汇总可切换账户，
  `Enter` 发 `select_account`。
- **调试对话框**（`<leader>d`，TS 默认无键位）：引擎二进制、数据库、workspace、状态目录、
  主题、版本。
- **stash**（`<leader>p`，TS 默认无键位）：把当前草稿存进 `stash.json`，列表里 Enter 取回
  （取回并从 stash 移除）、`d` 删除；`<leader>P` 直接存当前草稿并清空输入框。
- 台账补 T7 行；宿主侧对话框逐条记为有意偏离。

不做（Phase 4 宿主移植）：MCP 列表、skills 列表、workspace 列表/切换、provider
integrations、LSP/formatter/plugin 状态。

## 2. 数据与请求

- `usage {session_id}` → `{providerUsage, tokens:{input,output,cacheRead,cacheWrite,nonCached},
  turns, partialTurns, tools:{calls,failures}, ttftMs:{count,avg,min,max}|null, lineage:[
  {protocol,model,turns}]}`。缺字段按 0/空处理。
- `model_catalog` 元素 `{route_id?, protocol, model, variants?, model_key?, credential_id?}`；
  账户列表取有 `credential_id` 的条目，按 `credential_id` 去重，标签显示
  `credential_id · model_key|model`。
- `select_account {session_id, credential_id}`；`credential_id: null` 恢复默认账户。
- `state {session_id}` → `{todos, goal}` 不在本片读取：TS 的状态视图同样不显示 todo/goal，
  本片只呈现 snapshot 已经给出的事实，避免多一次请求和一个未验证的投影。
- stash 是 TUI 本地文件：`state::file("stash.json")`，内容
  `[{"text": "...", "saved_at_ms": 0}]`，最多 50 条，新的在前。

## 3. 键位

| 场景 | 键 |
|---|---|
| 状态 | `<leader>s` |
| 账户 | `ctrl+o` |
| 调试 | `<leader>d` |
| stash | `<leader>p` 列表、`<leader>P` 存档、列表内 `d` 删除 |
| 标题栏 | 会话标题右侧仍显示 run 状态 |

## 4. 渲染

沿用 T6 的居中覆盖层。状态与调试是多段只读文本，复用列表对话框的行结构：每行
`label` + `detail`，不可选中时 `Enter` 关闭。账户与 stash 是可选择列表。

## 5. 验证

- 单测：usage 投影（缺字段、TTFT null）、catalog 账户去重、stash 存取/上限/损坏文件回退、
  `ctrl+o` 打开账户对话框、`<leader>s` 打开状态对话框。
- pty 冒烟：假引擎返回 usage 与两个 credential 条目；`<leader>s` 显示 turns/tokens；
  `ctrl+o` 选第二个账户后日志出现 `select_account` 与对应 `credential_id`。
