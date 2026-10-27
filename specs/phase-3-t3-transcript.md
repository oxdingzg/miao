# Phase 3 T3：只读会话视图

状态：设计 + 实现（2026-10-27）。前置：T1 骨架（#1503）、T2 传输层（#1520）已合入 main。
范围与验收见 `specs/phase-3-ratatui-tui.md` §4 的 T3 行。

## 1. 范围

T3 让 `miao-tui` 从占位界面变成能看真实数据的只读客户端：

- **home**：会话列表（只列根会话，按 `updated_at` 倒序），每行显示标题、目录名、相对时间、
  当前会话的执行状态点；`Enter` 进入、`j/k`/方向键移动。
- **transcript**：用户消息、助手文本、思考块（默认折叠成一行）、工具调用与状态、工具 diff、
  错误块；长会话按可视行窗口渲染，不一次性生成整屏。
- **订阅**：选中会话后 `subscribe(after=0)` 补齐历史事件，再持续接收已提交事件，重建视图。

不做（归后续切片）：输入编辑器（T4）、流式 delta 渲染与打断（T5）、对话框（T6/T7）、
命令面（T8）、markdown 与逐工具专用渲染的完整对齐（T9）。

## 2. 数据来源

引擎是唯一状态属主，T3 不建第二份会话状态，只做投影：

| 数据 | 来源 | 备注 |
|---|---|---|
| 会话 id 列表 | `sessions` | 引擎只返回 id，`ORDER BY id` |
| 列表元数据 | `snapshot{session_id, metadata_only:true}` | title/updated/archived/parent/location；逐会话一次 |
| 会话内容 | `snapshot{session_id}` | `messages[]`：`{seq, role, content, checkpoint, recorded_at_ms, identity?}` |
| 已提交增量 | `subscribe{session_id, after}` | `message.committed`、`tool.completed`、`run.*` |
| 工具 diff | `tool.completed.data.display` | `{files:[{path, action, patch, additions, deletions}]}` |

`history` 不带 `seq` 与 `identity`，T3 不用它；`snapshot` 是权威视图。

## 3. 模型

`src/session.rs`：

- `SessionSummary { id, title, parent_id, updated_at_ms, archived_at_ms, directory }`，
  由 `metadata_only` snapshot 投影；`summary_rows` 过滤 `parent_id`/`archived` 并倒序。
- `Transcript`：`Vec<Entry>`，条目为 `User`、`Assistant { agent, model, parts }`、`Compaction`。
  assistant 的 `content` 投影成 `Part::{Text, Reasoning, Tool}`；`tool_use` 与后续 user 消息里的
  `tool_result{tool_use_id}` 按 id 合并成 `ToolPart { name, input, status, output, display }`。
- `Displays`：从 `tool.completed` 事件收集的 diff 展示数据，按 `call_id` 索引；渲染时并入工具条目。

模型只依赖 `serde_json::Value`，不反序列化整个引擎协议，未知字段一律忽略——协议只追加字段时
T3 不需要跟随修改。

## 4. 引擎进程

沿用产品侧的约定（`packages/miao/src/engine/{discovery,client}.ts`）：

- 二进制定位：`MIAO_ENGINE_BIN` > `~/.miao/bin/miao-engine` > `~/.local/share/miao-engine/bin/miao-engine`
  > `~/.local/bin/miao-engine` > `PATH`。
- 存储：`--db` 参数 > `MIAO_ENGINE_DB`；两者都没有时报错退出，不做隐式推断
  （产品库的 location 哈希属于宿主，T3 不复制这段规则）。
- argv：`serve --db <db> --workspace <dir> --model <model>`；`--model` > `MIAO_TUI_MODEL`，
  缺省 `unavailable/model`——T3 不执行 provider turn，模型只影响之后的准入。

## 5. 键位（T3 临时版，T4 起并入 keybind 配置）

| 键 | 行为 |
|---|---|
| `j` / `↓`，`k` / `↑` | 列表或 transcript 移动 |
| `Enter` | 从 home 进入选中会话 |
| `Esc` | 从会话返回 home |
| `r` | 重新读取 snapshot |
| `q` / `Ctrl+C`（输入为空） | 退出 |

`q` 在 home 直接退出；进入会话后 `q` 保留为退出，T4 把输入与全局键位分开后再改 leader chord。

## 6. 验证

- 单元测试：`metadata_only` snapshot → 列表行（过滤/排序）；固定 snapshot → transcript 条目
  （用户、助手文本、思考、工具与结果合并、失败工具）；`tool.completed` → 工具 diff。
- pty 冒烟：home 渲染出两条会话标题；进入会话后 transcript 渲染出固定文本。
- 三平台构建由 `tui` workflow 覆盖（T1 已有）。
