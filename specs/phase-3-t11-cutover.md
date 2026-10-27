# Phase 3 T11：剪彩（Rust TUI 成为默认入口）

状态：设计。前置：T1–T10 合入 main；`specs/phase-3-ratatui-tui.md` §4 T11。

## 1. 目标与拆分

剪彩要同时满足三件事：Rust TUI 能随 release 安装、`miao` 能启动它、回滚开关可用。
把这三件事拆成三个 PR，任何一个都能单独回滚：

| PR | 内容 | 默认行为 |
|---|---|---|
| T11a 发行与启动 | release 打包 `miao-tui`；install 安装；CLI `--tui rust` 显式选择 | 仍是 TS TUI |
| T11b parity 收口 | 自定义主题、keybinds、鼠标、光标样式 | 不变 |
| T11c 默认切换 | `miao` 默认 rust；`--tui legacy` / `MIAO_TUI=legacy` 回退 | Rust TUI |

`packages/tui` 的删除属 Phase 4，不在本片。

## 2. 打包与安装（T11a）

- `packages/miao/script/build.ts` 在 `buildEngineArchive` 旁新增
  `buildTuiArchive()`，与 engine 共用 target 选择（darwin 两架构、Linux musl、
  Windows 宿主）与签名/公证路径：
  - `cargo build --locked --release --bin miao-tui`
  - macOS：与 engine 相同的 Developer ID 签名；归档走 `zip`，进 notarytool。
  - Linux：`tar.gz`；Windows：`zip`。
  - 资产名 `miao-tui-<os>-<arch>.zip|tar.gz`，附 `.sha256`。归档内含二进制与
    `LICENSE`、`LICENSE-APACHE-2.0`、`NOTICE`。
  - 构建时注入 `MIAO_VERSION=<产品版本>`，`miao-tui --version` 输出
    `miao-tui <版本>`；install 冒烟调用它。
- `install` 新增 `install_tui()`：下载同名归档，装到 `~/.miao/bin/miao-tui(.exe)`；
  `--tui-binary <path>` 安装本地二进制，`--no-tui` 跳过。缺少归档时静默跳过
  （旧 release 仍可安装 CLI 与 engine）。
- `miao-tui` 的引擎发现顺序保持现状（`MIAO_ENGINE_BIN` → `~/.miao/bin` →
  `~/.local/share/miao-engine/bin` → `~/.local/bin` → PATH）。

## 3. 启动（T11a）

### 3.1 CLI 开关

`packages/miao/src/cli/cmd/tui.ts` 新增：

- `--tui <rust|legacy>`：显式选择实现。
- 环境变量 `MIAO_TUI=rust|legacy`（无同名冲突）。
- 优先级 `--tui` > `MIAO_TUI` > 默认。T11a 默认 `legacy`，T11c 改为 `rust`。

选择 `rust` 时不启动 RuntimeHost/Server：解析 project 目录、`chdir`、
计算 `DatabaseFile.path()`，然后 spawn `miao-tui`，`stdio: inherit`，退出码原样透传。
找不到 `miao-tui` 时报错并提示安装路径与 `--tui legacy`，不静默回退。

### 3.2 传参与环境

| CLI 选项 | 传给 miao-tui |
|---|---|
| `[project]` / cwd | `--workspace <resolved cwd>` |
| `--model` | `--model <provider/model>` |
| `--session` | `--session <id>` |
| `--continue` | `--continue` |
| `--prompt`（含 stdin 管道） | `--prompt <text>` |
| — | `--db <DatabaseFile.path()>` |
| — | `--config-dir <Global.Path.config>` |

CLI 同时在子进程环境里设置 `MIAO_TOOL_BIN=<Global.Path.bin>`，并继承
`MIAO_ENGINE_*`，与 TS host 启动引擎时的环境一致。

明确的不可用选项（在 rust 模式下报错，提示 `--tui legacy`）：`--mini`、
`--fork`、`--agent`、`--auto`/`--yolo`/`--dangerously-skip-permissions`、
`--replay`/`--no-replay`/`--replay-limit`/`--demo`、network 选项
（`--port`/`--hostname`/`--mdns`/`--cors`）。这些是另一个界面（mini）、
引擎协议没有对应字段（agent）或依赖 TS host 的服务器与插件面（remote/network）。
`--fork` 依赖 TS 侧投影，Rust 不复制该语义。

### 3.3 Rust 侧引擎设置

`crates/miao-tui/src/engine.rs` 的 `settings` 补齐 TS `nativeEngineOptions`
的 argv 映射，全部来自环境变量，缺省不出现：

`--config-dir`（新 `--config-dir` 参数，回退 `MIAO_CONFIG_DIR`/XDG/HOME）、
`--provider`、`--endpoint`、`--auth-file`、`--policy`、`--credential-db`
（仅当 `MIAO_ENGINE_CREDENTIAL_DB` 存在时传，与 TS host 一致；不隐式指向产品数据库）、
`--credential-id`、`--credential-integration`、`--context-config`、
`--model-routes-config`、`--mcp-config`、`--lsp-config`、`--skills-config`、
`--references-config`、`--hooks-config`、`--formatter-config`、`--fallback-model`、
`--tool-disclosure`、`--prompt-cache`、`--verify-command`、`--context-limits`、
`--roles`。`MIAO_ENGINE_*` 与 `MIAO_CONTEXT_LIMITS` 的名字与 TS 相同。

`--db` 不再要求文件已存在：首次运行由 engine 创建数据库。

### 3.4 启动后会话与 prompt

`app` 增加启动意图：

- `--session <id>`：attach 后立即 `open(id)`。
- `--continue`：请求 catalog，收到第一份 catalog 后打开最新的非归档 root 会话；
  若用户已经打开了别的会话，放弃该意图。
- `--prompt <text>`：会话打开后按普通提交路径发送（含斜杠命令与模板）；
  未指定会话时先新建会话再发送，与 TS 在 home 上提交的语义一致。
- 三个意图都失败时在状态栏说明原因，不退出。

## 4. parity 收口（T11b）

台账里剩下的四项从「未做」变为「已对齐」：

| 项 | 实现 |
|---|---|
| 配置链 | 主题加载复用 `config::files()`（全局 → `MIAO_TUI_CONFIG` → 项目祖先，根在前） |
| 自定义主题 | 读取主题文件：`<config>/themes/*.json` 与项目 `.miao/themes/*.json`，同名覆盖内置主题；解析失败的条目告警并跳过 |
| keybinds 自定义覆盖 | 读取 `tui.json` 的 `keybinds`，支持 `keybind::Definitions` 中 Rust 侧已实现的动作名；未知键告警；未覆盖的动作保持默认 |
| 鼠标捕获 | 默认开启，滚轮滚动 transcript/home 列表，点击聚焦输入框；`mouse: false` 关闭 |
| 光标样式 | `tui.json` 的 `cursor`（style/blinking）映射到 crossterm `SetCursorStyle` |

`keybinds` 只接受 Rust TUI 实际存在的动作名（见 `specs/phase-3-parity.md`
「键位」一节），其余名称忽略并告警——不做「接受了却不生效」的静默误配。

## 5. 默认切换（T11c）

- `--tui` 默认值改为 `rust`；`MIAO_TUI=legacy` 或 `--tui legacy` 回退 TS TUI。
- 回滚开关与切换在同一个 PR；切换后补 release notes 说明回退方式。
- 默认切换前确认 `specs/phase-3-parity.md` 无「未做」。
- Windows 默认值在 Windows 冒烟（`96`）通过前保持 `legacy`？不——CI 的
  `tui` 任务只在 macos/ubuntu 跑；Windows 以安装脚本冒烟为准，若未通过则
  在切换 PR 里用 `cfg` 无关的运行时判断（`MIAO_TUI` 显式值优先），并在
  release notes 标注 Windows 仍回退 legacy。

## 6. 不做什么

- 不删除 `packages/tui`（Phase 4）。
- 不实现 Rust 侧的 feature-plugin 宿主。
- 不支持 remote/`--port` 服务器模式；这些路径继续需要 TS TUI。
- 不改引擎 wire 协议。

## 7. 验证

- Rust：`cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test`
  （xx02）。
- TS：`bun typecheck` 与 `bun test test/cli`（在 `packages/miao`）。
- 端到端：`MIAO_TUI=rust miao-dev --db <tmp> --prompt "hi"` 起 Rust TUI、
  引擎被拉起、会话可创建；`--tui legacy` 仍起 TS TUI。
- release：在 `--single` 构建里确认 `miao-tui` 归档被上传并通过 `--version` 冒烟。
