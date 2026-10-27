# Phase 3 T8：命令面（palette、slash、模板命令）

状态：设计 + 实现（2026-10-27）。前置：T7（PR #1531）。

## 1. 范围

本片做：

- **命令 palette**（`ctrl+p`）：列出 TUI 自带的动作，附对应键位；输入即时过滤，
  `Enter` 执行，`Esc` 关闭。列表与 TS 的 command palette 一致：只列关键动作，
  不列模板命令（模板仍要输入参数）。
- **slash 命令**：输入框首词以 `/` 开头时提供补全；提交时命中的内置动作直接执行，
  命中的模板命令渲染后带 command 引用送入引擎，其余 `/xxx` 按普通 prompt 发送。
- **模板命令发现**：与宿主 `Config.entries()` 相同的配置来源与优先级
  （`miao.json`/`miao.jsonc`/`opencode.json`/`opencode.jsonc` 的 `commands` 映射，
  以及 `{command,commands}/**/*.md`）。
- **模板渲染**：复刻 `packages/core/src/session/command.ts:renderTemplate`。
- 台账补 T8 行。

不做（Phase 4 宿主移植）：

- `/init`、`/review`：由插件宿主 `packages/core/src/plugin/command.ts` 注入，纯引擎
  客户端看不到插件注册表。
- 模板命令的 `agent`/`model`/`variant`/`subtask` 执行默认值：引擎要求 `agent` 必须带
  捕获的 agent manifest（`session_command.rs:Reference::validate`），而这些 manifest 与
  路由目录是宿主知识。本片只发送 `{name, arguments}`，`subtask` 缺省为 false。
- MCP 命令（`:mcp` 后缀）与 skills 来源（`source: "skill"`）：同属宿主服务。

## 2. 键位与分发

| 场景 | 行为 |
|---|---|
| `ctrl+p` | 打开命令 palette（Home 与 Session 都可用） |
| palette 内 | 可打印字符过滤；`↑/↓`、`ctrl+p/ctrl+n` 移动；`Enter` 执行；`Esc` 关闭 |
| `/` 开头首词 | 打开 slash 补全；补全激活时 `↑/↓` 选择、`Tab/Enter` 接受、`Esc` 收起 |
| `Enter` 提交 | 见下 |

提交分发（`app.rs:submit`）：

1. 首行首词形如 `/name` → 内置动作（`commands::Builtin`）优先执行；
2. 否则命中发现的模板命令 → `commands::render_template` 渲染，`admit` 时带
   `command: {name, arguments}`；
3. 否则按普通 prompt 原样发送（未知 `/foo` 也走这条，与 TS prompt 一致）。

`split` 的取词规则与 `packages/tui/src/component/prompt/index.tsx` 相同：只取第一行、
以第一个空格分隔；参数 = 首行剩余部分 + （若有后续行）`"\n"` + 后续行。

## 3. 发现与优先级

按宿主 `Config.entries()` 的低→高顺序加载，同名后者覆盖前者、位置保持首次出现：

1. 全局配置目录（`$XDG_CONFIG_HOME/miao`，否则 `~/.config/miao`）的文档与
   `{command,commands}/**/*.md`；
2. `MIAO_CONFIG` 指定的文档；
3. 从 workspace 向上到项目根（最近的含 `.git` 的祖先）的直接配置文件，
   由远及近、每个目录内 `miao.json` → `miao.jsonc` → `opencode.json` → `opencode.jsonc`；
4. 同路径上的 `.opencode`、`.miao` 目录（远→近；同层 `.miao` 高于 `.opencode`）；
5. `MIAO_CONFIG_DIR` 目录；
6. `MIAO_CONFIG_CONTENT` 文档。

`MIAO_DISABLE_PROJECT_CONFIG` 跳过第 3、4 步。文档读取 `commands` 映射（兼容旧式
`command` 键），每项取 `template` 与可选 `description`。markdown 命令名 = 相对
`commands` 目录的路径去掉 `.md`（嵌套目录保留 `/`），frontmatter 只读取 `description`。

## 4. 模板渲染

- 参数分词：`[Image N]` 整体保留；`"…"` 与 `'…'` 去引号；其余以空白或引号结束。
- 位置占位符 `$1…$n`：最高位捕获其余参数；越界为空。
- `$ARGUMENTS`：原样替换为参数文本。
- 模板不含占位符且参数非空白：把原始参数作为尾段落追加（`\n\n`）。
- 结果 `trim()`。

## 5. Wire 形状

```json
{"method":"admit","params":{
  "input":{
    "session_id":"…","input_id":"…","prompt":"<rendered>","delivery":"steer",
    "command":{"name":"review","arguments":"src/a.rs"}
  },
  "resume":true
}}
```

引擎在 promotion 后写 `command.started`，再做 ``$``/`` !`cmd` ``/`@ref` 准备，最后
`command.completed` 原子替换 prepared parts。`agent_references` 仍为空数组（宿主目录
未移植）。

## 6. 渲染

- palette 沿用 T6 的居中覆盖层：首行 `› ` 过滤输入，其余为动作行（`label` + 键位），
  无匹配显示 `no matching command`。
- slash 补全复用输入框下方补全区：显示 `name`，接受后插入 `/name `。
- `/help` 打开只读列表：每个内置动作（`/name · 说明 · 键位`）、一行通用键位、
  以及每个发现的模板命令（`/name · description`）。

## 7. 验证

- 单测：占位符（最高位捕获、越界、`$ARGUMENTS`、无占位符追加）、引号/`[Image N]`
  分词、`split` 首行取词、JSONC 文档与 markdown 覆盖顺序、palette 过滤与回退、
  slash 补全只在首词生效、内置 slash 执行动作、`/help` 列出模板。
- pty 冒烟：`ctrl+p` 过滤到 help 并打开；工作区 `.miao/commands/review.md`
  的 `/review src/a.rs` 以渲染后的 prompt 和 `{name, arguments}` 到达假引擎。
